import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { RevisionSource } from "./api";
import { RevisionHistoryDialog } from "./RevisionHistoryDialog";

const DRAWING_ID = "00000000-0000-4000-8000-000000000001";
const AUTHOR_ID = "10000000-0000-4000-8000-000000000001";

const revision = {
  authorUserId: AUTHOR_ID,
  createdAt: "2026-07-11T00:00:00.000Z",
  reason: "checkpoint" as const,
  revision: "7",
};

describe("RevisionHistoryDialog", () => {
  it("requires confirmation, restores through the supplied boundary, and reports completion", async () => {
    const user = userEvent.setup();
    const restore = vi.fn<RevisionSource["restore"]>(() =>
      Promise.resolve({
        revision: "9",
        savedAt: "2026-07-11T00:01:00.000Z",
      }),
    );
    const client = {
      list: vi.fn(() => Promise.resolve({ revisions: [revision] })),
      restore,
    };
    const onRestore = vi.fn((selected: string) =>
      client.restore(DRAWING_ID, selected),
    );
    const onRestored = vi.fn();

    render(
      <RevisionHistoryDialog
        canRestore
        client={client}
        drawingId={DRAWING_ID}
        onClose={vi.fn()}
        onRestore={onRestore}
        onRestored={onRestored}
        open
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Restore" }));
    expect(client.restore).not.toHaveBeenCalled();
    expect(
      screen.getByRole("region", { name: "Confirm revision restore" }),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Restore revision" }));
    expect(onRestore).toHaveBeenCalledWith("7", client);
    expect(onRestored).toHaveBeenCalledWith({
      revision: "9",
      savedAt: "2026-07-11T00:01:00.000Z",
    });
  });

  it("lets viewers inspect history without exposing restore actions", async () => {
    render(
      <RevisionHistoryDialog
        canRestore={false}
        client={{
          list: () => Promise.resolve({ revisions: [revision] }),
          restore: vi.fn(),
        }}
        drawingId={DRAWING_ID}
        onClose={vi.fn()}
        open
      />,
    );

    expect(await screen.findByText("Revision 7")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });
});
