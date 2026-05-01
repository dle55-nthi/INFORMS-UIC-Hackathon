# UIC Hackathon — patient utilization dashboard

Small **React + Vite** SPA that calls the live hackathon SQL API (`SELECT` only) and shows **top patients by `ed_inpatient_total_cost`**, **cohort ED vs inpatient utilization**, and **encounter-level ED vs inpatient costs** from `encounters`.

## Prereqs

- Node 20+ recommended

## Run locally

```bash
cd dashboard
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

## Build

```bash
npm run build
```

Preview production output: `npm run preview`.

## Data & SQL

- Schema: `../data/schema.sql` — start from `patient_summary`.
- Dictionary: `../docs/data_dictionary.md`.
- Join note: `claims_transactions.PATIENTID` joins to patient id; other tables use `PATIENT` = `patient_summary.id`.

## CORS & `VITE_QUERY_URL`

A preflight check returns `access-control-allow-origin: *`, so the app **POSTs directly** to the worker by default.

If POST is blocked in your environment, copy `.env.example` to `.env.local` and set:

```bash
VITE_QUERY_URL=/api/query
```

The dev server proxies `/api/query` to the hackathon endpoint (see `vite.config.ts`). For production you would host a similar proxy or rely on open CORS.

No API keys or secrets.

## Example queries (also in `src/App.tsx`)

Top N by ED+inpatient cost:

```sql
SELECT first, last, ed_inpatient_total_cost, ed_visits, inpatient_visits
FROM patient_summary
ORDER BY ed_inpatient_total_cost DESC
LIMIT 10;
```

Cohort rollups:

```sql
SELECT COUNT(*) AS patient_count,
  SUM(ed_visits) AS total_ed_visits,
  SUM(inpatient_visits) AS total_inpatient_visits,
  SUM(ed_inpatient_total_cost) AS total_ed_inpatient_cost
FROM patient_summary
LIMIT 500;
```
