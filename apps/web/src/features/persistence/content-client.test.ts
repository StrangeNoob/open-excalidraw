import { ContentClient, VersionConflictError } from "./content-client";

const content = (revision: string) => ({
  assetIds: [],
  revision,
  savedAt: "2026-07-11T00:00:00.000Z",
  scene: {
    appState: {},
    elements: [],
    source: "test",
    type: "excalidraw",
    version: 2,
  },
});

describe("ContentClient", () => {
  it("sends the current ETag and tracks the returned revision", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          revision: "8",
          savedAt: "2026-07-11T00:00:00.000Z",
        }),
        { headers: { "content-type": "application/json", etag: '"8"' } },
      ),
    );
    const client = new ContentClient({ fetch });

    const result = await client.save(
      "drawing",
      { assetIds: [], scene: content("7").scene as never },
      "7",
      "a0c61536-c336-4d26-a86b-704a7f7fb625",
    );

    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("if-match")).toBe(
      '"7"',
    );
    expect(result.revision).toBe("8");
  });

  it("loads canonical content when a conditional save conflicts", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: "VERSION_CONFLICT",
            status: 412,
            title: "The drawing changed",
            requestId: "request",
          }),
          {
            status: 412,
            headers: { "content-type": "application/problem+json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(content("9")), {
          headers: { "content-type": "application/json", etag: '"9"' },
        }),
      );
    const client = new ContentClient({ fetch });

    const error = await client
      .save(
        "drawing",
        { assetIds: [], scene: content("7").scene as never },
        "7",
        "a0c61536-c336-4d26-a86b-704a7f7fb625",
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VersionConflictError);
    expect((error as VersionConflictError).server?.revision).toBe("9");
  });
});
