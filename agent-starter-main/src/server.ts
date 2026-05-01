import { createWorkersAI } from "workers-ai-provider";
import { callable, type Schedule } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
	convertToModelMessages,
	pruneMessages,
	stepCountIs,
	streamText
} from "ai";
import { inlineDataUrls } from "./lib/messageUtils";
import { buildChatSystemPrompt } from "./prompts/chatSystem";
import { buildDatasetTools } from "./tools/datasetTools";
import { buildExtraTools } from "./tools/extraTools";

export class ChatAgent extends AIChatAgent<Env> {
	maxPersistedMessages = 100;

	onStart() {
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

		const datasetTools = buildDatasetTools();
		const extraTools = buildExtraTools(this);

		const result = streamText({
			model: workersai("@cf/moonshotai/kimi-k2.6", {
				sessionAffinity: this.sessionAffinity
			}),
			system: buildChatSystemPrompt(),
			messages: pruneMessages({
				messages: inlineDataUrls(await convertToModelMessages(this.messages)),
				toolCalls: "before-last-2-messages"
			}),
			tools: {
				...mcpTools,
				...datasetTools,
				...extraTools
			},
			stopWhen: stepCountIs(5),
			abortSignal: options?.abortSignal
		});

		return result.toUIMessageStreamResponse();
	}

	async executeTask(description: string, _task: Schedule<string>) {
		console.log(`Executing scheduled task: ${description}`);

		this.broadcast(
			JSON.stringify({
				type: "scheduled-task",
				description,
				timestamp: new Date().toISOString()
			})
		);
	}
}
