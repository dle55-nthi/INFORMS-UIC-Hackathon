const DEFAULT_QUERY_ENDPOINT =
	"https://uic-hackathon-data.christian-7f4.workers.dev/query";

export type SqlResponse<T = Record<string, unknown>> =
	| { success: true; results: T[]; count?: number }
	| { success: false; error?: string; message?: string };

function resolveQueryUrl(): string {
	const raw = import.meta.env.VITE_QUERY_URL?.trim();
	if (!raw || raw === "") return DEFAULT_QUERY_ENDPOINT;
	if (raw.startsWith("/")) return `${window.location.origin}${raw}`;
	return raw;
}

export async function querySql<T = Record<string, unknown>>(
	sql: string,
): Promise<T[]> {
	const url = resolveQueryUrl();
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sql }),
	});
	const json = (await res.json()) as SqlResponse<T>;
	if (!json.success) {
		const msg =
			json && typeof json === "object" && "error" in json
				? String((json as { error?: string }).error)
				: "Query failed";
		throw new Error(msg);
	}
	return json.results;
}

/** Safe integer LIMIT for parameterized UI (avoid SQL injection). */
export function clampLimit(n: number, min = 1, max = 50): number {
	const x = Math.floor(Number(n));
	if (!Number.isFinite(x)) return min;
	return Math.min(max, Math.max(min, x));
}
