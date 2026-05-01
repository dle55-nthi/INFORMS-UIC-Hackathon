import { tool } from "ai";
import { z } from "zod";
import { queryDataset } from "../lib/queryDataset";

/**
 * Data-access tools only — no agent `this`. Add new SQL-backed tools here.
 */
export function buildDatasetTools() {
	return {
		queryDatabase: tool({
			description:
				"Execute a SQL SELECT against the healthcare dataset for claim history, costs, encounters, meds, conditions, etc. " +
				"For dollar and claim-line investigation use claims_transactions joined via PATIENTID; for rollups compare with patient_summary. " +
				"IMPORTANT: claims_transactions joins on PATIENTID, not PATIENT.",
			inputSchema: z.object({
				sql: z
					.string()
					.describe(
						"A valid SQL SELECT statement. Always include a LIMIT clause."
					)
			}),
			execute: async ({ sql }) => (await queryDataset(sql)) as object
		}),

		getPatientFullHistory: tool({
			description:
				"Load one patient's clinical, encounter, and claim-line history in one call (includes recent claims_transactions rows). " +
				"Use after resolving the patient's ID from patient_summary for a briefing or deep dive.",
			inputSchema: z.object({
				patientId: z
					.string()
					.describe("PATIENT identifier from patient_summary")
			}),
			execute: async ({ patientId }) => {
				const escaped = patientId.replace(/'/g, "''");

				const [
					summary,
					conditions,
					medications,
					encounters,
					observations,
					procedures,
					claims
				] = await Promise.all([
					queryDataset(
						`SELECT *
                   FROM patient_summary
                   WHERE id = '${escaped}'
                   LIMIT 1`
					),
					queryDataset(
						`SELECT description, category, start, stop
                   FROM conditions
                   WHERE patient = '${escaped}'
                   ORDER BY CASE WHEN stop IS NULL THEN 0 ELSE 1 END, start DESC
                   LIMIT 30`
					),
					queryDataset(
						`SELECT description, start, stop, reasondescription
                   FROM medications
                   WHERE patient = '${escaped}'
                   ORDER BY CASE WHEN stop IS NULL THEN 0 ELSE 1 END, start DESC
                   LIMIT 30`
					),
					queryDataset(
						`SELECT start, stop, encounterclass, description, base_encounter_cost, payer_coverage, total_claim_cost
                   FROM encounters
                   WHERE patient = '${escaped}'
                   ORDER BY start DESC
                   LIMIT 40`
					),
					queryDataset(
						`SELECT date, category, description, value, units
                   FROM observations
                   WHERE patient = '${escaped}'
                   ORDER BY date DESC
                   LIMIT 40`
					),
					queryDataset(
						`SELECT start, stop, description, base_cost, reasondescription
                   FROM procedures
                   WHERE patient = '${escaped}'
                   ORDER BY start DESC
                   LIMIT 30`
					),
					queryDataset(
						`SELECT type, amount, payments, adjustments, transfers, outstanding, fromdate, todate, placeofservice, procedurecode
                   FROM claims_transactions
                   WHERE patientid = '${escaped}'
                   ORDER BY fromdate DESC
                   LIMIT 40`
					)
				]);

				return {
					patientId,
					patient_summary: summary.results ?? [],
					conditions: conditions.results ?? [],
					medications: medications.results ?? [],
					encounters: encounters.results ?? [],
					observations: observations.results ?? [],
					procedures: procedures.results ?? [],
					financial_transactions: claims.results ?? []
				} as object;
			}
		}),

		findPatientCandidates: tool({
			description:
				"Find likely patient matches from a human-entered name for claims/cost investigations. " +
				"Use first when discussing a specific person before drilling into claims and drivers.",
			inputSchema: z.object({
				name: z.string().describe("Patient name text like 'Giovanni Paucek'"),
				limit: z
					.number()
					.int()
					.min(1)
					.max(20)
					.default(5)
					.describe("Max matches to return")
			}),
			execute: async ({ name, limit }) => {
				const cleaned = name.trim().toLowerCase();
				const parts = cleaned.split(/\s+/).filter(Boolean);
				const firstLike = parts[0] ?? cleaned;
				const lastLike = parts.length > 1 ? parts[parts.length - 1] : "";

				const sql = lastLike
					? `SELECT id AS patient, first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits, chronic_condition_count, has_active_careplan
                 FROM patient_summary
                 WHERE LOWER(first) LIKE '%${firstLike.replace(/'/g, "''")}%'
                   AND LOWER(last) LIKE '%${lastLike.replace(/'/g, "''")}%'
                 ORDER BY ed_inpatient_total_cost DESC
                 LIMIT ${limit}`
					: `SELECT id AS patient, first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits, chronic_condition_count, has_active_careplan
                 FROM patient_summary
                 WHERE LOWER(first) LIKE '%${firstLike.replace(/'/g, "''")}%'
                    OR LOWER(last) LIKE '%${firstLike.replace(/'/g, "''")}%'
                 ORDER BY ed_inpatient_total_cost DESC
                 LIMIT ${limit}`;

				return (await queryDataset(sql)) as object;
			}
		})
	};
}
