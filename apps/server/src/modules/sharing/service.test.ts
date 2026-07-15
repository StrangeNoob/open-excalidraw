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

describe("SharingService share links", () => {
  const LINK_ID = "10000000-0000-4000-8000-000000000004";
  const OLD_LINK_ID = "10000000-0000-4000-8000-000000000005";

  function createShareFixture(repository: Partial<SharingRepository>) {
    const shareLinkRevoked = vi.fn();
    const service = new SharingService({
      repository: repository as SharingRepository,
      mailer: new DisabledMailer(),
      publicBaseUrl: "https://draw.example.test",
      requireVerifiedEmailForAcceptance: false,
      shareLinkEvents: { revoked: shareLinkRevoked },
    });
    return { service, shareLinkRevoked };
  }

  it("returns a /s/{token} url and revokes a replaced link's live viewers", async () => {
    const createShareLink = vi
      .fn()
      .mockImplementation((input: { token: string }) =>
        Promise.resolve({
          status: "created",
          link: {
            linkId: LINK_ID,
            token: input.token,
            createdAt: new Date("2026-07-11T00:00:00.000Z"),
          },
          replacedLinkId: OLD_LINK_ID,
        }),
      );
    const fixture = createShareFixture({ createShareLink });

    const result = await fixture.service.createShareLink(OWNER_ID, DRAWING_ID);

    expect(result.url).toMatch(
      /^https:\/\/draw\.example\.test\/s\/[A-Za-z0-9_-]{43}$/,
    );
    expect(fixture.shareLinkRevoked).toHaveBeenCalledWith(
      DRAWING_ID,
      OLD_LINK_ID,
    );
  });

  it("does not fire revocation when creating the first link", async () => {
    const createShareLink = vi
      .fn()
      .mockImplementation((input: { token: string }) =>
        Promise.resolve({
          status: "created",
          link: {
            linkId: LINK_ID,
            token: input.token,
            createdAt: new Date("2026-07-11T00:00:00.000Z"),
          },
          replacedLinkId: null,
        }),
      );
    const fixture = createShareFixture({ createShareLink });

    await fixture.service.createShareLink(OWNER_ID, DRAWING_ID);

    expect(fixture.shareLinkRevoked).not.toHaveBeenCalled();
  });

  it("fires revocation after a successful revoke", async () => {
    const revokeShareLink = vi
      .fn()
      .mockResolvedValueOnce({ status: "revoked", linkId: LINK_ID })
      .mockResolvedValueOnce({ status: "no-link" });
    const fixture = createShareFixture({ revokeShareLink });

    await fixture.service.revokeShareLink(OWNER_ID, DRAWING_ID);
    await expect(
      fixture.service.revokeShareLink(OWNER_ID, DRAWING_ID),
    ).rejects.toMatchObject({ code: "SHARE_LINK_NOT_FOUND" });

    expect(fixture.shareLinkRevoked).toHaveBeenCalledTimes(1);
    expect(fixture.shareLinkRevoked).toHaveBeenCalledWith(DRAWING_ID, LINK_ID);
  });

  it("reports link status with the share url", async () => {
    const getShareLink = vi.fn().mockResolvedValue({
      status: "ok",
      link: {
        linkId: LINK_ID,
        token: "a".repeat(43),
        createdAt: new Date("2026-07-11T00:00:00.000Z"),
      },
    });
    const fixture = createShareFixture({ getShareLink });

    await expect(
      fixture.service.getShareLink(OWNER_ID, DRAWING_ID),
    ).resolves.toEqual({
      active: true,
      url: `https://draw.example.test/s/${"a".repeat(43)}`,
      createdAt: "2026-07-11T00:00:00.000Z",
    });
  });

  it("maps an unknown share token to SHARE_LINK_NOT_FOUND", async () => {
    const resolveShareToken = vi.fn().mockResolvedValue(null);
    const fixture = createShareFixture({ resolveShareToken });

    await expect(
      fixture.service.inspectShareToken("b".repeat(43)),
    ).rejects.toMatchObject({ code: "SHARE_LINK_NOT_FOUND", status: 404 });
  });
});
