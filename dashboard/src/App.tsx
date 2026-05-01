import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Bar,
	BarChart,
	CartesianGrid,
	Cell,
	Legend,
	ResponsiveContainer,
	Tooltip,
	XAxis,
	YAxis,
} from "recharts";
import { clampLimit, querySql } from "./queryApi";

type TopPatient = {
	first: string;
	last: string;
	ed_inpatient_total_cost: number;
	ed_visits: number;
	inpatient_visits: number;
	chronic_condition_count: number;
	has_active_careplan: number;
};

type CohortSummary = {
	patient_count: number;
	total_ed_visits: number;
	total_inpatient_visits: number;
	total_ed_inpatient_cost: number;
	total_all_encounter_cost: number;
};

type EncounterClassAgg = {
	ENCOUNTERCLASS: string;
	visit_count: number;
	cost_sum: number;
};

const money = new Intl.NumberFormat(undefined, {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 0,
});

function sqlTopPatients(limit: number): string {
	return `SELECT first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits,
  chronic_condition_count, has_active_careplan
FROM patient_summary
ORDER BY ed_inpatient_total_cost DESC
LIMIT ${limit}`;
}

const SQL_COHORT: string = `SELECT COUNT(*) AS patient_count,
  SUM(ed_visits) AS total_ed_visits,
  SUM(inpatient_visits) AS total_inpatient_visits,
  SUM(ed_inpatient_total_cost) AS total_ed_inpatient_cost,
  SUM(total_cost) AS total_all_encounter_cost
FROM patient_summary
LIMIT 500`;

const SQL_ENCOUNTER_CLASS: string = `SELECT ENCOUNTERCLASS,
  COUNT(*) AS visit_count,
  ROUND(SUM(TOTAL_CLAIM_COST), 2) AS cost_sum
FROM encounters
WHERE ENCOUNTERCLASS IN ('emergency', 'inpatient')
GROUP BY ENCOUNTERCLASS
LIMIT 500`;

