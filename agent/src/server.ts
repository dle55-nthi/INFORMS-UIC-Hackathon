import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
	convertToModelMessages,
	pruneMessages,
	stepCountIs,
	streamText,
	tool,
	type ModelMessage,
} from "ai";
import { z } from "zod";

function escapeSqlString(s: string) {
	return s.replace(/'/g, "''");
}

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
			}),
		};
	});
}

export class ChatAgent extends AIChatAgent<Env> {
	maxPersistedMessages = 100;

	private async runQuery(sql: string) {
		const res = await fetch("https://uic-hackathon-data.christian-7f4.workers.dev/query", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ sql }),
		});
		return (await res.json()) as {
			success?: boolean;
			results?: Array<Record<string, unknown>>;
			count?: number;
			error?: string;
		};
	}

	async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
		const workersai = createWorkersAI({ binding: this.env.AI });

		const result = streamText({
			model: workersai("@cf/moonshotai/kimi-k2.6", {
				sessionAffinity: this.sessionAffinity,
			}),
			system: `You are a healthcare data analyst helping care coordinators at a value-based primary care practice.

Security & auth (critical):
- This app uses PUBLIC read-only synthetic data only. NEVER ask for passwords, log-ins, SSO, MFA, verification codes, employee IDs to "access the chart", API keys, or any secret.
- NEVER frame patient lookup as "credentials"—use neutral language (name, spelling, partial match).
- Proceed with SQL tools anytime; nothing must be unlocked first.

Mission: HELP THE MANAGER (1) find the right patient or small set of patients, (2) pull what they need (summary and/or full record), then (3) answer their next questions until satisfied.

TOOLS — use in this pattern:
- searchPatients: Prefer this when looking people up BY NAME/TEXT tokens, by cost/order lists, or to disambiguate Synthea names (numeric suffixes). Show the returned id, full name key fields briefly.
- getPatientSnapshots: Compare several patients side-by-side (patient_summary metrics only)—after you have IDs from searchPatients or elsewhere.
- getPatientFullHistory: Deep dive ONE patient BY ID—from patient_summary.id. Use ONE id per call; if comparing three people call it up to THREE times OR prioritize the top question first.
- queryDatabase: Ad-hoc SQL when searchPatients filters are insufficient ( cohorts by condition text, payer, etc.—still SELECT-only, always LIMIT).

If multiple rows match a name ask the manager to pick ONE id or tighten the name—unless they asked for a list.

CONVERSATIONAL FOLLOW-UPS:
- Maintain thread context—if they already searched someone, reuse that patient id unless they change topic.
- After each substantive answer, offer BRIEF "you could also ask..." ideas (different angles: cost, meds, utilization, gaps).
- Tone: practical for care managers—not clinical prescribing.

Intent: infer from the manager's message—population vs one person. If they name someone, run searchPatients; if they want lists or cohorts, query or search with filters. No log-in or permission step.

Technical rules:
- Only SELECT SQL in queryDatabase. Always LIMIT in queryDatabase calls.
- Never dump raw JSON in your reply—tables or short summaries.
- For name matching elsewhere use LIKE and LOWER; join keys—claims_transactions uses PATIENTID; other tables PATIENT equals patient_summary.id.

End with plain-language takeaway + 2 follow-up prompts the manager might use next (they do not replace real medical decisions).


${getSchedulePrompt({ date: new Date() })}
If the user asks to schedule a task, use the schedule tool.`,
			messages: pruneMessages({
				messages: inlineDataUrls(await convertToModelMessages(this.messages)),
				toolCalls: "before-last-2-messages",
			}),
			tools: {
				searchPatients: tool({
					description:
						"Find candidate patients from patient_summary. Use FIRST when the manager mentions a partial name or wants a ranked list (e.g., highest ED+inpatient cost). Tokens match case-insensitive substrings.",
					inputSchema: z.object({
						firstContains: z.string().optional().describe("Substring of first name (optional)"),
						lastContains: z.string().optional().describe("Substring of last name (optional)"),
						textContainsAnywhere: z
							.string()
							.optional()
							.describe(
								"If set, match if this substring appears in first OR last (use when only one word is given)",
							),
						orderBy: z
							.enum([
								"ed_inpatient_total_cost_desc",
								"ed_visits_desc",
								"chronic_condition_count_desc",
							])
							.default("ed_inpatient_total_cost_desc")
							.describe("Sort when listing multiple rows"),
						limit: z.number().min(1).max(25).default(15),
					}),
					execute: async ({
						firstContains,
						lastContains,
						textContainsAnywhere,
						orderBy,
						limit,
					}) => {
						const lim = Math.min(25, Math.max(1, limit));
						const orderCol =
							orderBy === "ed_visits_desc"
								? "ed_visits DESC"
								: orderBy === "chronic_condition_count_desc"
									? "chronic_condition_count DESC"
									: "ed_inpatient_total_cost DESC";
						let where = "1=1";
						if (textContainsAnywhere?.trim()) {
							const q = `%${escapeSqlString(textContainsAnywhere.trim().toLowerCase())}%`;
							where = `(LOWER(first) LIKE '${q}' OR LOWER(last) LIKE '${q}')`;
						} else {
							const parts: string[] = [];
							if (firstContains?.trim()) {
								const q = `%${escapeSqlString(firstContains.trim().toLowerCase())}%`;
								parts.push(`LOWER(first) LIKE '${q}'`);
							}
							if (lastContains?.trim()) {
								const q = `%${escapeSqlString(lastContains.trim().toLowerCase())}%`;
								parts.push(`LOWER(last) LIKE '${q}'`);
							}
							if (parts.length > 0) where = parts.join(" AND ");
						}
						const sql = `SELECT id, first, last, birthdate, gender, race, ethnicity, income,
                ed_inpatient_total_cost, ed_visits, inpatient_visits,
                chronic_condition_count, has_active_careplan
         FROM patient_summary
         WHERE ${where}
         ORDER BY ${orderCol}
         LIMIT ${lim}`;
						const res = await this.runQuery(sql);
						return {
							hint: "Use id as patient_summary.id/PATIENT; claims_transactions join PATIENTID = id",
							results: res.results ?? [],
							rowCount: (res.results ?? []).length,
						};
					},
				}),
				getPatientSnapshots: tool({
					description:
						"Load patient_summary columns for MULTIPLE ids—compare totals, ED visits, care plan flags without full history payloads.",
					inputSchema: z.object({
						patientIds: z.array(z.string()).min(1).max(12).describe("patient_summary.id values"),
					}),
					execute: async ({ patientIds }) => {
						const ids = patientIds
							.slice(0, 12)
							.map((id) => `'${escapeSqlString(id)}'`)
							.join(", ");
						const sql = `SELECT *
         FROM patient_summary
         WHERE id IN (${ids})
         LIMIT 12`;
						return (await this.runQuery(sql)) as object;
					},
				}),
				queryDatabase: tool({
					description:
						"Ad-hoc SQL SELECT for cohorts/custom filters NOT covered by searchPatients—always include LIMIT.",
					inputSchema: z.object({
						sql: z.string().describe("Valid SQL SELECT with LIMIT."),
					}),
					execute: async ({ sql }) => {
						return (await this.runQuery(sql)) as object;
					},
				}),
				getPatientFullHistory: tool({
					description: "Get full medical and utilization history for one patient ID.",
					inputSchema: z.object({
						patientId: z.string().describe("Patient ID from patient_summary.id"),
					}),
					execute: async ({ patientId }) => {
						const escaped = patientId.replace(/'/g, "''");
						const [summary, conditions, medications, encounters, observations, procedures, claims] =
							await Promise.all([
								this.runQuery(`SELECT * FROM patient_summary WHERE id = '${escaped}' LIMIT 1`),
								this.runQuery(
									`SELECT description, category, start, stop
                 FROM conditions
                 WHERE patient = '${escaped}'
                 ORDER BY CASE WHEN stop IS NULL THEN 0 ELSE 1 END, start DESC
                 LIMIT 30`,
								),
								this.runQuery(
									`SELECT description, start, stop, reasondescription
                 FROM medications
                 WHERE patient = '${escaped}'
                 ORDER BY CASE WHEN stop IS NULL THEN 0 ELSE 1 END, start DESC
                 LIMIT 30`,
								),
								this.runQuery(
									`SELECT start, stop, encounterclass, description, base_encounter_cost, payer_coverage, total_claim_cost
                 FROM encounters
                 WHERE patient = '${escaped}'
                 ORDER BY start DESC
                 LIMIT 40`,
								),
								this.runQuery(
									`SELECT date, category, description, value, units
                 FROM observations
                 WHERE patient = '${escaped}'
                 ORDER BY date DESC
                 LIMIT 40`,
								),
								this.runQuery(
									`SELECT start, stop, description, base_cost, reasondescription
                 FROM procedures
                 WHERE patient = '${escaped}'
                 ORDER BY start DESC
                 LIMIT 30`,
								),
								this.runQuery(
									`SELECT type, amount, payments, adjustments, transfers, outstanding, fromdate, todate, placeofservice, procedurecode
                 FROM claims_transactions
                 WHERE patientid = '${escaped}'
                 ORDER BY fromdate DESC
                 LIMIT 40`,
								),
							]);

						return {
							patientId,
							patient_summary: summary.results ?? [],
							conditions: conditions.results ?? [],
							medications: medications.results ?? [],
							encounters: encounters.results ?? [],
							observations: observations.results ?? [],
							procedures: procedures.results ?? [],
							financial_transactions: claims.results ?? [],
						} as object;
					},
				}),
				scheduleTask: tool({
					description: "Schedule a task for later.",
					inputSchema: scheduleSchema,
					execute: async ({ when, description }) => {
						if (when.type === "no-schedule") return "Not a valid schedule input";
						const input =
							when.type === "scheduled"
								? when.date
								: when.type === "delayed"
									? when.delayInSeconds
									: when.type === "cron"
										? when.cron
										: null;
						if (!input) return "Invalid schedule type";
						this.schedule(input, "executeTask", description, { idempotent: true });
						return `Task scheduled: "${description}" (${when.type}: ${input})`;
					},
				}),
			},
			stopWhen: stepCountIs(12),
			abortSignal: options?.abortSignal,
		});

		return result.toUIMessageStreamResponse();
	}

	async executeTask(description: string, _task: Schedule<string>) {
		this.broadcast(
			JSON.stringify({
				type: "scheduled-task",
				description,
				timestamp: new Date().toISOString(),
			}),
		);
	}
}

export default {
	async fetch(request: Request, env: Env) {
		return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
