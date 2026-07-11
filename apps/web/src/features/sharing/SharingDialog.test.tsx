import type { DrawingMember } from "@open-excalidraw/contracts";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SharingDialog } from "./SharingDialog";

const DRAWING_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000001";

const owner: DrawingMember = {
  createdAt: "2026-07-11T00:00:00.000Z",
  email: "owner@example.test",
  image: null,
  name: "Owner",
  role: "owner",
  userId: OWNER_ID,
};

describe("SharingDialog", () => {
  it("shows the manual invitation link when SMTP is unavailable", async () => {
    const user = userEvent.setup();
    const client = {
      invite: vi.fn(() =>
        Promise.resolve({
          deliveryStatus: "manual" as const,
          invitation: {
            createdAt: "2026-07-11T00:00:00.000Z",
            drawingId: DRAWING_ID,
            email: "new@example.test",
            expiresAt: "2026-07-18T00:00:00.000Z",
            id: "20000000-0000-4000-8000-000000000001",
            role: "editor" as const,
            status: "pending" as const,
          },
          manualUrl: "https://draw.example.test/invite/token",
        }),
      ),
      list: vi.fn(() => Promise.resolve({ invitations: [], members: [owner] })),
      removeMember: vi.fn(),
      revokeInvitation: vi.fn(),
      updateMember: vi.fn(),
    };

    render(
      <SharingDialog
        client={client}
        drawingId={DRAWING_ID}
        onClose={vi.fn()}
        open
      />,
    );

    await user.type(await screen.findByLabelText("Email"), "new@example.test");
    await user.click(screen.getByRole("button", { name: "Invite" }));

    expect(client.invite).toHaveBeenCalledWith(
      DRAWING_ID,
      "new@example.test",
      "editor",
    );
    expect(screen.getByLabelText("Manual invitation link")).toHaveValue(
      "https://draw.example.test/invite/token",
    );
  });
});
