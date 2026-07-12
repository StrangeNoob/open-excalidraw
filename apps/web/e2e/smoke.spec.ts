import { expect, test } from "@playwright/test";

test("renders the application shell", async ({ page }) => {
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/")) {
      apiRequests.push(request.url());
    }
  });
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        capabilities: {
          emailPassword: true,
          github: false,
          google: false,
          smtp: false,
        },
        user: null,
      }),
    }),
  );
  await page.goto("/");

  // The guest canvas states its local-only nature and offers account actions
  // through Excalidraw's own welcome screen and top-right UI. "Sign in"
  // appears in both, so each assertion is scoped to one of them.
  await expect(page.getByText(/saved on this device only/i)).toBeVisible();
  const accountActions = page.locator(".canvas-top-right");
  await expect(
    accountActions.getByRole("button", { name: "Create account" }),
  ).toBeVisible();
  await expect(
    accountActions.getByRole("button", { name: "Sign in" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create an account" }),
  ).toBeVisible();
  expect(apiRequests).toEqual([]);
});
