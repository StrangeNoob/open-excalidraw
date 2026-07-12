import { expect, test } from "@playwright/test";

test("loads the editor's fonts from this origin, never a CDN", async ({
  page,
}) => {
  const externalFonts: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      /\.(woff2?|ttf|otf)$/i.test(url.pathname) &&
      url.origin !== new URL(page.url() || "http://127.0.0.1:5173").origin
    ) {
      externalFonts.push(request.url());
    }
  });

  await page.goto("/");
  await expect(page.getByText(/saved on this device only/i)).toBeVisible();

  // Without this, Excalidraw falls back to a public CDN that the production
  // CSP blocks, and the canvas silently renders in a substitute face.
  await expect
    .poll(() => page.evaluate(() => window.EXCALIDRAW_ASSET_PATH))
    .toBe("/");
  await expect
    .poll(() => page.evaluate(() => document.fonts.check("20px Excalifont")))
    .toBe(true);
  expect(externalFonts).toEqual([]);
});

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
