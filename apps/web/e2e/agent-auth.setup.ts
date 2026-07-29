import { randomUUID } from "node:crypto";

import { expect, test as setup } from "@playwright/test";

/**
 * One account for the whole agent suite. Signing up per test would spend the
 * server's `/sign-up/email` budget (5 per minute per IP) and turn a CI retry
 * into a 429 that hides the real failure. Written under `test-results/`, which
 * playwright clears per run and git ignores.
 */
const STORAGE_STATE = "test-results/.auth/agent.json";

setup("authenticate the agent suite's account", async ({ page }) => {
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Agent Suite");
  await page.getByLabel("Email").fill(`agent-${randomUUID()}@example.test`);
  await page.getByLabel("Password").fill("e2e-agent-password");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/app$/);

  await page.context().storageState({ path: STORAGE_STATE });
});
