import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";

import { InvitationPage } from "./InvitationPage";

const api = vi.hoisted(() => ({
  accept: vi.fn(),
  inspect: vi.fn(),
}));

vi.mock("./api", () => ({
  InvitationClient: class {
    accept = api.accept;
    inspect = api.inspect;
  },
}));

vi.mock("../auth", () => ({
  useAuth: () => ({
    status: "ready",
    user: { id: "10000000-0000-4000-8000-000000000001" },
  }),
}));

describe("InvitationPage", () => {
  beforeEach(() => {
    api.accept.mockReset();
    api.inspect.mockReset();
  });

  it.each([
    ["accepted", "This invitation has already been accepted."],
    [
      "expired",
      "This invitation has expired. Ask the drawing owner for a new link.",
    ],
    [
      "revoked",
      "This invitation was revoked. Ask the drawing owner if you still need access.",
    ],
  ] as const)(
    "shows an unavailable state without acceptance controls for %s invitations",
    async (status, expected) => {
      api.inspect.mockResolvedValue({
        drawingTitle: "Architecture",
        invitation: {
          createdAt: "2026-07-11T00:00:00.000Z",
          drawingId: "00000000-0000-4000-8000-000000000001",
          email: "invitee@example.test",
          expiresAt: "2026-07-18T00:00:00.000Z",
          id: "20000000-0000-4000-8000-000000000001",
          role: "editor",
          status,
        },
      });
      const router = createMemoryRouter(
        [{ path: "/invite/:token", element: <InvitationPage /> }],
        { initialEntries: ["/invite/pending-token"] },
      );

      render(<RouterProvider router={router} />);

      expect(await screen.findByRole("alert")).toHaveTextContent(expected);
      expect(
        screen.queryByRole("button", { name: "Accept invitation" }),
      ).toBeNull();
      expect(
        screen.queryByRole("link", { name: "Sign in to accept" }),
      ).toBeNull();
      expect(api.accept).not.toHaveBeenCalled();
    },
  );
});
