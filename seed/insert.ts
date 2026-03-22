// Seed script — run with: npx tsx seed/insert.ts
// Uses the deployed Worker for embeddings and PostgREST for inserts.

import { PostgrestClient } from "@supabase/postgrest-js";
import entries from "./entries.json";

const WORKER_URL = "https://mcp.devcrumb.dev";
const POSTGREST_URL = process.env.POSTGREST_URL!;
const POSTGREST_API_KEY = process.env.POSTGREST_API_KEY!;

if (!POSTGREST_URL || !POSTGREST_API_KEY) {
	console.error("Set POSTGREST_URL and POSTGREST_API_KEY env vars");
	process.exit(1);
}

async function embed(text: string): Promise<number[]> {
	const res = await fetch(`${WORKER_URL}/embed`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ text }),
	});
	const data = (await res.json()) as { embedding: number[] };
	return data.embedding;
}

async function main() {
	const db = new PostgrestClient(POSTGREST_URL, {
		headers: { Authorization: `Bearer ${POSTGREST_API_KEY}` },
	});

	// Ensure seed user exists
	const { data: user, error: userError } = await db
		.from("users")
		.upsert({ github_id: "seed", github_login: "devcrumb-seed" }, { onConflict: "github_id" })
		.select("id")
		.single();

	if (userError || !user) {
		console.error("Failed to create seed user:", userError?.message);
		process.exit(1);
	}

	console.log(`Seed user ID: ${user.id}`);
	console.log(`Inserting ${entries.length} entries...\n`);

	let inserted = 0;
	let skipped = 0;

	for (const entry of entries) {
		const embedding = await embed(entry.summary);

		const { error } = await db.from("entries").insert({
			type: entry.type,
			summary: entry.summary,
			tags: entry.tags,
			trust_score: entry.trust_score,
			contributor: user.id,
			embedding: JSON.stringify(embedding),
			context: {},
			meta: { client: "seed-script" },
		});

		if (error) {
			console.error(`  SKIP: ${entry.summary.slice(0, 60)}... — ${error.message}`);
			skipped++;
		} else {
			console.log(`  OK: ${entry.summary.slice(0, 60)}...`);
			inserted++;
		}
	}

	console.log(`\nDone. ${inserted} inserted, ${skipped} skipped.`);
}

main();
