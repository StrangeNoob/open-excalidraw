import { randomUUID } from "node:crypto";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

/**
 * Agent drawing end to end: real browser, real API, real Postgres. The account
 * comes from `agent-auth.setup.ts`; every scenario mints its own drawing and
 * personal access token, so the file stays safe under `fullyParallel`.
 *
 * The canvas assertions read Excalidraw's own stats panel ("Canvas & Shape
 * properties"): its shape count is the editor's live scene, which a poll of
 * the REST content endpoint would not prove.
 */

// Written by the setup project (see agent-auth.setup.ts).
test.use({ storageState: "test-results/.auth/agent.json" });

interface SceneElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index?: string | null;
  x: number;
  y: number;
  [key: string]: unknown;
}

/**
 * Tokens are session-only to mint, so this borrows the signed-in page's
 * cookies. No scope is requested: the server's default is writable.
 */
const mintToken = async (page: Page) => {
  const response = await page.request.post("/api/v1/tokens", {
    data: { name: `e2e-${randomUUID()}`, expiresInDays: 1 },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).secret as string;
};

/** The REST half of the suite: what the drawing skill and MCP tools do. */
class Agent {
  readonly #request: APIRequestContext;
  readonly #headers: Record<string, string>;

  constructor(request: APIRequestContext, token: string) {
    this.#request = request;
    this.#headers = { Authorization: `Bearer ${token}` };
  }

  async createDrawing(title: string): Promise<string> {
    const id = randomUUID();
    const response = await this.#request.post("/api/v1/drawings", {
      headers: this.#headers,
      data: { id, title, idempotencyKey: randomUUID() },
    });
    expect(response.status()).toBe(201);
    return id;
  }

  async read(drawingId: string) {
    const response = await this.#request.get(
      `/api/v1/drawings/${drawingId}/content`,
      { headers: this.#headers },
    );
    expect(response.status()).toBe(200);
    const body = await response.json();
    return {
      revision: body.revision as string,
      elements: body.scene.elements as SceneElement[],
    };
  }

  /** One raw compare-and-swap attempt — the caller inspects the status. */
  save(drawingId: string, revision: string, elements: SceneElement[]) {
    return this.#request.put(`/api/v1/drawings/${drawingId}/content`, {
      headers: {
        ...this.#headers,
        "If-Match": revision,
        // A fresh key per payload: a rebase is a different payload.
        "Idempotency-Key": randomUUID(),
      },
      data: {
        scene: {
          type: "excalidraw",
          version: 2,
          source: "e2e-agent",
          elements,
          appState: {},
        },
        assetIds: [],
      },
    });
  }

  /** The skill's CAS loop: read, rebase onto the fresh scene, retry. */
  async commit(
    drawingId: string,
    rebase: (elements: SceneElement[]) => SceneElement[],
  ) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { revision, elements } = await this.read(drawingId);
      const response = await this.save(drawingId, revision, rebase(elements));
      if (response.ok()) return;
      if (response.status() !== 412) {
        throw new Error(
          `agent save failed: ${response.status()} ${await response.text()}`,
        );
      }
    }
    throw new Error("agent save lost the compare-and-swap three times");
  }
}

const rectangle = (input: {
  id: string;
  index: string;
  x: number;
  y: number;
  isDeleted?: boolean;
  version?: number;
}): SceneElement => ({
  id: input.id,
  type: "rectangle",
  x: input.x,
  y: input.y,
  width: 180,
  height: 90,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: input.index,
  roundness: { type: 3 },
  seed: 1_234_567,
  version: input.version ?? 1,
  versionNonce: Math.floor(Math.random() * 2_147_483_647),
  isDeleted: input.isDeleted ?? false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
});

const byId = (elements: SceneElement[], id: string) => {
  const found = elements.find((element) => element.id === id);
  if (!found) throw new Error(`element ${id} is missing from the scene`);
  return found;
};

const openDrawing = async (page: Page, drawingId: string) => {
  await page.goto(`/drawings/${drawingId}`);
  await expect(page.locator(".excalidraw-host")).toBeVisible();
};

/**
 * Excalidraw's own scene stats, the closest DOM-observable to "what the canvas
 * is showing". Toggled from the canvas context menu.
 */
