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

/** Same text the model sees; UI hides the scope banner for readability. */
function displayUserText(raw: string) {
	const strip = raw.replace(/^\[[\s\S]*?\]\n\n/, "").trim();
	return strip || raw.trim();
}

export default function App() {
	const [draft, setDraft] = useState("");
	const [managerScope, setManagerScope] = useState<ManagerScope | null>(null);
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
		if (!text || !canChat || managerScope === null) return;

		if (managerScope === "specific_patient" && !patientNameHint.trim()) {
			setPatientNameWarning(
				"Please enter a patient name above (partial match is fine so we pull the right record).",
			);
			return;
		}

		setPatientNameWarning("");
		setDraft("");
		const body =
			scopePrefix(managerScope, managerScope === "specific_patient" ? patientNameHint : "") + text;
		sendMessage({ role: "user", parts: [{ type: "text", text: body }] });
	}

	const patientNameMissing = managerScope === "specific_patient" && !patientNameHint.trim();
	const sendDisabled = !canChat || managerScope === null || !draft.trim() || patientNameMissing;

	return (
		<main className="app">
			<h2>Cost Explainer Agent</h2>
			<p className="muted">
				Pick how you&apos;re working first—scope is bundled with each message so the analyst stays
				aligned.
			</p>

			<section className="card mode-section" style={{ marginBottom: 12 }}>
				<h3>How are you working today?</h3>
				<div className="mode-grid">
					<button
						type="button"
						className={`mode-option ${managerScope === "specific_patient" ? "selected" : ""}`}
						onClick={() => {
							setManagerScope("specific_patient");
							setPatientNameWarning("");
						}}
						disabled={isStreaming}
					>
						<strong>Specific patient</strong>
						<span>Deep-dive one person—cost drivers, encounters, meds, claims.</span>
					</button>
					<button
						type="button"
						className={`mode-option ${managerScope === "administrative" ? "selected" : ""}`}
						onClick={() => {
							setManagerScope("administrative");
							setPatientNameWarning("");
						}}
						disabled={isStreaming}
					>
						<strong>Overall / admin</strong>
						<span>Population view—rankings, cohorts, patterns across patients.</span>
					</button>
				</div>
				{managerScope === "specific_patient" && (
					<div style={{ marginTop: 12 }}>
						{!patientNameHint.trim() ? (
							<p className="patient-followup-prompt" style={{ marginBottom: 10 }}>
								<strong>Please enter a patient name</strong>
								<span className="muted" style={{ display: "block", fontWeight: 400, marginTop: 4 }}>
									We need who you mean before pulling records (partial match is fine).
								</span>
							</p>
						) : null}
						<label
							className="muted"
							htmlFor="patient-hint"
							style={{ display: "block", marginBottom: 6 }}
						>
							Patient name <span style={{ color: "#b91c1c" }}>(required)</span>
						</label>
						<input
							id="patient-hint"
							placeholder="e.g. Lindsay Brekke or Giovanni385 Paucek755"
							value={patientNameHint}
							onChange={(e) => {
								setPatientNameHint(e.target.value);
								setPatientNameWarning("");
							}}
							disabled={isStreaming}
							aria-invalid={Boolean(patientNameWarning)}
							aria-describedby={
								managerScope === "specific_patient" ? "patient-hint-help" : undefined
							}
						/>
						<p id="patient-hint-help" className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
							Enter who you mean first. Names in this dataset often include numeric suffixes—partial
							matches work.
						</p>
						{patientNameWarning ? <p className="form-warning">{patientNameWarning}</p> : null}
					</div>
				)}
				{managerScope && (
					<p className="scope-hint muted">
						Selected:{" "}
						<strong style={{ color: "#0f172a" }}>
							{managerScope === "specific_patient" ? "Specific patient" : "Administrative overview"}
						</strong>
						. You can change this anytime; the next message carries the new scope.
					</p>
				)}
			</section>

			<section className="card messages">
				{sortedMessages.length === 0 && (
					<p className="muted" style={{ margin: 0 }}>
						{managerScope === "specific_patient"
							? "Enter the patient’s name in the field above, then describe what you want from their data in the box below."
							: managerScope === "administrative"
								? "Ask a population question—e.g. top spenders, high ED utilizers, or patients without care plans."
								: "Choose a work mode above to get started."}
					</p>
				)}
				{sortedMessages.map((m) => {
					const text = m.parts
						.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
						.map((p) => p.text)
						.join("\n");
					if (!text) return null;
					const shown = m.role === "user" ? displayUserText(text) : text;
					return (
						<div key={m.id} className={`bubble ${m.role === "user" ? "user" : "assistant"}`}>
							{shown}
						</div>
					);
				})}
			</section>

			<section className="card" style={{ marginTop: 12 }}>
				{managerScope === "specific_patient" && patientNameHint.trim() ? (
					<p className="patient-followup-prompt">
						<strong>What do they want from that person&apos;s data?</strong>
					</p>
				) : managerScope === "specific_patient" ? (
					<p className="patient-followup-prompt muted">
						Enter a patient name in the section above first.
					</p>
				) : null}
				<div className="row">
					<textarea
						rows={2}
						placeholder={
							managerScope === null
								? "Select a work mode above to enable sending…"
								: managerScope === "specific_patient"
									? patientNameHint.trim()
										? "e.g. Explain ED/inpatient cost drivers, list active conditions, or flag reducible spend…"
										: "Available after you enter a patient name…"
									: "Ask for rankings, aggregates, cohorts, or practice-wide patterns…"
						}
						disabled={isStreaming || managerScope === null || patientNameMissing}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
					<button onClick={send} disabled={sendDisabled}>
						Send
					</button>
				</div>
			</section>
		</main>
	);
}
