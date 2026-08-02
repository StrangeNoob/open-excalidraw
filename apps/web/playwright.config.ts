import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineConfig, devices } from "@playwright/test";

const webOrigin = "http://127.0.0.1:5173";
// Port 3000 is commonly taken by another dev server; keep the e2e API off it.
const apiPort = process.env.E2E_API_PORT ?? "3100";
const apiOrigin = `http://127.0.0.1:${apiPort}`;
// Its own database: the suite migrates on boot and leaves its users, drawings
// and tokens behind, which has no business happening in the dev database.
const databaseUrl =
  process.env.E2E_DATABASE_URL ??
  "postgresql://localhost:5432/open_excalidraw_e2e";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: webOrigin,
    trace: "on-first-retry",
  },
  projects: [
    // Signs the agent suite in once; only that spec opts into the state.
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
  ],
  webServer: [
    {
      // The agent suite writes through the real REST API, so e2e needs a real
      // server and a current schema — migrations are manual in this repo.
      command:
        "pnpm --filter @open-excalidraw/database db:migrate && pnpm --filter @open-excalidraw/server exec tsx src/server.ts",
      url: `${apiOrigin}/health/ready`,
      reuseExistingServer: !process.env.CI,
      // Migrating a cold CI database before the server boots outruns the
      // 60s default.
      timeout: 120_000,
      env: {
        // The browser reaches the API through vite's proxy, so the app's
        // public origin — and every cookie and CORS decision — is vite's.
        APP_BASE_URL: webOrigin,
        APP_PORT: apiPort,
        ADMIN_RESET_TOKEN: "e2e-admin-reset-token-000000000000",
        BETTER_AUTH_SECRET: "e2e-better-auth-secret-00000000000",
        DATABASE_URL: databaseUrl,
        // Present-but-empty beats absent: this server also loads the repo-root
        // .env, which may configure a real SMTP host, and e2e sends no mail.
        SMTP_HOST: "",
        STORAGE_DRIVER: "local",
        STORAGE_LOCAL_PATH: join(tmpdir(), "open-excalidraw-e2e-uploads"),
      },
    },
    {
      command: "pnpm exec vite --host 127.0.0.1",
      url: webOrigin,
      reuseExistingServer: !process.env.CI,
      env: { API_PROXY_TARGET: apiOrigin },
    },
  ],
});
