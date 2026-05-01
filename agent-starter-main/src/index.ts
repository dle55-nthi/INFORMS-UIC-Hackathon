/**
 * Worker bundle entry for Wrangler `main`.
 * - `ChatAgent` Durable Object → `./server`
 * - HTTP fetch (API + SPA asset fallback) → `./routes/workerFetch`
 */
export { ChatAgent } from "./server";
export { default } from "./routes/workerFetch";