export default function App() {
	const [limit, setLimit] = useState(10);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [top, setTop] = useState<TopPatient[]>([]);
	const [summary, setSummary] = useState<CohortSummary | null>(null);
	const [byClass, setByClass] = useState<EncounterClassAgg[]>([]);

	const load = useCallback(async () => {
		const n = clampLimit(limit, 1, 50);
		setLoading(true);
		setError(null);
		try {
			const [rows, sums, encounterAgg] = await Promise.all([
				querySql<TopPatient>(sqlTopPatients(n)),
				querySql<CohortSummary>(SQL_COHORT),
				querySql<EncounterClassAgg>(SQL_ENCOUNTER_CLASS),
			]);
			setTop(rows);
			setSummary(sums[0] ?? null);
			setByClass(encounterAgg);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setTop([]);
			setSummary(null);
			setByClass([]);
		} finally {
			setLoading(false);
		}
	}, [limit]);

	useEffect(() => {
		void load();
	}, [load]);

	const barData = useMemo(
		() =>
			top.map((p) => ({
				name: `${p.first} ${p.last}`.slice(0, 28),
				cost: p.ed_inpatient_total_cost ?? 0,
				ed: p.ed_visits ?? 0,
				ip: p.inpatient_visits ?? 0,
			})),
		[top],
	);

	const utilBars = useMemo(() => {
		if (!summary) return [];
		return [
			{ kind: "ED visits", count: summary.total_ed_visits },
			{ kind: "Inpatient admits", count: summary.total_inpatient_visits },
		];
	}, [summary]);

	const utilColors = ["#0284c7", "#7c3aed"];

	const costByClass = useMemo(
		() =>
			byClass.map((r) => ({
				label: r.ENCOUNTERCLASS === "emergency" ? "ED" : "Inpatient",
				cost: r.cost_sum ?? 0,
				visits: r.visit_count ?? 0,
			})),
		[byClass],
	);

	return (
		<>
			<p className="kicker">UIC INFORMS — live patient_summary API</p>
			<h1>ED &amp; inpatient utilization dashboard</h1>
			<p className="sub">
				Data loads via POST to the hackathon SQL worker (SELECT only). Claims use{" "}
				<code>PATIENTID</code>; this view aligns with{" "}
				<code>patient_summary.id</code>.
			</p>

			<div className="panel">
				<div className="controls">
					<label>
						<span>Top patients (N)</span>
						<input
							type="range"
							min={1}
							max={50}
							value={limit}
							onChange={(e) => setLimit(Number(e.target.value))}
							aria-label="Top N patients by ED+inpatient cost"
						/>
						<strong>{clampLimit(limit, 1, 50)}</strong>
					</label>
					<button
						type="button"
						onClick={() => void load()}
						style={{
							padding: "0.35rem 0.75rem",
							borderRadius: "8px",
							border: "1px solid #cbd5e1",
							background: "#fff",
							cursor: "pointer",
							fontSize: "0.85rem",
						}}
					>
						Refresh
					</button>
				</div>
				{loading && <p className="loading">Loading…</p>}
				{error && (
					<div className="err" role="alert">
						{error}
					</div>
				)}
			</div>

			<section className="panel">
				<h2>Cohort summary (all {summary?.patient_count ?? "—"} patients)</h2>
				{summary && (
					<>
						<div className="grid-stats">
							<div className="stat">
								<div className="v">{summary.total_ed_visits}</div>
								<div className="k">ED visits</div>
							</div>
							<div className="stat">
								<div className="v">{summary.total_inpatient_visits}</div>
								<div className="k">Inpatient admits</div>
							</div>
							<div className="stat">
								<div className="v">
									{money.format(summary.total_ed_inpatient_cost)}
								</div>
								<div className="k">ED + IP encounter cost</div>
							</div>
							<div className="stat">
								<div className="v">
									{money.format(summary.total_all_encounter_cost)}
								</div>
								<div className="k">All encounter cost</div>
							</div>
						</div>
						<h2 style={{ marginTop: "1rem" }}>
							Visit counts across cohort (bars)
						</h2>
						<div className="chart-wrap small">
							<ResponsiveContainer width="100%" height="100%">
								<BarChart data={utilBars} margin={{ left: 8, right: 8 }}>
									<CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
									<XAxis dataKey="kind" tick={{ fontSize: 11 }} />
									<YAxis tick={{ fontSize: 11 }} />
									<Tooltip />
									<Bar dataKey="count" radius={[6, 6, 0, 0]} name="Visits">
										{utilBars.map((_, i) => (
											<Cell
												key={`c-${i}-${utilBars[i]?.kind ?? i}`}
												fill={utilColors[i] ?? "#64748b"}
											/>
										))}
									</Bar>
								</BarChart>
							</ResponsiveContainer>
						</div>
						<h2 style={{ marginTop: "1rem" }}>
							Encounters: ED vs inpatient (claim cost)
						</h2>
						<p className="sub" style={{ margin: "0 0 0.5rem" }}>
							From <code>encounters</code> where class is emergency or inpatient.
						</p>
						<div className="chart-wrap small">
							<ResponsiveContainer width="100%" height="100%">
								<BarChart data={costByClass} margin={{ left: 8, right: 8 }}>
									<CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
									<XAxis dataKey="label" tick={{ fontSize: 11 }} />
									<YAxis
										tick={{ fontSize: 11 }}
										tickFormatter={(v) =>
											v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${v}`
										}
									/>
									<Tooltip
										formatter={(value: number) => money.format(value)}
									/>
									<Legend />
									<Bar
										dataKey="cost"
										fill="#0d9488"
										name="Encounter cost"
										radius={[6, 6, 0, 0]}
									/>
								</BarChart>
							</ResponsiveContainer>
						</div>
					</>
				)}
			</section>

			<section className="panel">
				<h2>
					Top {clampLimit(limit, 1, 50)} by{" "}
					<code>ed_inpatient_total_cost</code>
				</h2>
				<div className="chart-wrap">
					<ResponsiveContainer width="100%" height="100%">
						<BarChart
							data={barData}
							layout="vertical"
							margin={{ left: 8, right: 16, top: 8, bottom: 8 }}
						>
							<CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
							<XAxis
								type="number"
								tick={{ fontSize: 10 }}
								tickFormatter={(v) =>
									v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${v / 1000}k`
								}
							/>
							<YAxis
								type="category"
								dataKey="name"
								width={120}
								tick={{ fontSize: 9 }}
							/>
							<Tooltip
								formatter={(value: number) => money.format(value)}
								labelFormatter={(_, p) => {
									const row = p?.[0]?.payload as
										| { ed: number; ip: number }
										| undefined;
									return row
										? `ED: ${row.ed} · Inpatient: ${row.ip}`
										: "";
								}}
							/>
							<Bar dataKey="cost" fill="#2563eb" name="ED+IP cost" />
						</BarChart>
					</ResponsiveContainer>
				</div>
				<table>
					<thead>
						<tr>
							<th>Patient</th>
							<th>ED+IP cost</th>
							<th>ED</th>
							<th>IP</th>
							<th>Chronic</th>
							<th>Care plan</th>
						</tr>
					</thead>
					<tbody>
						{top.map((p) => (
							<tr key={`${p.first}-${p.last}-${p.ed_inpatient_total_cost}`}>
								<td>
									{p.first} {p.last}
								</td>
								<td>{money.format(p.ed_inpatient_total_cost)}</td>
								<td>{p.ed_visits}</td>
								<td>{p.inpatient_visits}</td>
								<td>{p.chronic_condition_count}</td>
								<td>{p.has_active_careplan ? "Yes" : "No"}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>

			<p className="note footer">
				Example SQL in <code>src/App.tsx</code> — adjust LIMIT via the slider; all
				queries include explicit LIMIT for the API cap.{" "}
				<span style={{ opacity: 0.9 }}>
					In the conversational agent demo, use prompts (and Coordinator focus
					where available) to steer analysis angles — see repository README.
				</span>
			</p>
		</>
	);
}
