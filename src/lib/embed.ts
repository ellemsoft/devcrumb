export async function embed(text: string, ai: Ai): Promise<number[]> {
	const result = await ai.run("@cf/baai/bge-small-en-v1.5", {
		text: [text.slice(0, 1000)],
	});
	if (!result.data?.[0]) {
		throw new Error("Embedding model returned empty result");
	}
	return result.data[0];
}
