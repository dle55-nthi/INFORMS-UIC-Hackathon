import type { ModelMessage } from "ai";

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
export function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
	return messages.map((msg) => {
		if (msg.role !== "user" || typeof msg.content === "string") return msg;
		return {
			...msg,
			content: msg.content.map((part) => {
				if (part.type !== "file" || typeof part.data !== "string") return part;
				const match = part.data.match(/^data:([^;]+);base64,(.+)$/);
				if (!match) return part;
				const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
				return { ...part, data: bytes, mediaType: match[1] };
			})
		};
	});
}
