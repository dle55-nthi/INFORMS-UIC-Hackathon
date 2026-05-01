import { scheduleSchema } from "agents/schedule";
import { tool } from "ai";
import { z } from "zod";

/**
 * Narrow scheduling surface from ChatAgent — swap implementations for tests without Workers.
 */
export interface ScheduleToolHost {
	schedule(
		when: unknown,
		methodName: string,
		description: string,
		opts?: { idempotent?: boolean }
	): void;
	getSchedules(): unknown[];
	cancelSchedule(taskId: string): void;
}

/** Demo + scheduling tools — extend here with more approval-gated or side-effect tools. */
export function buildExtraTools(host: ScheduleToolHost) {
	return {
		getWeather: tool({
			description: "Get the current weather for a city",
			inputSchema: z.object({
				city: z.string().describe("City name")
			}),
			execute: async ({ city }) => {
				const conditions = ["sunny", "cloudy", "rainy", "snowy"];
				const temp = Math.floor(Math.random() * 30) + 5;
				return {
					city,
					temperature: temp,
					condition: conditions[Math.floor(Math.random() * conditions.length)],
					unit: "celsius"
				};
			}
		}),

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
					host.schedule(input, "executeTask", description, {
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
				const tasks = host.getSchedules();
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
					host.cancelSchedule(taskId);
					return `Task ${taskId} cancelled.`;
				} catch (error) {
					return `Error cancelling task: ${error}`;
				}
			}
		})
	};
}
