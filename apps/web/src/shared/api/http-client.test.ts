import { z } from "zod";

import { ApiError, HttpApiClient } from "./http-client";

describe("HttpApiClient", () => {
  it("sends cookie-backed requests and validates responses", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    const client = new HttpApiClient({ baseUrl: "/api/", fetch });

    await expect(
      client.request(
        "health",
        { method: "GET" },
        z.object({ ok: z.literal(true) }),
      ),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledWith(
      "/api/health",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("exposes problem details for failed requests", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "FORBIDDEN",
          detail: "You cannot edit this drawing.",
          requestId: "request-1",
          status: 403,
          title: "Forbidden",
        }),
        { status: 403 },
      ),
    );
    const client = new HttpApiClient({ fetch });

    const request = client.request("drawings/1");

    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      problem: { code: "FORBIDDEN" },
      status: 403,
    });
  });

  it("surfaces Better Auth error messages", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "Invalid email or password",
        }),
        { status: 401 },
      ),
    );
    const client = new HttpApiClient({ fetch });

    await expect(client.request("auth/sign-in/email")).rejects.toMatchObject({
      message: "Invalid email or password",
      problem: { code: "INVALID_EMAIL_OR_PASSWORD" },
      status: 401,
    });
  });

  it("lets the runtime set multipart boundaries for FormData requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const client = new HttpApiClient({ fetch });
    const body = new FormData();
    body.append(
      "file",
      new Blob(["image"], { type: "image/png" }),
      "image.png",
    );

    await client.request<void>("assets", { body, method: "POST" });

    const request = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(request.body).toBe(body);
    expect(new Headers(request.headers).has("content-type")).toBe(false);
  });
});
