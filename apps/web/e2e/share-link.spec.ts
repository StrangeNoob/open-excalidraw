import { expect, test } from "@playwright/test";

const TOKEN = "s".repeat(43);

test("opens a shared drawing read-only without an account", async ({
  page,
}) => {
  await page.route(`**/api/v1/share/${TOKEN}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        drawingId: "00000000-0000-4000-8000-000000000001",
        title: "Roadmap sketch",
        revision: "7",
        scene: {
          type: "excalidraw",
          version: 2,
          source: "e2e",
          elements: [
            {
              id: "rect-1",
              type: "rectangle",
              x: 10,
              y: 10,
              width: 120,
              height: 80,
              angle: 0,
              strokeColor: "#1e1e1e",
              backgroundColor: "transparent",
              fillStyle: "solid",
              strokeWidth: 2,
              strokeStyle: "solid",
              roughness: 1,
              opacity: 100,
              groupIds: [],
              frameId: null,
              index: "a0",
              roundness: null,
              seed: 1,
              version: 2,
              versionNonce: 3,
              isDeleted: false,
              boundElements: null,
              updated: 1,
              link: null,
              locked: false,
            },
          ],
          appState: {},
        },
      }),
    }),
  );

  await page.goto(`/s/${TOKEN}`);

  // Read-only shell: the viewer banner is visible, the canvas mounts in view
  // mode, and no login redirect happens.
  await expect(page.getByText("View only")).toBeVisible();
  await expect(page.locator(".excalidraw-host")).toHaveAttribute(
    "data-read-only",
    "true",
  );
  await expect(page).toHaveURL(new RegExp(`/s/${TOKEN}$`));
  // View mode hides the shape toolbar entirely.
  await expect(page.locator(".App-toolbar")).toHaveCount(0);
});

test("shows the unavailable screen for a revoked link", async ({ page }) => {
  await page.route(`**/api/v1/share/${TOKEN}`, (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/problem+json",
      body: JSON.stringify({
        code: "SHARE_LINK_NOT_FOUND",
        status: 404,
        title: "Share link not found",
        requestId: "e2e",
      }),
    }),
  );

  await page.goto(`/s/${TOKEN}`);

  await expect(
    page.getByRole("heading", { name: "This link isn't available" }),
  ).toBeVisible();
});
