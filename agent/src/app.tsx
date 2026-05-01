import { useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { ChatAgent } from "./server";

type AuthPatient = {
	patient: string;
	first: string;
	last: string;
	ed_inpatient_total_cost?: number;
};

export default function App() {
	const [fullName, setFullName] = useState("");
	const [credentialError, setCredentialError] = useState("");
	const [credentialLoading, setCredentialLoading] = useState(false);
	const [patient, setPatient] = useState<AuthPatient | null>(null);
	const [draft, setDraft] = useState("");

	const agent = useAgent<ChatAgent>({ agent: "ChatAgent" });
	const { messages, sendMessage, status } = useAgentChat({ agent });

	const isStreaming = status === "streaming" || status === "submitted";
	const canChat = !isStreaming;

	const sortedMessages = useMemo(
		() => messages.filter((m) => m.role === "user" || m.role === "assistant"),
		[messages],
	);

	async function loadPatientContext() {
		if (!fullName.trim()) return;
		setCredentialError("");
		setCredentialLoading(true);
		try {
			const result = (await agent.stub.resolvePatientCredential(fullName)) as {
				success?: boolean;
				message?: string;
				patient?: AuthPatient;
			};
			if (!result.success || !result.patient) {
				setPatient(null);
				setCredentialError(result.message ?? "Unable to load context for this credential.");
				return;
			}
			setPatient(result.patient);
			sendMessage({
				role: "user",
				parts: [
					{
						type: "text",
						text:
							`Patient context selected: ${result.patient.first} ${result.patient.last}\n` +
							`PATIENT ID: ${result.patient.patient}\n` +
							"Use this patient as the default context. Retrieve full history and explain cost drivers in plain language.",
					},
				],
			});
		} catch {
			setCredentialError("Could not load patient context. Please try again.");
		} finally {
			setCredentialLoading(false);
		}
	}

	function send() {
		const text = draft.trim();
		if (!text || !canChat) return;
		setDraft("");
		sendMessage({ role: "user", parts: [{ type: "text", text }] });
	}

	return (
		<main className="app">
			<h2>Cost Explainer Agent</h2>
			<p className="muted">
				Manager workflow: provide a patient credential (full name), then the agent fetches relevant
				history for analysis.
			</p>

			<section className="card" style={{ marginBottom: 12 }}>
				<div className="row">
					<input
						placeholder="Enter patient credential (full name)"
						value={fullName}
						onChange={(e) => setFullName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void loadPatientContext();
						}}
					/>
					<button onClick={() => void loadPatientContext()} disabled={credentialLoading}>
						{credentialLoading ? "Loading..." : "Load Context"}
					</button>
				</div>
				{credentialError && <p style={{ color: "#b91c1c" }}>{credentialError}</p>}
				{patient && (
					<div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
						<div>
							<strong>
								Context: {patient.first} {patient.last}
							</strong>
							<div className="muted">
								ID: {patient.patient} | ED/Inpatient Cost: $
								{Number(patient.ed_inpatient_total_cost ?? 0).toLocaleString()}
							</div>
						</div>
						<button
							onClick={() => {
								setPatient(null);
								setCredentialError("");
							}}
						>
							Clear Context
						</button>
					</div>
				)}
			</section>

			<section className="card messages">
				{sortedMessages.length === 0 && (
					<p className="muted">
						Enter a credential above, then ask: "Why is this patient expensive?"
					</p>
				)}
				{sortedMessages.map((m) => {
					const text = m.parts
						.filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
						.map((p) => p.text)
						.join("\n");
					if (!text) return null;
					return (
						<div key={m.id} className={`bubble ${m.role === "user" ? "user" : "assistant"}`}>
							{text}
						</div>
					);
				})}
			</section>

			<section className="card" style={{ marginTop: 12 }}>
				<div className="row">
					<textarea
						rows={2}
						placeholder={
							patient
								? "Ask about cost drivers, avoidable patterns, and next actions..."
								: "The agent will ask for a patient credential if context is missing"
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
					<button onClick={send} disabled={!canChat || !draft.trim()}>
						Send
					</button>
				</div>
			</section>
		</main>
	);
}
