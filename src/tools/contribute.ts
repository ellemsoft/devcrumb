import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { embed } from "../lib/embed";
import { screenSummary } from "../lib/screen";
import { getDb, textResponse, type SimilarEntry } from "../lib/db";
import type { RateLimiter } from "../lib/rate-limit";

const PG_UNIQUE_VIOLATION = "23505";

export const LIMITS = {
	summary_min_length: 50,
	summary_max_length: 800,
	error_msg_max_length: 500,
	// 0.85 based on real data: true duplicates score 0.95+, same-framework-different-problem
	// scores 0.60-0.80, unrelated entries score <0.55. At 0.85, only near-duplicates are blocked.
	similarity_threshold: 0.85,
	min_trust_to_surface: 1,
	min_relevance_score: 0.3,
	match_count: 3,
	new_account_initial_trust: 1,
	new_account_days: 0,
	contributions_per_day: 100,
	confirmations_per_day: 100,
};

function validateSummary(summary: string): string | null {
	if (summary.length < LIMITS.summary_min_length) {
		return `Summary too short (${summary.length} chars, min ${LIMITS.summary_min_length}).`;
	}
	if (summary.length > LIMITS.summary_max_length) {
		return `Summary too long (${summary.length} chars, max ${LIMITS.summary_max_length}).`;
	}
	if (summary.includes("```")) return "No code blocks — plain language only.";
	if (/https?:\/\//.test(summary)) return "No URLs in summaries.";
	if (/[/\\][\w]+[/\\]/.test(summary)) return "No file paths in summaries.";
	if (/[A-Za-z0-9+/=]{40,}/.test(summary)) return "Summary appears to contain an API key or token.";
	if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(summary)) return "No IP addresses in summaries.";
	if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(summary)) return "No email addresses in summaries.";
	return null;
}

function getInitialTrust(model: string | undefined, isNewAccount: boolean): number {
	if (isNewAccount) return LIMITS.new_account_initial_trust;
	const tier1 = ["claude-sonnet", "claude-opus", "gpt-5", "gpt-4o", "gemini-3-pro"];
	return tier1.some((m) => model?.toLowerCase().includes(m)) ? 2 : 1;
}

const INCIDENTAL_TAGS = new Set([
	"port-3000", "port-8080", "port-5432", "port-80", "port-443",
]);

const TAG_ALIASES: Record<string, string> = {
	// Languages
	py: "python",
	python3: "python",
	js: "javascript",
	ts: "typescript",
	golang: "go",
	rb: "ruby",
	"c#": "csharp",
	rs: "rust",
	kt: "kotlin",
	bash: "shell",
	zsh: "shell",
	sh: "shell",

	// Runtimes
	node: "nodejs",
	"node.js": "nodejs",

	// Frontend
	"react.js": "react",
	reactjs: "react",
	"next.js": "nextjs",
	next: "nextjs",
	"vue.js": "vue",
	vue3: "vue",
	"nuxt.js": "nuxt",
	nuxt3: "nuxt",
	ng: "angular",
	"svelte-kit": "sveltekit",
	tailwindcss: "tailwind",
	"tailwind-css": "tailwind",
	tw: "tailwind",

	// Backend
	"express.js": "express",
	"nest.js": "nestjs",
	nest: "nestjs",
	"hono.js": "hono",
	"ruby-on-rails": "rails",
	ror: "rails",
	"spring-boot": "springboot",

	// Databases
	postgres: "postgresql",
	pg: "postgresql",
	psql: "postgresql",
	mongo: "mongodb",
	sqlite3: "sqlite",

	// Cloud & infra
	k8s: "kubernetes",
	kube: "kubernetes",
	cf: "cloudflare",
	"cf-workers": "cloudflare-workers",
	gcp: "google-cloud",
	tf: "terraform",

	// CI/CD
	"gh-actions": "github-actions",
	gha: "github-actions",

	// Tools
	"docker-compose": "docker",
	tsc: "typescript",
	gql: "graphql",
	"socket.io": "socketio",

	// AI
	chatgpt: "openai",
	gpt: "openai",

	// Auth
	"auth.js": "authjs",
	"next-auth": "authjs",
	nextauth: "authjs",
};

