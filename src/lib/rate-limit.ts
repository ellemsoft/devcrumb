/**
 * In-memory rate limiter for Durable Object tool calls.
 * Lives as long as the MCP connection — one instance per session.
 */

interface RateWindow {
	count: number;
	expiresAt: number;
}

export type ToolName = "find_crumb" | "drop_crumb" | "confirm_crumb";

const LIMITS: Record<ToolName, { max: number; windowMs: number }> = {
	find_crumb: { max: 200, windowMs: 60 * 60 * 1000 },
	drop_crumb: { max: 50, windowMs: 60 * 60 * 1000 },
	confirm_crumb: { max: 50, windowMs: 60 * 60 * 1000 },
};

export class RateLimiter {
	private windows = new Map<ToolName, RateWindow>();

	/** Returns an error string if the limit is exceeded, null if allowed. */
	check(tool: ToolName): string | null {
		const limit = LIMITS[tool];
		const now = Date.now();
		const window = this.windows.get(tool);

		if (!window || now >= window.expiresAt) {
			this.windows.set(tool, { count: 1, expiresAt: now + limit.windowMs });
			return null;
		}

		if (window.count >= limit.max) {
			const minutesLeft = Math.ceil((window.expiresAt - now) / 60_000);
			return `Rate limit exceeded for ${tool} (${limit.max}/hour). Try again in ~${minutesLeft}m.`;
		}

		window.count++;
		return null;
	}
}
