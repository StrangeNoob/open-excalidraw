import { HttpApiClient } from "../../shared/api";
import { RevisionClient } from "./api";

const DRAWING_ID = "00000000-0000-4000-8000-000000000001";

describe("RevisionClient", () => {
  it("accepts a null author for a revision whose author was deleted", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          revisions: [
            {
              authorUserId: null,
              createdAt: "2026-07-11T00:00:00.000Z",
              reason: "checkpoint",
              revision: "7",
            },
          ],
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    );
    const client = new RevisionClient(new HttpApiClient({ fetch }));

    const result = await client.list(DRAWING_ID);
    expect(result.revisions[0]?.authorUserId).toBeNull();
  });
});
