import { useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ChatAgent } from "./server";

function messageText(m: { parts: unknown[] }) {
	let s = "";
	for (const p of m.parts) {
		if (
			typeof p === "object" &&
			p !== null &&
			"type" in p &&
			(p as { type: string }).type === "text"
		) {
			const t = (p as { text?: string }).text;
			s += `${t ?? ""}\n`;
		}
	}
	return s.trim();
}

export default function App() {
	const [draft, setDraft] = useState("");

	const agent = useAgent<ChatAgent>({ agent: "ChatAgent" });
	const { messages, sendMessage, status } = useAgentChat({ agent });

	const isStreaming = status === "streaming" || status === "submitted";
	const canChat = !isStreaming;

	const sortedMessages = useMemo(
		() => messages.filter((m) => m.role === "user" || m.role === "assistant"),
		[messages],
	);

	function send() {
		const text = draft.trim();
		if (!text || !canChat) return;
		setDraft("");
		sendMessage({ role: "user", parts: [{ type: "text", text }] });
	}

	const sendDisabled = !canChat || !draft.trim();

	const last = sortedMessages[sortedMessages.length - 1];
	const lastBubbleEmptyAssistant = last?.role === "assistant" && !messageText(last);
	const showWorking =
		isStreaming &&
		(sortedMessages.length === 0 || last?.role === "user" || lastBubbleEmptyAssistant);

	return (
		<main className="app">
			<h2 style={{ marginTop: 0 }}>Care cost assistant</h2>

			<section className="card messages">
				{sortedMessages.map((m) => {
					const raw = messageText(m);
					if (!raw && m.role === "assistant" && showWorking) return null;
					if (!raw) return null;
					return (
						<div key={m.id} className={`bubble ${m.role === "user" ? "user" : "assistant"}`}>
							{raw}
						</div>
					);
				})}
				{showWorking ? (
					<div className="working-placeholder" aria-live="polite">
						Working…
					</div>
				) : null}
			</section>

			<section className="card" style={{ marginTop: 12 }}>
				<div className="row">
					<textarea
						rows={2}
						placeholder={isStreaming ? "" : "Ask"}
						disabled={isStreaming}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
					<button type="button" onClick={send} disabled={sendDisabled}>
						Send
					</button>
				</div>
			</section>
		</main>
	);
}