const openStats = async (page: Page) => {
  const stats = page.locator(".exc-stats");
  if (await stats.isVisible()) return;
  const canvas = page.locator("canvas.interactive").first();
  await canvas.click({ button: "right", position: { x: 900, y: 620 } });
  await page.getByText("Canvas & Shape properties").click();
  await expect(stats).toBeVisible();
};

const shapeCount = (page: Page) =>
  page.locator(".exc-stats__row", { hasText: "Shapes" }).locator("div").last();

/** Draws a rectangle by hand, the way a user does. */
const drawRectangle = async (
  page: Page,
  from: [number, number],
  to: [number, number],
) => {
  // An incoming resync re-renders the canvas and can take the keyboard focus
  // the shape shortcut needs with it, so re-focus before every draw.
  await page
    .locator("canvas.interactive")
    .first()
    .click({
      position: { x: 900, y: 620 },
    });
  await page.keyboard.press("r");
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
};

test("an external REST write lands on an open canvas without a reload", async ({
  page,
}) => {
  const agent = new Agent(page.request, await mintToken(page));
  const drawingId = await agent.createDrawing("agent live write");

  await openDrawing(page, drawingId);
  await openStats(page);
  await expect(shapeCount(page)).toHaveText("0");
  // Survives only if the document is never reloaded.
  await page.evaluate(() =>
    document.documentElement.setAttribute("data-e2e-session", "kept"),
  );
  // The client commits its initial shared scene state once after room.ready.
  // Writing before that lands lets the canvas converge through the client's
  // own revision-gap rejoin, which would pass even with the broadcast gone.
  await expect
    .poll(async () => (await agent.read(drawingId)).revision)
    .not.toBe("0");

  await agent.commit(drawingId, () => [
    rectangle({ id: "agent-live", index: "a000", x: 300, y: 200 }),
  ]);

  await expect(shapeCount(page)).toHaveText("1");
  await expect(page.locator("html")).toHaveAttribute(
    "data-e2e-session",
    "kept",
  );
});

test("a 412 against an actively edited drawing converges after a rebase retry", async ({
  page,
}) => {
  const agent = new Agent(page.request, await mintToken(page));
  const drawingId = await agent.createDrawing("agent rebase retry");

  await openDrawing(page, drawingId);
  await openStats(page);
  await drawRectangle(page, [500, 200], [660, 300]);
  await expect(shapeCount(page)).toHaveText("1");

  // The agent reads, then the user edits again: the read revision goes stale.
  const stale = await agent.read(drawingId);
  await drawRectangle(page, [500, 380], [660, 480]);
  await expect(shapeCount(page)).toHaveText("2");
  await expect
    .poll(async () => (await agent.read(drawingId)).revision)
    .not.toBe(stale.revision);

  const conflict = await agent.save(drawingId, stale.revision, [
    ...stale.elements,
    rectangle({ id: "agent-rebased", index: "a9", x: 800, y: 200 }),
  ]);
  expect(conflict.status()).toBe(412);

  // Rebase: re-read, keep the user's elements untouched, append ours.
  const fresh = await agent.read(drawingId);
  const retry = await agent.save(drawingId, fresh.revision, [
    ...fresh.elements,
    rectangle({ id: "agent-rebased", index: "a9", x: 800, y: 200 }),
  ]);
  expect(retry.status()).toBe(200);

  await expect(shapeCount(page)).toHaveText("3");
});

test("a tombstoned element stays deleted while the page has the drawing open", async ({
  page,
}) => {
  const agent = new Agent(page.request, await mintToken(page));
  const drawingId = await agent.createDrawing("agent tombstone");

  await openDrawing(page, drawingId);
  await openStats(page);
  await agent.commit(drawingId, () => [
    rectangle({ id: "agent-keep", index: "a000", x: 200, y: 200 }),
    rectangle({ id: "agent-doomed", index: "a001", x: 200, y: 400 }),
  ]);
  await expect(shapeCount(page)).toHaveText("2");

  await agent.commit(drawingId, (elements) =>
    elements.map((element) =>
      element.id === "agent-doomed"
        ? { ...element, isDeleted: true, version: element.version + 1 }
        : element,
    ),
  );
  await expect(shapeCount(page)).toHaveText("1");

  // The live editor now saves its own scene. A pending client-side copy of the
  // deleted element would re-add it here; the tombstone has to hold.
  await drawRectangle(page, [600, 200], [760, 300]);
  await expect(shapeCount(page)).toHaveText("2");

  await expect
    .poll(async () => {
      const { elements } = await agent.read(drawingId);
      return {
        deleted: byId(elements, "agent-doomed").isDeleted,
        live: elements.filter((element) => !element.isDeleted).length,
      };
    })
    .toEqual({ deleted: true, live: 2 });
  await expect(shapeCount(page)).toHaveText("2");
});