function normalizeTags(tags: string[]): string[] {
	return tags
		.map((t) => t.toLowerCase().trim())
		.map((t) => TAG_ALIASES[t] ?? t)
		.filter((t) => t.length > 0 && t.length <= 50 && !INCIDENTAL_TAGS.has(t))
		.filter((t, i, arr) => arr.indexOf(t) === i)
		.slice(0, 10);
}

function generateShortId(): string {
	const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
	const bytes = new Uint8Array(6);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

function formatSimilar(entries: SimilarEntry[]): string {
	return entries
		.map((e) => `[${e.short_id}] trust:${e.trust_score} sim:${e.similarity.toFixed(2)}\n${e.summary}`)
		.join("\n\n---\n\n");
}

async function checkDailyLimit(
	db: ReturnType<typeof getDb>,
	table: string,
	field: string,
	userId: number,
	limit: number,
): Promise<string | null> {
	const startOfDay = new Date();
	startOfDay.setUTCHours(0, 0, 0, 0);

	const { count } = await db
		.from(table)
		.select("id", { count: "exact", head: true })
		.eq(field, userId)
		.gte("created_at", startOfDay.toISOString());

	if ((count ?? 0) >= limit) return `Daily limit reached (${limit}/day).`;
	return null;
}

const contextSchema = z
	.object({
		framework: z.string().optional(),
		language: z.string().optional(),
		environment: z.string().optional(),
		services: z.array(z.string()).optional(),
		versions: z.record(z.string(), z.string()).optional(),
	})
	.optional()
	.describe("Project context: framework, language, runtime, services, versions");

export function registerContributeTools(
	server: McpServer,
	env: Env,
	userId: number,
	userCreatedAt: Date,
	rateLimiter: RateLimiter,
) {
	const isNewAccount = () =>
		Date.now() - userCreatedAt.getTime() < LIMITS.new_account_days * 24 * 60 * 60 * 1000;

	server.tool(
		"drop_crumb",
		`Contribute a fix or gotcha when something fails or works differently than expected and you find the fix.

Format: "[context] [problem] → [fix]". 50-800 chars, plain language only — no code, URLs, paths, or secrets. Describe the root cause, not your specific setup. Tags: 1-3 broad service names only.

Do NOT submit project-specific bugs, opinions, or anything only relevant to one codebase. Only submit if you would have gotten it wrong without discovering this — skip things you already know.

Example: { summary: "Cloudflare Workers fetch() blocks raw IPs (error 1003) → use a hostname", tags: ["cloudflare-workers"] }`,
		{
			summary: z.string().describe("What happened and what fixed it (50-800 chars, plain language)"),
			tags: z.array(z.string()).describe("Tech tags: framework, language, services, etc."),
			error_msg: z.string().optional().describe("Exact error message if applicable"),
			context: contextSchema,
			meta: z
				.object({
					client: z.string().optional(),
					model: z.string().optional().describe("Your model name — always include this"),
					session_length: z.number().optional(),
					attempts_before_fix: z.number().optional(),
				})
				.optional()
				.describe("Session metadata for quality tuning"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async ({ summary: rawSummary, tags, error_msg, context, meta }) => {
			const rateLimitError = rateLimiter.check("drop_crumb");
			if (rateLimitError) return textResponse(rateLimitError);

			const summary = rawSummary.replace(/`/g, "").replace(/#{1,6}\s?/g, "").replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1").trim();

			const db = getDb(env);

			const validationError = validateSummary(summary);
			if (validationError) return textResponse(validationError);
			if (error_msg && error_msg.length > LIMITS.error_msg_max_length) {
				return textResponse(`Error message too long (${error_msg.length} chars, max ${LIMITS.error_msg_max_length}).`);
			}

			// Daily limit + embedding in parallel
			const textToScreen = summary + (error_msg ? ` ${error_msg}` : "");
			const [limitError, embedding] = await Promise.all([
				checkDailyLimit(db, "entries", "contributor", userId, LIMITS.contributions_per_day),
				embed(textToScreen, env.AI),
			]);

			if (limitError) return textResponse(limitError);

			// Similarity check — blocks true duplicates, allows competing entries
			const { data: similar } = await db.rpc("find_similar", {
				query_embedding: JSON.stringify(embedding),
				min_similarity: LIMITS.similarity_threshold,
				match_count: 3,
			});

			if (similar && similar.length > 0) {
				return textResponse(
					`Too similar to existing entries. If your fix is genuinely different, rephrase to highlight what's unique.\n\n${formatSimilar(similar as SimilarEntry[])}`,
				);
			}

			// Gemini screening — only for entries that passed similarity check
			const screeningResult = await screenSummary(textToScreen, env.GEMINI_API_KEY, env.SCREENING_MODEL, env.SKIP_SCREENING === "true");
			if (screeningResult) return textResponse(`Content screening: ${screeningResult}`);

			const initialTrust = getInitialTrust(meta?.model, isNewAccount());

			let data, error;
			for (let attempt = 0; attempt < 3; attempt++) {
				({ data, error } = await db
					.from("entries")
					.insert({
						short_id: generateShortId(),
						summary,
						tags: normalizeTags(tags),
						error_msg: error_msg ?? null,
						context: context ?? {},
						meta: meta ?? {},
						trust_score: initialTrust,
						contributor: userId,
						embedding: JSON.stringify(embedding),
					})
					.select("short_id")
					.single());
				if (!error || error.code !== PG_UNIQUE_VIOLATION) break;
			}

			if (error || !data) return textResponse(`Contribute error: ${error?.message ?? "no data returned"}`);

			const note = initialTrust >= 2 ? " Tier 1 model — immediately surfaceable." : "";

			return textResponse(`Crumb ${data.short_id} dropped.${note}`);
		},
	);

	server.tool(
		"confirm_crumb",
		`After using results from find_crumb, report on entries that influenced your approach.

- helpful: true = the entry informed or directly led to a working fix
- helpful: false = you tried it and it was wrong or made things worse
- Do NOT vote on entries you ignored entirely — only entries you engaged with

Never vote on your own contributions. One vote per entry per user.`,
		{
			results: z.array(
				z.object({
					entry_id: z.string().describe("Entry short ID from find_crumb results"),
					helpful: z.boolean().describe("true = worked, false = wrong/misleading"),
				}),
			).describe("Entries you tried and your verdict"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async ({ results }) => {
			const rateLimitError = rateLimiter.check("confirm_crumb");
			if (rateLimitError) return textResponse(rateLimitError);

			const db = getDb(env);

			const limitError = await checkDailyLimit(db, "confirmations", "user_id", userId, LIMITS.confirmations_per_day);
			if (limitError) return textResponse(limitError);

			async function processVote(shortId: string, helpful: boolean): Promise<string> {
				try {
					const { data: entry } = await db
						.from("entries")
						.select("id, contributor")
						.eq("short_id", shortId)
						.single();

					if (!entry) return `${shortId}: not found`;
					if (entry.contributor === userId) return `${shortId}: skipped (own)`;

					const { error: insertError } = await db.from("confirmations").insert({
						entry_id: entry.id,
						user_id: userId,
						helpful,
					});

					if (insertError) {
						return insertError.code === PG_UNIQUE_VIOLATION
							? `${shortId}: already voted`
							: `${shortId}: error`;
					}

					if (helpful) {
						await db.rpc("increment_trust", { entry_id: entry.id });
						return `${shortId}: confirmed`;
					} else {
						await db.rpc("dispute_entry", { target_id: entry.id });
						return `${shortId}: disputed`;
					}
				} catch {
					return `${shortId}: error`;
				}
			}

			const outcomes = await Promise.all(
				results.map(({ entry_id, helpful }) => processVote(entry_id, helpful)),
			);

			return textResponse(outcomes.join(", ") + "\n\nGot a fix worth sharing? drop_crumb.");
		},
	);
}
