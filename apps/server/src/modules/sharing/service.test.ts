import { DisabledMailer } from "@open-excalidraw/mail";

import { SharingService } from "./service.js";
import type { SharingRepository } from "./types.js";

const DRAWING_ID = "10000000-0000-4000-8000-000000000001";
const OWNER_ID = "10000000-0000-4000-8000-000000000002";
const MEMBER_ID = "10000000-0000-4000-8000-000000000003";

function createService(repository: Partial<SharingRepository>) {
  const roleChanged = vi.fn();
  const revoked = vi.fn();
  const service = new SharingService({
    repository: repository as SharingRepository,
    mailer: new DisabledMailer(),
    publicBaseUrl: "https://draw.example.test",
    requireVerifiedEmailForAcceptance: false,
    membershipEvents: { roleChanged, revoked },
  });
  return { service, roleChanged, revoked };
}

describe("SharingService membership events", () => {
  it("publishes the committed role when inviting an existing user", async () => {
    const createShare = vi.fn().mockResolvedValue({
      status: "membership",
      member: {
        userId: MEMBER_ID,
        email: "member@example.test",
        name: "Member",
        image: null,
        role: "viewer",
        createdAt: new Date("2026-07-11T00:00:00.000Z"),
      },
    });
    const fixture = createService({ createShare });

    await fixture.service.invite(OWNER_ID, DRAWING_ID, {
      email: "member@example.test",
      role: "viewer",
    });

    expect(fixture.roleChanged).toHaveBeenCalledWith(
      DRAWING_ID,
      MEMBER_ID,
      "viewer",
    );
  });

  it("publishes a role change only after the repository commits it", async () => {
    const updateMember = vi.fn().mockResolvedValue("updated");
    const fixture = createService({
      updateMember,
      removeMember: vi.fn(),
    });

    await fixture.service.updateMember(
      OWNER_ID,
      DRAWING_ID,
      MEMBER_ID,
      "viewer",
    );

    expect(updateMember).toHaveBeenCalledOnce();
    expect(fixture.roleChanged).toHaveBeenCalledWith(
      DRAWING_ID,
      MEMBER_ID,
      "viewer",
    );
  });

  it("revokes live access only after a successful member removal", async () => {
    const removeMember = vi
      .fn()
      .mockResolvedValueOnce("removed")
      .mockResolvedValueOnce("not-found");
    const fixture = createService({
      updateMember: vi.fn(),
      removeMember,
    });

    await fixture.service.removeMember(OWNER_ID, DRAWING_ID, MEMBER_ID);
    await expect(
      fixture.service.removeMember(OWNER_ID, DRAWING_ID, MEMBER_ID),
    ).rejects.toMatchObject({ code: "MEMBER_NOT_FOUND" });

    expect(fixture.revoked).toHaveBeenCalledTimes(1);
    expect(fixture.revoked).toHaveBeenCalledWith(DRAWING_ID, MEMBER_ID);
  });
});
