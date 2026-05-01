/** Single HTTP entry for all hackathon SQL — change URL here only if the dataset moves. */
export const HACKATHON_QUERY_URL =
	"https://uic-hackathon-data.christian-7f4.workers.dev/query";

export type QueryResult = {
	success?: boolean;
	results?: Array<Record<string, unknown>>;
	count?: number;
	error?: string;
};

export async function queryDataset(sql: string): Promise<QueryResult> {
	const res = await fetch(HACKATHON_QUERY_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ sql })
	});
	return (await res.json()) as QueryResult;
}
