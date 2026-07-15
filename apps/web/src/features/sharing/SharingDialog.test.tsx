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
      createShareLink: vi.fn(() =>
        Promise.resolve({
          createdAt: "2026-07-11T00:00:00.000Z",
          url: "https://draw.example.test/s/share-token",
        }),
      ),
      getShareLink: vi.fn(() => Promise.resolve({ active: false })),
      list: vi.fn(() => Promise.resolve({ invitations: [], members: [owner] })),
      removeMember: vi.fn(),
      revokeInvitation: vi.fn(),
      revokeShareLink: vi.fn(),
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

  it("does not offer link creation before the status loads", async () => {
    const client = {
      createShareLink: vi.fn(),
      getShareLink: vi.fn(() => new Promise<never>(() => undefined)),
      invite: vi.fn(),
      list: vi.fn(() => Promise.resolve({ invitations: [], members: [owner] })),
      removeMember: vi.fn(),
      revokeInvitation: vi.fn(),
      revokeShareLink: vi.fn(),
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

    expect(
      await screen.findByText("Checking share link status…"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();
  });

  it("creates, shows, and revokes the public share link", async () => {
    const user = userEvent.setup();
    const shareUrl = "https://draw.example.test/s/" + "s".repeat(43);
    let linkActive = false;
    const client = {
      createShareLink: vi.fn(() => {
        linkActive = true;
        return Promise.resolve({
          createdAt: "2026-07-11T00:00:00.000Z",
          url: shareUrl,
        });
      }),
      getShareLink: vi.fn(() =>
        Promise.resolve(
          linkActive
            ? {
                active: true,
                createdAt: "2026-07-11T00:00:00.000Z",
                url: shareUrl,
              }
            : { active: false },
        ),
      ),
      invite: vi.fn(),
      list: vi.fn(() => Promise.resolve({ invitations: [], members: [owner] })),
      removeMember: vi.fn(),
      revokeInvitation: vi.fn(),
      revokeShareLink: vi.fn(() => {
        linkActive = false;
        return Promise.resolve();
      }),
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

    await user.click(
      await screen.findByRole("button", { name: "Create link" }),
    );

    expect(client.createShareLink).toHaveBeenCalledWith(DRAWING_ID);
    expect(await screen.findByLabelText("Share link")).toHaveValue(shareUrl);

    await user.click(screen.getByRole("button", { name: "Revoke" }));

    expect(client.revokeShareLink).toHaveBeenCalledWith(DRAWING_ID);
    expect(
      await screen.findByRole("button", { name: "Create link" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Share link")).toBeNull();
  });
});
