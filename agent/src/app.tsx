import { useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ChatAgent } from "./server";

type ManagerScope = "specific_patient" | "administrative";

function scopePrefix(mode: ManagerScope, patientNameHint: string) {
	if (mode === "specific_patient") {
		const hint = patientNameHint.trim();
		return `[Manager scope: specific patient | patient name hint: ${hint}]\n\n`;
	}
	return "[Manager scope: population / administrative overview]\n\n";
}

function displayUserText(raw: string) {
	const strip = raw.replace(/^\[[\s\S]*?\]\n\n/, "").trim();
	return strip || raw.trim();
}

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
	const [managerScope, setManagerScope] = useState<ManagerScope>("administrative");
	const [patientNameHint, setPatientNameHint] = useState("");
	const [patientNameWarning, setPatientNameWarning] = useState("");

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

		if (managerScope === "specific_patient" && !patientNameHint.trim()) {
			setPatientNameWarning("Patient name needed for this mode.");
			return;
		}

		setPatientNameWarning("");
		setDraft("");
		const body =
			scopePrefix(managerScope, managerScope === "specific_patient" ? patientNameHint : "") + text;
		sendMessage({ role: "user", parts: [{ type: "text", text: body }] });
	}

	const sendBlockedNeedsName = managerScope === "specific_patient" && !patientNameHint.trim();
	const sendDisabled = !canChat || !draft.trim() || sendBlockedNeedsName;

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
					const shown = m.role === "user" ? displayUserText(raw) : raw;
					return (
						<div key={m.id} className={`bubble ${m.role === "user" ? "user" : "assistant"}`}>
							{shown}
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
				<details className="options-details" style={{ marginTop: 10 }}>
					<summary>Options</summary>
					<div className="mode-grid" style={{ marginTop: 8 }}>
						<button
							type="button"
							className={`mode-option ${managerScope === "specific_patient" ? "selected" : ""}`}
							onClick={() => {
								setManagerScope("specific_patient");
								setPatientNameWarning("");
							}}
							disabled={isStreaming}
						>
							<strong>One patient</strong>
							<span>Tag with name below</span>
						</button>
						<button
							type="button"
							className={`mode-option ${managerScope === "administrative" ? "selected" : ""}`}
							onClick={() => {
								setManagerScope("administrative");
								setPatientNameHint("");
								setPatientNameWarning("");
							}}
							disabled={isStreaming}
						>
							<strong>Population</strong>
							<span>Summary / cohort</span>
						</button>
					</div>
					{managerScope === "specific_patient" && (
						<div style={{ marginTop: 10 }}>
							<label
								className="muted"
								htmlFor="patient-hint"
								style={{ display: "block", marginBottom: 6 }}
							>
								Name
							</label>
							<input
								id="patient-hint"
								value={patientNameHint}
								onChange={(e) => {
									setPatientNameHint(e.target.value);
									setPatientNameWarning("");
								}}
								disabled={isStreaming}
								aria-invalid={Boolean(patientNameWarning)}
							/>
							{patientNameWarning ? <p className="form-warning">{patientNameWarning}</p> : null}
						</div>
					)}
				</details>
			</section>
		</main>
	);
}
