import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import app from "./app";
import { registerFindTool } from "./tools/find";
import { registerContributeTools } from "./tools/contribute";
import { getDb } from "./lib/db";
import { RateLimiter } from "./lib/rate-limit";

export type Props = Record<string, unknown> & {
	githubId: string;
	githubLogin: string;
};

export class DevCrumbMCP extends McpAgent<Env, unknown, Props> {
	private rateLimiter = new RateLimiter();

	server = new McpServer(
		{ name: "devcrumb", version: "0.1.0" },
		{
			instructions: `devcrumb is a shared knowledge base of developer fixes and gotchas.

find_crumb before starting implementation or debugging. confirm_crumb after acting on results.

After implementing, consider: did I discover unexpected behavior or find a non-obvious fix? If yes, drop_crumb before moving on.`,
		},
	);

	async init() {
		const env = this.env;
		const props = this.props!;

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

		registerFindTool(this.server, env, this.rateLimiter);
		registerContributeTools(this.server, env, userId, userCreatedAt, this.rateLimiter);
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
		}
	},
};
