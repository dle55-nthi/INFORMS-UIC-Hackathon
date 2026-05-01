import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
	convertToModelMessages,
	pruneMessages,
	stepCountIs,
	streamText,
	tool,
	type ModelMessage
} from "ai";
import { z } from "zod";

/**
 * The AI SDK's downloadAssets step runs `new URL(data)` on every file
 * part's string data. Data URIs parse as valid URLs, so it tries to
 * HTTP-fetch them and fails. Decode to Uint8Array so the SDK treats
 * them as inline data instead.
 */
function inlineDataUrls(messages: ModelMessage[]): ModelMessage[] {
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

export class ChatAgent extends AIChatAgent<Env> {
	maxPersistedMessages = 100;

	private async runQuery(sql: string) {
		const res = await fetch(
			"https://uic-hackathon-data.christian-7f4.workers.dev/query",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ sql })
			}
		);
		return (await res.json()) as {
			success?: boolean;
			results?: Array<Record<string, unknown>>;
			count?: number;
			error?: string;
		};
	}

	onStart() {
		// Configure OAuth popup behavior for MCP servers that require authentication
		this.mcp.configureOAuthCallback({
			customHandler: (result) => {
				if (result.authSuccess) {
					return new Response("<script>window.close();</script>", {
						headers: { "content-type": "text/html" },
						status: 200
					});
				}
				return new Response(
					`Authentication Failed: ${result.authError || "Unknown error"}`,
					{ headers: { "content-type": "text/plain" }, status: 400 }
				);
			}
		});
	}

	@callable()
	async addServer(name: string, url: string) {
		return await this.addMcpServer(name, url);
	}

	@callable()
	async removeServer(serverId: string) {
		await this.removeMcpServer(serverId);
	}

	async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
		const mcpTools = this.mcp.getAITools();
		const workersai = createWorkersAI({ binding: this.env.AI });

		const result = streamText({
			model: workersai("@cf/moonshotai/kimi-k2.6", {
				sessionAffinity: this.sessionAffinity
			}),
			system: `You are a healthcare data analyst helping care coordinators at a value-based primary care practice.

Security (critical): This demo uses PUBLIC read-only synthetic data. NEVER ask for passwords, SSO, MFA, verification codes, API keys, or "patient credentials". Never label name lookup as a log-in—use neutral language only.
"Asking the coordinator to confirm" means confirming your analysis textually—not authenticating anyone.

You have access to a database of synthetic patients. Use the queryDatabase tool whenever you need patient data.

Start every investigation with:
SELECT * FROM patient_summary ORDER BY ed_inpatient_total_cost DESC LIMIT 10

Key tables:
- patient_summary: start here - one row per patient, pre-computed costs and visit counts
- encounters: filter by ENCOUNTERCLASS (emergency, inpatient, ambulatory, urgentcare, wellness)
- conditions: active when STOP IS NULL - includes clinical and SDOH conditions
- observations: PRAPARE social screenings (housing, food, transport, stress)
- claims_transactions: financial data - join on PATIENTID (not PATIENT)
- medications: active when STOP IS NULL
- careplans: active when STOP IS NULL

Rules:
- Only write SQL SELECT statements
- Always include a LIMIT clause in SQL
- Never show raw JSON; format results as a table or concise summary
- Before recommending action, summarize findings and ask the coordinator to confirm
- Synthea names often include numeric suffixes (example: Giovanni385 Paucek755). When matching by name, use LOWER(...) with LIKE, not exact equality
- For person-specific questions, call findPatientCandidates first to resolve the correct patient record before deeper analysis
- Resolve patients by ID or by name via queryDatabase (LIKE/LOWER). For named patients, call getPatientFullHistory after resolving the patient ID
- Always drill into encounters, medications, procedures, and financial transactions before concluding
- Identify cost concentration (what categories drive most spend) and flag potentially avoidable utilization patterns
- Produce a plain-language briefing suitable for care managers, then invite concise follow-up questions for deeper drill-down

${getSchedulePrompt({ date: new Date() })}
If the user asks to schedule a task, use the schedule tool.`,
			// Prune old tool calls to save tokens on long conversations
			messages: pruneMessages({
				messages: inlineDataUrls(await convertToModelMessages(this.messages)),
				toolCalls: "before-last-2-messages"
			}),
			tools: {
				// MCP tools from connected servers
				...mcpTools,

				queryDatabase: tool({
					description:
						"Execute a SQL SELECT query against the healthcare dataset. " +
						"Use patient_summary as your starting point. " +
						"IMPORTANT: claims_transactions joins on PATIENTID, not PATIENT.",
					inputSchema: z.object({
						sql: z
							.string()
							.describe(
								"A valid SQL SELECT statement. Always include a LIMIT clause."
							)
					}),
					execute: async ({ sql }) => {
						const res = await fetch(
							"https://uic-hackathon-data.christian-7f4.workers.dev/query",
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ sql })
							}
						);
						return (await res.json()) as object;
					}
				}),

				getPatientFullHistory: tool({
					description:
						"Get full medical and utilization history for one patient ID. " +
						"Use after resolving the patient's ID from patient_summary.",
					inputSchema: z.object({
						patientId: z
							.string()
							.describe("PATIENT identifier from patient_summary")
					}),
					execute: async ({ patientId }) => {
						const escaped = patientId.replace(/'/g, "''");

						const [
							summary,
							conditions,
							medications,
							encounters,
							observations,
							procedures,
							claims
						] = await Promise.all([
							this.runQuery(
								`SELECT *
                   FROM patient_summary
                   WHERE id = '${escaped}'
                   LIMIT 1`
							),
							this.runQuery(
								`SELECT description, category, start, stop
                   FROM conditions
                   WHERE patient = '${escaped}'
                   ORDER BY CASE WHEN stop IS NULL THEN 0 ELSE 1 END, start DESC
                   LIMIT 30`
							),
							this.runQuery(
								`SELECT description, start, stop, reasondescription
                   FROM medications
                   WHERE patient = '${escaped}'
                   ORDER BY CASE WHEN stop IS NULL THEN 0 ELSE 1 END, start DESC
                   LIMIT 30`
							),
							this.runQuery(
								`SELECT start, stop, encounterclass, description, base_encounter_cost, payer_coverage, total_claim_cost
                   FROM encounters
                   WHERE patient = '${escaped}'
                   ORDER BY start DESC
                   LIMIT 40`
							),
							this.runQuery(
								`SELECT date, category, description, value, units
                   FROM observations
                   WHERE patient = '${escaped}'
                   ORDER BY date DESC
                   LIMIT 40`
							),
							this.runQuery(
								`SELECT start, stop, description, base_cost, reasondescription
                   FROM procedures
                   WHERE patient = '${escaped}'
                   ORDER BY start DESC
                   LIMIT 30`
							),
							this.runQuery(
								`SELECT type, amount, payments, adjustments, transfers, outstanding, fromdate, todate, placeofservice, procedurecode
                   FROM claims_transactions
                   WHERE patientid = '${escaped}'
                   ORDER BY fromdate DESC
                   LIMIT 40`
							)
						]);

						return {
							patientId,
							patient_summary: summary.results ?? [],
							conditions: conditions.results ?? [],
							medications: medications.results ?? [],
							encounters: encounters.results ?? [],
							observations: observations.results ?? [],
							procedures: procedures.results ?? [],
							financial_transactions: claims.results ?? []
						} as object;
					}
				}),

				findPatientCandidates: tool({
					description:
						"Find likely patient matches from a human-entered name. " +
						"Use this first when a user asks about a specific person.",
					inputSchema: z.object({
						name: z
							.string()
							.describe("Patient name text like 'Giovanni Paucek'"),
						limit: z
							.number()
							.int()
							.min(1)
							.max(20)
							.default(5)
							.describe("Max matches to return")
					}),
					execute: async ({ name, limit }) => {
						const cleaned = name.trim().toLowerCase();
						const parts = cleaned.split(/\s+/).filter(Boolean);
						const firstLike = parts[0] ?? cleaned;
						const lastLike = parts.length > 1 ? parts[parts.length - 1] : "";

						const sql = lastLike
							? `SELECT id AS patient, first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits, chronic_condition_count, has_active_careplan
                 FROM patient_summary
                 WHERE LOWER(first) LIKE '%${firstLike.replace(/'/g, "''")}%'
                   AND LOWER(last) LIKE '%${lastLike.replace(/'/g, "''")}%'
                 ORDER BY ed_inpatient_total_cost DESC
                 LIMIT ${limit}`
							: `SELECT id AS patient, first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits, chronic_condition_count, has_active_careplan
                 FROM patient_summary
                 WHERE LOWER(first) LIKE '%${firstLike.replace(/'/g, "''")}%'
                    OR LOWER(last) LIKE '%${firstLike.replace(/'/g, "''")}%'
                 ORDER BY ed_inpatient_total_cost DESC
                 LIMIT ${limit}`;

						const res = await fetch(
							"https://uic-hackathon-data.christian-7f4.workers.dev/query",
							{
								method: "POST",
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({ sql })
							}
						);
						return (await res.json()) as object;
					}
				}),

				// Server-side tool: runs automatically on the server
				getWeather: tool({
					description: "Get the current weather for a city",
					inputSchema: z.object({
						city: z.string().describe("City name")
					}),
					execute: async ({ city }) => {
						// Replace with a real weather API in production
						const conditions = ["sunny", "cloudy", "rainy", "snowy"];
						const temp = Math.floor(Math.random() * 30) + 5;
						return {
							city,
							temperature: temp,
							condition:
								conditions[Math.floor(Math.random() * conditions.length)],
							unit: "celsius"
						};
					}
				}),

				// Client-side tool: no execute function — the browser handles it
				getUserTimezone: tool({
					description:
						"Get the user's timezone from their browser. Use this when you need to know the user's local time.",
					inputSchema: z.object({})
				}),

				// Approval tool: requires user confirmation before executing
				calculate: tool({
					description:
						"Perform a math calculation with two numbers. Requires user approval for large numbers.",
					inputSchema: z.object({
						a: z.number().describe("First number"),
						b: z.number().describe("Second number"),
						operator: z
							.enum(["+", "-", "*", "/", "%"])
							.describe("Arithmetic operator")
					}),
					needsApproval: async ({ a, b }) =>
						Math.abs(a) > 1000 || Math.abs(b) > 1000,
					execute: async ({ a, b, operator }) => {
						const ops: Record<string, (x: number, y: number) => number> = {
							"+": (x, y) => x + y,
							"-": (x, y) => x - y,
							"*": (x, y) => x * y,
							"/": (x, y) => x / y,
							"%": (x, y) => x % y
						};
						if (operator === "/" && b === 0) {
							return { error: "Division by zero" };
						}
						return {
							expression: `${a} ${operator} ${b}`,
							result: ops[operator](a, b)
						};
					}
				}),

				scheduleTask: tool({
					description:
						"Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
					inputSchema: scheduleSchema,
					execute: async ({ when, description }) => {
						if (when.type === "no-schedule") {
							return "Not a valid schedule input";
						}
						const input =
							when.type === "scheduled"
								? when.date
								: when.type === "delayed"
									? when.delayInSeconds
									: when.type === "cron"
										? when.cron
										: null;
						if (!input) return "Invalid schedule type";
						try {
							this.schedule(input, "executeTask", description, {
								idempotent: true
							});
							return `Task scheduled: "${description}" (${when.type}: ${input})`;
						} catch (error) {
							return `Error scheduling task: ${error}`;
						}
					}
				}),

				getScheduledTasks: tool({
					description: "List all tasks that have been scheduled",
					inputSchema: z.object({}),
					execute: async () => {
						const tasks = this.getSchedules();
						return tasks.length > 0 ? tasks : "No scheduled tasks found.";
					}
				}),

				cancelScheduledTask: tool({
					description: "Cancel a scheduled task by its ID",
					inputSchema: z.object({
						taskId: z.string().describe("The ID of the task to cancel")
					}),
					execute: async ({ taskId }) => {
						try {
							this.cancelSchedule(taskId);
							return `Task ${taskId} cancelled.`;
						} catch (error) {
							return `Error cancelling task: ${error}`;
						}
					}
				})
			},
			stopWhen: stepCountIs(5),
			abortSignal: options?.abortSignal
		});

		return result.toUIMessageStreamResponse();
	}

	async executeTask(description: string, _task: Schedule<string>) {
		// Do the actual work here (send email, call API, etc.)
		console.log(`Executing scheduled task: ${description}`);

		// Notify connected clients via a broadcast event.
		// We use broadcast() instead of saveMessages() to avoid injecting
		// into chat history — that would cause the AI to see the notification
		// as new context and potentially loop.
		this.broadcast(
			JSON.stringify({
				type: "scheduled-task",
				description,
				timestamp: new Date().toISOString()
			})
		);
	}
}

export default {
	async fetch(request: Request, env: Env) {
		return (
			(await routeAgentRequest(request, env)) ||
			new Response("Not found", { status: 404 })
		);
	}
} satisfies ExportedHandler<Env>;
