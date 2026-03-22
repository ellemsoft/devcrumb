import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { embed } from "../lib/embed";
import { screenSummary } from "../lib/screen";
import { getDb, textResponse, type SimilarEntry } from "../lib/db";

const PG_UNIQUE_VIOLATION = "23505";

export const LIMITS = {
	summary_min_length: 50,
	summary_max_length: 800,
	error_msg_max_length: 500,
	similarity_threshold: 0.65,
	min_trust_to_surface: 1,
	min_relevance_score: 0.3,
	match_count: 3,
	new_account_initial_trust: 0,
	new_account_days: 7,
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
	"hetzner", "aws", "gcp", "digitalocean", "azure", "linode", "vultr", "render",
	"port-3000", "port-8080", "port-5432", "port-80", "port-443",
]);

function normalizeTags(tags: string[]): string[] {
	return tags
		.map((t) => t.toLowerCase().trim())
		.filter((t) => t.length > 0 && t.length <= 50 && !INCIDENTAL_TAGS.has(t))
		.slice(0, 10);
}

function formatSimilar(entries: SimilarEntry[]): string {
	return entries
		.map((e) => `[#${e.id}] trust:${e.trust_score} sim:${e.similarity.toFixed(2)}\n${e.summary}`)
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
) {
	const isNewAccount = () =>
		Date.now() - userCreatedAt.getTime() < LIMITS.new_account_days * 24 * 60 * 60 * 1000;

	server.tool(
		"drop_crumb",
		`Contribute a verified fix or gotcha to the shared knowledge base.

Summary: be maximally concise. Format: "[context] [problem] → [fix]". 50-800 chars, plain language — no code, URLs, file paths, or secrets. Describe the root cause at the service level, not your specific setup.

Tags: tag the service with the limitation + the solution. Do NOT tag hosting providers or ports.

Do NOT submit: project-specific bugs, architecture opinions, code style preferences, or anything only relevant to one codebase.

Example: { summary: "Cloudflare Workers outbound fetch() blocks raw IP addresses (error 1003) → use a hostname via DNS", type: "gotcha", tags: ["cloudflare-workers"] }

Verify the summary contains NO sensitive data before calling. Submissions are screened and rejected if sensitive content is detected.

Call when:
- You tried multiple approaches before finding one that works — this is the strongest signal
- A fix is confirmed working after debugging
- You discover a non-obvious platform behavior or constraint
- Something behaved differently than expected based on documentation

The more attempts it took to solve, the more valuable the crumb.`,
		{
			summary: z.string().describe("What happened and what fixed it (50-800 chars, plain language)"),
			type: z.enum(["fix", "gotcha"]).describe("fix = error resolution, gotcha = implementation warning"),
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
		async ({ summary, type, tags, error_msg, context, meta }) => {
			const db = getDb(env);

			const validationError = validateSummary(summary);
			if (validationError) return textResponse(validationError);
			if (error_msg && error_msg.length > LIMITS.error_msg_max_length) {
				return textResponse(`Error message too long (${error_msg.length} chars, max ${LIMITS.error_msg_max_length}).`);
			}

			// Rate limit + embedding + screening in parallel
			const textToScreen = summary + (error_msg ? ` ${error_msg}` : "");
			const [limitError, embedding, screeningResult] = await Promise.all([
				checkDailyLimit(db, "entries", "contributor", userId, LIMITS.contributions_per_day),
				embed(textToScreen, env.AI),
				screenSummary(textToScreen, env.GEMINI_API_KEY, env.SCREENING_MODEL, env.SKIP_SCREENING === "true"),
			]);

			if (limitError) return textResponse(limitError);
			if (screeningResult) return textResponse(`Content screening: ${screeningResult}`);

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

			const initialTrust = getInitialTrust(meta?.model, isNewAccount());

			const { data, error } = await db
				.from("entries")
				.insert({
					summary,
					type,
					tags: normalizeTags(tags),
					error_msg: error_msg ?? null,
					context: context ?? {},
					meta: meta ?? {},
					trust_score: initialTrust,
					contributor: userId,
					embedding: JSON.stringify(embedding),
				})
				.select("id")
				.single();

			if (error) return textResponse(`Contribute error: ${error.message}`);

			const note =
				initialTrust === 0
					? " New account — needs confirmation to surface."
					: initialTrust >= 2
						? " Tier 1 model — immediately surfaceable."
						: "";

			return textResponse(`Crumb #${data.id} dropped.${note}`);
		},
	);

	server.tool(
		"confirm_crumb",
		`After using results from find_crumb, report which entries you actually tried and whether they helped.

- helpful: true = "I tried this and it worked"
- helpful: false = "I tried this and it was WRONG or misleading"
- Do NOT include entries you skipped — no opinion is fine

Never vote on your own contributions. One vote per entry per user.`,
		{
			results: z.array(
				z.object({
					entry_id: z.number().describe("Entry ID from find_crumb results"),
					helpful: z.boolean().describe("true = worked, false = wrong/misleading"),
				}),
			).describe("Entries you tried and your verdict"),
		},
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
		async ({ results }) => {
			const db = getDb(env);

			const limitError = await checkDailyLimit(db, "confirmations", "user_id", userId, LIMITS.confirmations_per_day);
			if (limitError) return textResponse(limitError);

			async function processVote(entry_id: number, helpful: boolean): Promise<string> {
				try {
					const { data: entry } = await db
						.from("entries")
						.select("contributor")
						.eq("id", entry_id)
						.single();

					if (!entry) return `#${entry_id}: not found`;
					if (entry.contributor === userId) return `#${entry_id}: skipped (own)`;

					const { error: insertError } = await db.from("confirmations").insert({
						entry_id,
						user_id: userId,
						helpful,
					});

					if (insertError) {
						return insertError.code === PG_UNIQUE_VIOLATION
							? `#${entry_id}: already voted`
							: `#${entry_id}: error`;
					}

					if (helpful) {
						await db.rpc("increment_trust", { entry_id });
						return `#${entry_id}: confirmed`;
					} else {
						await db.rpc("dispute_entry", { target_id: entry_id });
						return `#${entry_id}: disputed`;
					}
				} catch {
					return `#${entry_id}: error`;
				}
			}

			const outcomes = await Promise.all(
				results.map(({ entry_id, helpful }) => processVote(entry_id, helpful)),
			);

			return textResponse(outcomes.join(", "));
		},
	);
}
