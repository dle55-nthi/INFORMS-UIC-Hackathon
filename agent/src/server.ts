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
	type ModelMessage,
} from "ai";
import { z } from "zod";

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

	@callable()
	async resolvePatientCredential(fullName: string) {
		const cleaned = fullName.trim().toLowerCase();
		const parts = cleaned.split(/\s+/).filter(Boolean);
		const firstLike = parts[0] ?? cleaned;
		const lastLike = parts.length > 1 ? parts[parts.length - 1] : "";

		const searchSql = lastLike
			? `SELECT id AS patient, first, last, birthdate, gender, race, ethnicity, income,
                ed_inpatient_total_cost, ed_visits, inpatient_visits,
                chronic_condition_count, has_active_careplan
         FROM patient_summary
         WHERE LOWER(first) LIKE '%${firstLike.replace(/'/g, "''")}%'
           AND LOWER(last) LIKE '%${lastLike.replace(/'/g, "''")}%'
         ORDER BY ed_inpatient_total_cost DESC
         LIMIT 3`
			: `SELECT id AS patient, first, last, birthdate, gender, race, ethnicity, income,
                ed_inpatient_total_cost, ed_visits, inpatient_visits,
                chronic_condition_count, has_active_careplan
         FROM patient_summary
         WHERE LOWER(first) LIKE '%${firstLike.replace(/'/g, "''")}%'
            OR LOWER(last) LIKE '%${firstLike.replace(/'/g, "''")}%'
         ORDER BY ed_inpatient_total_cost DESC
         LIMIT 3`;

		const search = await this.runQuery(searchSql);
		const matches = search.results ?? [];
		if (!search.success || matches.length === 0) {
			return {
				success: false,
				message: "No matching patient found for this credential.",
			};
		}

		return {
			success: true,
			message: "Patient context loaded.",
			patient: matches[0],
			alternatives: matches.slice(1),
		};
	}

	async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
		const workersai = createWorkersAI({ binding: this.env.AI });

		const result = streamText({
			model: workersai("@cf/moonshotai/kimi-k2.6", {
				sessionAffinity: this.sessionAffinity,
			}),
			system: `You are a healthcare data analyst helping care coordinators at a value-based primary care practice.

You have access to a database of synthetic patients. Use queryDatabase whenever you need patient data.

Rules:
- Only write SQL SELECT statements.
- Always include a LIMIT clause in SQL.
- Never show raw JSON; format results as tables or concise summaries.
- Use LIKE and LOWER for name matching.
- For authenticated sessions, call getPatientFullHistory before conclusions.
- Drill into encounters, medications, procedures, and financial transactions.
- Identify cost concentration and potentially avoidable utilization patterns.
- End with a plain-language care manager briefing and 2-3 follow-up questions.

${getSchedulePrompt({ date: new Date() })}
If the user asks to schedule a task, use the schedule tool.`,
			messages: pruneMessages({
				messages: inlineDataUrls(await convertToModelMessages(this.messages)),
				toolCalls: "before-last-2-messages",
			}),
			tools: {
				queryDatabase: tool({
					description: "Execute SQL SELECT against the healthcare dataset.",
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
			stopWhen: stepCountIs(6),
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
