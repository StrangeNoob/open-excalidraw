import request from "supertest";

import { createApp } from "../../app.js";
import type { IdentityService } from "../auth/identity.js";
import { ContentDomainError } from "../content/errors.js";
import { createExportRouter } from "./router.js";
import type { ExportService } from "./service.js";

const TOKEN = "oepat_test";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const DRAWING_ID = "10000000-0000-4000-8000-000000000002";
const PATH = `/api/v1/drawings/${DRAWING_ID}/export`;

function createHarness(
  render = defaultRender(),
  revision = vi.fn().mockResolvedValue("7"),
) {
  const identity: IdentityService = {
    resolve: (headers) =>
      Promise.resolve(
        (headers as Record<string, string>).authorization === `Bearer ${TOKEN}`
          ? ({ userId: USER_ID } as never)
          : null,
      ),
  };
  const app = createApp({
    routers: [
      createExportRouter({
        service: { render, revision } as unknown as ExportService,
        identity,
      }),
    ],
  });
  return { app, render, revision };
}

const defaultRender = () =>
  vi.fn().mockResolvedValue({
    revision: "7",
    contentType: "image/svg+xml",
    body: Buffer.from("<svg/>", "utf8"),
  });

const get = (app: Parameters<typeof request>[0], query = "") =>
  request(app).get(`${PATH}${query}`).set("authorization", `Bearer ${TOKEN}`);

describe("GET /api/v1/drawings/:drawingId/export", () => {
  it("requires authentication", async () => {
    const { app } = createHarness();

    const response = await request(app).get(PATH);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("defaults to a 1x SVG and tags it with the content revision", async () => {
    const { app, render } = createHarness();

    const response = await get(app);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.headers.etag).toBe('"7-svg-1x"');
    expect(response.headers["cache-control"]).toBe("private, no-cache");
    expect(Buffer.from(response.body as Buffer).toString("utf8")).toBe(
      "<svg/>",
    );
    expect(render).toHaveBeenCalledWith(USER_ID, DRAWING_ID, {
      format: "svg",
      scale: 1,
    });
  });

  it("renders PNG at the requested scale", async () => {
    const { app, render } = createHarness(
      vi.fn().mockResolvedValue({
        revision: "7",
        contentType: "image/png",
        body: Buffer.from([1, 2, 3]),
      }),
    );

    const response = await get(app, "?format=png&scale=2");

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"7-png-2x"');
    expect(render).toHaveBeenCalledWith(USER_ID, DRAWING_ID, {
      format: "png",
      scale: 2,
    });
  });

  it("answers 304 without rendering when the tag still matches", async () => {
    const { app, render } = createHarness();

    const response = await get(app).set("if-none-match", 'W/"7-svg-1x"');

    expect(response.status).toBe(304);
    expect(response.text).toBeFalsy();
    expect(response.headers.etag).toBe('"7-svg-1x"');
    // The whole point of reading the revision first: a render the caller would
    // discard is never paid for.
    expect(render).not.toHaveBeenCalled();
  });

  it("does not read the revision when the request is unconditional", async () => {
    const { app, revision } = createHarness();

    await get(app);

    expect(revision).not.toHaveBeenCalled();
  });

  it("re-renders when the drawing moved on", async () => {
    const { app } = createHarness();

    const response = await get(app).set("if-none-match", '"6-svg-1x"');

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"7-svg-1x"');
  });

  it("rejects an unsupported format", async () => {
    const { app, render } = createHarness();

    const response = await get(app, "?format=pdf");

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("INVALID_REQUEST");
    expect(render).not.toHaveBeenCalled();
  });

  it("rejects a scale outside the supported range", async () => {
    const { app } = createHarness();

    expect((await get(app, "?scale=4")).status).toBe(400);
  });

  it("passes a drawing the caller cannot read through as 404", async () => {
    const { app } = createHarness(
      vi
        .fn()
        .mockRejectedValue(
          new ContentDomainError("DRAWING_NOT_FOUND", 404, "Drawing not found"),
        ),
    );

    const response = await get(app);

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      code: "DRAWING_NOT_FOUND",
      status: 404,
    });
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
  });
});
