import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				// Use inline miniflare config instead of wrangler.jsonc so that
				// the remote-only AI binding does not trigger a remote proxy session.
				// Tests mock env.AI and env.ASSETS directly, so no real bindings are needed.
				miniflare: {
					compatibilityDate: "2025-10-08",
					compatibilityFlags: ["nodejs_compat"],
				},
			},
		},
	},
});
