import { PostgrestClient } from "@supabase/postgrest-js";

// Create a fresh client per request — Workers share isolates across
// requests with different env bindings, so module-level caching is unsafe.
export function getDb(env: Env): PostgrestClient {
	return new PostgrestClient(env.POSTGREST_URL, {
		headers: { Authorization: `Bearer ${env.POSTGREST_API_KEY}` },
	});
}

// Return type from find_crumbs RPC
export interface EntryRow {
	id: number;
	type: string;
	summary: string;
	tags: string[];
	context: Record<string, unknown>;
	trust_score: number;
	dispute_count: number;
	similarity: number;
	effective_score: number;
}

// Return type from find_similar RPC
export interface SimilarEntry {
	id: number;
	type: string;
	summary: string;
	tags: string[];
	trust_score: number;
	similarity: number;
}

// MCP tool response helper — avoids repeating the content wrapper
export function textResponse(text: string) {
	return { content: [{ type: "text" as const, text }] };
}
