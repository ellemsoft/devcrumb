import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { getDb } from "./lib/db";

export type Bindings = Env & {
	OAUTH_PROVIDER: OAuthHelpers;
};

const app = new Hono<{ Bindings: Bindings }>();

async function signState(payload: string, key: string): Promise<string> {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(payload));
	const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
	return `${btoa(payload)}.${sig}`;
}

async function verifyState(signed: string, key: string): Promise<string | null> {
	const dotIndex = signed.lastIndexOf(".");
	if (dotIndex === -1) return null;

	const encodedPayload = signed.slice(0, dotIndex);
	const sig = signed.slice(dotIndex + 1);
	const payload = atob(encodedPayload);

	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);

	const sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
	const valid = await crypto.subtle.verify("HMAC", cryptoKey, sigBytes, encoder.encode(payload));
	return valid ? payload : null;
}

app.get("/", (c) => {
	return c.text("DevCrumb MCP Server");
});

const CORS = { "Access-Control-Allow-Origin": "https://devcrumb.dev" };
const ENTRY_COLUMNS = "short_id, summary, tags, trust_score, created_at";

async function cachedRoute(c: { req: { url: string }; executionCtx: ExecutionContext }, build: () => Promise<Response>): Promise<Response> {
	const cache = caches.default;
	const cacheKey = new Request(c.req.url);
	const cached = await cache.match(cacheKey);
	if (cached) return cached;
	const res = await build();
	c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
	return res;
}

app.get("/stats", async (c) => {
	try {
		return await cachedRoute(c, async () => {
			const db = getDb(c.env);
			const { count: entries } = await db.from("entries").select("id", { count: "exact", head: true }).eq("is_public", true);
			return c.json({ entries: entries ?? 0 }, 200, { ...CORS, "Cache-Control": "public, max-age=3600" });
		});
	} catch {
		return c.json({ entries: 0 }, 200, { ...CORS, "Cache-Control": "no-store" });
	}
});

app.get("/tags", async (c) => {
	try {
		return await cachedRoute(c, async () => {
			const db = getDb(c.env);
			const { data } = await db.rpc("get_top_tags", { limit_count: 50 });
			const tags = ((data ?? []) as { tag: string }[])
				.map((r) => r.tag)
				.filter((t): t is string => typeof t === "string" && t !== "general");
			return c.json({ tags }, 200, { ...CORS, "Cache-Control": "public, max-age=3600" });
		});
	} catch {
		return c.json({ tags: [] }, 200, { ...CORS, "Cache-Control": "no-store" });
	}
});

app.get("/entry/random", async (c) => {
	try {
		const db = getDb(c.env);
		const { data } = await db.rpc("get_random_entry");
		if (!data) return c.json({ error: "No entries found" }, 404, CORS);
		return c.json(data, 200, CORS);
	} catch {
		return c.json({ error: "Failed to fetch entry" }, 500, CORS);
	}
});

app.get("/entry/:id", async (c) => {
	try {
		const db = getDb(c.env);
		const { data, error } = await db.from("entries")
			.select(ENTRY_COLUMNS)
			.eq("short_id", c.req.param("id"))
			.eq("is_public", true)
			.single();
		if (error || !data) return c.json({ error: "Entry not found" }, 404, CORS);
		return c.json(data, 200, CORS);
	} catch {
		return c.json({ error: "Failed to fetch entry" }, 500, CORS);
	}
});

app.get("/health", async (c) => {
	try {
		const db = getDb(c.env);
		const { error } = await db.from("users").select("id").limit(1).single();
		if (error) return c.json({ status: "error" }, 500);
		return c.json({ status: "ok" });
	} catch {
		return c.json({ status: "error" }, 500);
	}
});

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);

	const state = await signState(JSON.stringify(oauthReqInfo), c.env.COOKIE_ENCRYPTION_KEY);

	const githubAuthUrl = new URL("https://github.com/login/oauth/authorize");
	githubAuthUrl.searchParams.set("client_id", c.env.GITHUB_CLIENT_ID);
	githubAuthUrl.searchParams.set("redirect_uri", `${new URL(c.req.url).origin}/callback`);
	githubAuthUrl.searchParams.set("scope", "read:user");
	githubAuthUrl.searchParams.set("state", state);

	return c.redirect(githubAuthUrl.toString());
});

app.get("/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");

	if (!code || !state) {
		return c.text("Missing code or state", 400);
	}

	// Verify HMAC signature on state
	const payload = await verifyState(state, c.env.COOKIE_ENCRYPTION_KEY);
	if (!payload) {
		return c.text("Invalid or tampered state", 400);
	}

	let oauthReqInfo;
	try {
		oauthReqInfo = JSON.parse(payload);
	} catch {
		return c.text("Invalid state payload", 400);
	}

	// Exchange code for GitHub access token
	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code,
		}),
	});

	const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
	if (!tokenData.access_token) {
		return c.text(`GitHub OAuth error: ${tokenData.error ?? "unknown"}`, 400);
	}

	// Fetch GitHub user profile
	const userRes = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${tokenData.access_token}`,
			"User-Agent": "DevCrumb-MCP",
		},
	});

	const githubUser = (await userRes.json()) as { id: number; login: string };

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		request: oauthReqInfo,
		userId: String(githubUser.id),
		metadata: {
			label: githubUser.login,
		},
		scope: oauthReqInfo.scope,
		props: {
			githubId: String(githubUser.id),
			githubLogin: githubUser.login,
		},
	});

	return c.redirect(redirectTo);
});

export default app;
