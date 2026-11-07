import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	cloudflareTest,
	readD1Migrations,
} from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrationsPath = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"migrations",
);

export default defineConfig({
	plugins: [
		cloudflareTest(async () => {
			const migrations = await readD1Migrations(migrationsPath);
			return {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: { TEST_MIGRATIONS: migrations },
				},
			};
		}),
	],
	test: {
		setupFiles: ["./test/apply-migrations.ts"],
	},
});
