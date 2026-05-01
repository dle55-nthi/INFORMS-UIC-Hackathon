import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Dev-only proxy fallback if POST to Workers is blocked in your environment.
 * Use `.env.local`: VITE_QUERY_URL=/api/query
 */
export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/api/query": {
				target: "https://uic-hackathon-data.christian-7f4.workers.dev",
				changeOrigin: true,
				rewrite: () => "/query",
			},
		},
	},
});
