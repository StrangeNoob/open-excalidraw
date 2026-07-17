import { LibraryClient, LibraryRequestError } from "./library-client";

const item = (id: string) => ({
  created: 1,
  elements: [],
  id,
  status: "unpublished",
});

const body = (ids: string[]) =>
  JSON.stringify({
    items: ids.map(item),
    updatedAt: "2026-07-11T00:00:00.000Z",
  });

describe("LibraryClient", () => {
  it("loads and parses the account library", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body(["a"]), {
        headers: { "content-type": "application/json" },
      }),
    );

    const library = await new LibraryClient({ fetch }).load();

    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/library");
    expect(library.items).toEqual([item("a")]);
  });

  it("PUTs the items and parses the saved library", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body(["a"]), {
        headers: { "content-type": "application/json" },
      }),
    );

    const saved = await new LibraryClient({ fetch }).save([item("a")] as never);

    const request = fetch.mock.calls[0]?.[1];
    expect(request?.method).toBe("PUT");
    expect(JSON.parse(request?.body as string)).toEqual({ items: [item("a")] });
    expect(saved.items).toEqual([item("a")]);
  });

  it("throws a typed error on a failed request", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response("nope", { status: 500 }));

    const error = await new LibraryClient({ fetch })
      .load()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LibraryRequestError);
    expect((error as LibraryRequestError).status).toBe(500);
  });
});
