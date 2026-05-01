import { routeAgentRequest } from "agents";
import { HACKATHON_QUERY_URL } from "../lib/queryDataset";

function corsHeaders(request: Request): Headers {
	const h = new Headers();
	const origin = request.headers.get("Origin");
	h.set(
		"Access-Control-Allow-Origin",
		origin && origin.length > 0 ? origin : "*"
	);
	h.set("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
	h.set(
		"Access-Control-Allow-Headers",
		"Content-Type, Authorization, X-Requested-With"
	);
	h.set("Vary", "Origin");
	return h;
}

function jsonApi(
	payload: Record<string, unknown>,
	request: Request,
	status = 200
): Response {
	const h = corsHeaders(request);
	h.set("Content-Type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(payload), { status, headers: h });
}

/**
 * Single Worker HTTP entry — add REST routes here; keep asset fallback last.
 */
export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const path = url.pathname;

		if (request.method === "OPTIONS" && path.startsWith("/api")) {
			return new Response(null, { status: 204, headers: corsHeaders(request) });
		}

		if (
			(path === "/health" || path === "/api/health") &&
			request.method === "GET"
		) {
			return jsonApi(
				{
					ok: true,
					service: "healthcare-manager-assistant",
					dataPipeline: `Durable Object chat agent queries ${HACKATHON_QUERY_URL} (SELECT-only). Local data/ mirrors schema docs.`,
					routes: {
						"GET /": "SPA shell + static (/assets/*) via env.ASSETS",
						"GET /health or /api/health": "deployment check",
						"POST /api/chat":
							"metadata / integration hint (streaming chat runs via Workers Agents in the SPA)",
						"/agents/*": "Workers Agents (WebSocket/streaming assistant)"
					}
				},
				request,
				200
			);
		}

		if (path === "/api/chat" && request.method === "POST") {
			let acknowledged: unknown;
			try {
				acknowledged = await request.json();
			} catch {
				acknowledged = null;
			}
			return jsonApi(
				{
					message:
						"Interactive chat streams in this app’s SPA using Workers Agents. Use the composer on GET /.",
					constraints:
						"The assistant retrieves healthcare context via queryDatabase SQL tools plus Workers AI; there is no separate REST SSE in this Workers Agents template.",
					receivedPayload: acknowledged
				},
				request,
				200
			);
		}

		const routed = await routeAgentRequest(request, env);
		if (routed) return routed;

		return env.ASSETS.fetch(request);
	}
} satisfies ExportedHandler<Env>;
