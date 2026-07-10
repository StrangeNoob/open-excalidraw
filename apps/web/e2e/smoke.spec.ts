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

  await expect(page.getByText("Local only")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create account" }),
  ).toBeVisible();
  expect(apiRequests).toEqual([]);
});
