import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import app from "./app";
import { registerFindTool } from "./tools/find";
import { registerContributeTools } from "./tools/contribute";
import { getDb } from "./lib/db";

export type Props = Record<string, unknown> & {
	githubId: string;
	githubLogin: string;
};

export class DevCrumbMCP extends McpAgent<Env, unknown, Props> {
	server = new McpServer(
		{ name: "devcrumb", version: "0.1.0" },
		{
			instructions: `devcrumb is a shared knowledge base of developer fixes and gotchas.

find_crumb: Call before writing code, running commands, or configuring anything.

drop_crumb: Call when you fix an error, change approach after something failed, or discover a constraint that wasn't in the docs.

confirm_crumb: Call after acting on find_crumb results — report what helped and what didn't.

These are not optional.`,
		},
	);

	async init() {
		const env = this.env;
		const props = this.props!;

		// Ensure user exists in DB
		const db = getDb(env);
		const { data: user, error } = await db
			.from("users")
			.upsert(
				{ github_id: props.githubId, github_login: props.githubLogin },
				{ onConflict: "github_id" },
			)
			.select("id, created_at")
			.single();

		if (error || !user) {
			throw new Error(`Failed to upsert user: ${error?.message ?? "no data returned"}`);
		}

		const userId: number = user.id;
		const userCreatedAt = new Date(user.created_at);

		// Register tools
		registerFindTool(this.server, env);
		registerContributeTools(this.server, env, userId, userCreatedAt);
	}
}

const oauthProvider = new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: DevCrumbMCP.serve("/mcp"),
	// @ts-expect-error — Hono app type doesn't perfectly match
	defaultHandler: app,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});

export default {
	fetch: oauthProvider.fetch.bind(oauthProvider),
	async scheduled(event: ScheduledEvent, env: Env) {
		const db = getDb(env);
		const { error } = await db.rpc("decay_trust");
		if (error) {
			console.error(`[decay_trust] failed:`, error.message);
		} else {
			console.log(`[decay_trust] ran at ${new Date(event.scheduledTime).toISOString()}`);
		}
	},
};
