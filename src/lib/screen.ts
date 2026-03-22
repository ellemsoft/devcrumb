const SCREENING_PROMPT = `You are a content moderator for a public developer knowledge base. Entries describe software gotchas and fixes in plain language.

Does this summary contain ANY of the following?
- Internal company names, project names, or team names
- Passwords, secrets, or credentials (even described in words)
- Personal names or identifying information
- Internal URLs, hostnames, or infrastructure details specific to one organization
- Anything that should not be shared publicly

References to public services (Cloudflare, AWS, Vercel, GitHub, etc), public libraries, and general tech stack names are expected and fine.

Summary: "`;

const SCREENING_SUFFIX = '"\n\nAnswer ONLY "PASS" or "FAIL: <reason>". Nothing else.';

/**
 * Screen a summary for sensitive content using Gemini Flash-Lite.
 * Returns null if the summary is clean, or a reason string if rejected.
 * Fails open — if the API is unavailable, the summary is allowed through.
 */
export async function screenSummary(text: string, apiKey: string, model?: string, skipScreening?: boolean): Promise<string | null> {
	if (skipScreening) return null;
	if (!apiKey || !model) throw new Error("Content screening not configured. Set GEMINI_API_KEY and SCREENING_MODEL, or set SKIP_SCREENING=true to disable.");
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					contents: [{ parts: [{ text: SCREENING_PROMPT + text + SCREENING_SUFFIX }] }],
					generationConfig: { temperature: 0, maxOutputTokens: 30 },
				}),
			},
		);

		if (!res.ok) {
			console.error(`Content screening HTTP ${res.status}`);
			return null;
		}

		const data = (await res.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};

		const answer = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
		if (!answer) return null;
		if (answer.startsWith("FAIL")) return answer;
		return null;
	} catch (e) {
		console.error("Content screening error:", e);
		return null;
	}
}
