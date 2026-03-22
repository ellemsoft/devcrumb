import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { embed } from "../lib/embed";
import { getDb, textResponse, type EntryRow } from "../lib/db";
import { LIMITS } from "./contribute";



function formatResults(entries: EntryRow[]): string {
	// Filter out low-relevance results
	const relevant = entries.filter((e) => e.effective_score >= LIMITS.min_relevance_score);
	if (relevant.length === 0) {
		return "No relevant entries found.";
	}
	return relevant
		.map(
			(e) =>
				`[#${e.id}] trust:${e.trust_score} score:${e.effective_score.toFixed(2)}\n` +
				`${e.type} | ${e.tags.join(", ")}\n` +
				e.summary,
		)
		.join("\n\n---\n\n");
}

export function registerFindTool(server: McpServer, env: Env) {
	server.tool(
		"find_crumb",
		`Search the shared knowledge base for fixes and gotchas from other developers.

Call when:
- About to implement something new or configure a service (type: "gotcha")
- An error or unexpected output occurs (type: "fix")
- User asks "how do I" about build tools, deployment, or platform config (type: "any")
- Working with Xcode, Gradle, CI/CD, app stores, or any platform tooling (type: "gotcha")

If results are empty or low relevance — stay silent, do not mention to user. Only surface genuinely relevant results.`,
		{
			query: z.string().describe("What you are building, or the error message"),
			type: z.enum(["fix", "gotcha", "any"]).default("any").describe("Type to search. Use 'fix' for errors, 'gotcha' for implementation warnings, 'any' when unsure"),
			tags: z.array(z.string()).optional().describe("Tech tags for filtering, e.g. ['nextjs', 'typescript', 'vercel']"),
		},
		{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		async ({ query, type, tags }) => {
			const db = getDb(env);
			const embedding = await embed(query, env.AI);

			const { data, error } = await db.rpc("find_crumbs", {
				query_embedding: JSON.stringify(embedding),
				match_count: LIMITS.match_count,
				min_trust: LIMITS.min_trust_to_surface,
				entry_type: type === "any" ? null : type,
				filter_tags: tags ?? null,
			});

			if (error) return textResponse(`Search error: ${error.message}`);
			return textResponse(formatResults(data as EntryRow[]));
		},
	);
}
