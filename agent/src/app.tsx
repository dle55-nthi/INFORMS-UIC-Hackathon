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

	const sendBlockedNeedsName = managerScope === "specific_patient" && !patientNameHint.trim();
	const sendDisabled = !canChat || !draft.trim() || sendBlockedNeedsName;

	return (
		<main className="app">
			<h2>Cost Explainer Agent</h2>
			<p className="muted">
				The assistant searches <strong>patient_summary</strong>, can compare several patients, pulls
				full history when needed, then answers follow-up questions in the same chat.
			</p>

			<section className="card messages">
				{sortedMessages.length === 0 && (
					<p className="muted" style={{ margin: 0 }}>
						Try &quot;Find patients with Brekke in the name&quot;, &quot;top 10 ED + inpatient
						costs&quot;, or &quot;compare two patients by ID&quot;—then ask deeper questions in the
						same thread.
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
				) : null}
				<div className="row">
					<textarea
						rows={2}
						placeholder={
							managerScope === "specific_patient"
								? patientNameHint.trim()
									? "e.g. Explain ED/inpatient cost drivers, list active conditions, or flag reducible spend…"
									: "Draft your question here—add their name under Optional scope, then Send."
								: "Ask about costs, utilization, cohorts… or mention a patient by name."
						}
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
					<button onClick={send} disabled={sendDisabled}>
						Send
					</button>
				</div>
			</section>

			<section className="card mode-section" style={{ marginTop: 12 }}>
				<h3>Optional scope</h3>
				<p className="muted" style={{ margin: "0 0 10px", fontSize: 13 }}>
					Defaults to <strong>overall / admin</strong>. Pick <strong>specific patient</strong> when
					you want every message tagged with one person&apos;s name.
				</p>
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
						<span>Tag messages with one patient&apos;s name (field below).</span>
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
						<strong>Overall / admin</strong>
						<span>Population summaries—no patient name gate.</span>
					</button>
				</div>
				{managerScope === "specific_patient" && (
					<div style={{ marginTop: 12 }}>
						{!patientNameHint.trim() ? (
							<p className="patient-followup-prompt" style={{ marginBottom: 10 }}>
								<strong>Please enter a patient name</strong>
								<span className="muted" style={{ display: "block", fontWeight: 400, marginTop: 4 }}>
									Needed only while &quot;Specific patient&quot; is selected—partial matches are
									fine.
								</span>
							</p>
						) : null}
						<label
							className="muted"
							htmlFor="patient-hint"
							style={{ display: "block", marginBottom: 6 }}
						>
							Patient name <span style={{ color: "#b91c1c" }}>(required in this mode)</span>
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
							aria-describedby="patient-hint-help"
						/>
						<p id="patient-hint-help" className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>
							Names often include numeric suffixes in this dataset.
						</p>
						{patientNameWarning ? <p className="form-warning">{patientNameWarning}</p> : null}
					</div>
				)}
				<p className="scope-hint muted">
					Selected:{" "}
					<strong style={{ color: "#0f172a" }}>
						{managerScope === "specific_patient" ? "Specific patient" : "Administrative overview"}
					</strong>
					. Change anytime; scope applies to your next Send.
				</p>
			</section>
		</main>
	);
}