test("a drag and a concurrent REST write to another element both survive", async ({
  page,
}) => {
  const agent = new Agent(page.request, await mintToken(page));
  const drawingId = await agent.createDrawing("agent concurrent drag");

  await openDrawing(page, drawingId);
  await openStats(page);
  // The user's element: drawn by hand, so its screen position is known.
  await drawRectangle(page, [500, 200], [660, 300]);
  await expect(shapeCount(page)).toHaveText("1");
  await expect
    .poll(async () => (await agent.read(drawingId)).elements.length)
    .toBe(1);
  const draggedId = (await agent.read(drawingId)).elements[0]!.id;

  await agent.commit(drawingId, (elements) => [
    ...elements,
    rectangle({ id: "agent-parallel", index: "a9", x: 900, y: 500 }),
  ]);
  await expect(shapeCount(page)).toHaveText("2");

  // Drag the user's element by its stroke (its fill is transparent) and let
  // the agent move the other element while the pointer is still down.
  await page.mouse.move(500, 250);
  await page.mouse.down();
  await page.mouse.move(560, 270, { steps: 5 });
  await agent.commit(drawingId, (elements) =>
    elements.map((element) =>
      element.id === "agent-parallel"
        ? { ...element, x: 1_100, version: element.version + 1 }
        : element,
    ),
  );
  await page.mouse.move(620, 300, { steps: 5 });
  await page.mouse.up();

  // Both edits have to be in the converged scene: the drag is asserted as
  // "moved right, not reverted to the position the agent wrote back" rather
  // than by an exact delta — a resync that lands mid-gesture sometimes ends
  // the drag early, and the guarantee under test is survival, not precision.
  await expect
    .poll(async () => {
      const { elements } = await agent.read(drawingId);
      const dragged = byId(elements, draggedId);
      const parallel = byId(elements, "agent-parallel");
      return {
        dragSaved: dragged.x > 500,
        parallelX: parallel.x,
        deleted: dragged.isDeleted || parallel.isDeleted,
      };
    })
    .toEqual({ dragSaved: true, parallelX: 1_100, deleted: false });
  await expect(shapeCount(page)).toHaveText("2");
});

test("a bad agent save is recovered from the history UI", async ({ page }) => {
  const agent = new Agent(page.request, await mintToken(page));
  const drawingId = await agent.createDrawing("agent restore recovery");

  // Saved before the page opens, so this scene is the drawing's first
  // checkpoint — the revision the user restores to.
  await agent.commit(drawingId, () => [
    rectangle({ id: "agent-good-1", index: "a000", x: 200, y: 200 }),
    rectangle({ id: "agent-good-2", index: "a001", x: 200, y: 400 }),
  ]);

  await openDrawing(page, drawingId);
  await openStats(page);
  await expect(shapeCount(page)).toHaveText("2");
  // Wait out the client's one-time initial commit, so the wipe below has to
  // reach the canvas through the broadcast rather than a revision-gap rejoin.
  const opened = (await agent.read(drawingId)).revision;
  await expect
    .poll(async () => (await agent.read(drawingId)).revision)
    .not.toBe(opened);

  // Valid, and wrong: the agent wipes the scene it was asked to extend.
  await agent.commit(drawingId, (elements) =>
    elements.map((element) => ({
      ...element,
      isDeleted: true,
      version: element.version + 1,
    })),
  );
  await expect(shapeCount(page)).toHaveText("0");

  await page.getByRole("button", { name: "History" }).click();
  const dialog = page.getByRole("dialog", { name: "Revision history" });
  // Checkpoints are periodic, so the good save is the only one on offer.
  const checkpoint = dialog.getByRole("listitem");
  await expect(checkpoint).toHaveCount(1);
  await checkpoint.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Restore revision" }).click();
  // The restore remounts the editor, taking the stats panel with it.
  await expect(dialog).toBeHidden();

  await openStats(page);
  await expect(shapeCount(page)).toHaveText("2");
});
