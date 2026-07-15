import type {
  DrawingMember,
  Invitation,
  MemberRole,
  ShareLinkStatus,
} from "@open-excalidraw/contracts";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { SharingClient, type SharingSource } from "./api";

export interface SharingDialogProps {
  client?: SharingSource;
  drawingId: string;
  onClose: () => void;
  open: boolean;
}

const defaultClient = new SharingClient();

export const SharingDialog = ({
  client = defaultClient,
  drawingId,
  onClose,
  open,
}: SharingDialogProps) => {
  const [members, setMembers] = useState<DrawingMember[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("editor");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [manualUrl, setManualUrl] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<ShareLinkStatus | null>(null);
  // Guards against a slow response for a previous drawing (or an older call
  // for this one) committing its members or bearer share URL into the dialog.
  const loadSequence = useRef(0);

  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    try {
      const [result, link] = await Promise.all([
        client.list(drawingId),
        client.getShareLink(drawingId),
      ]);
      if (sequence !== loadSequence.current) return;
      setError(null);
      setMembers(result.members);
      setInvitations(
        result.invitations.filter(
          (invitation) => invitation.status === "pending",
        ),
      );
      setShareLink(link);
    } catch (caught) {
      if (sequence !== loadSequence.current) return;
      setError(message(caught, "Could not load sharing settings."));
    }
  }, [client, drawingId]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => {
      active = false;
    };
  }, [load, open]);

  if (!open) return null;

  const invite = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    setManualUrl(null);
    try {
      const result = await client.invite(drawingId, email.trim(), role);
      setEmail("");
      if (result.membership) {
        setNotice(
          `${result.membership.email} now has ${result.membership.role} access.`,
        );
      } else if (result.deliveryStatus === "sent") {
        setNotice(
          `Invitation sent to ${result.invitation?.email ?? email.trim()}.`,
        );
      } else {
        setNotice("Invitation created. Copy the link and send it manually.");
        setManualUrl(result.manualUrl ?? null);
      }
      await load();
    } catch (caught) {
      setError(message(caught, "Could not share this drawing."));
    } finally {
      setBusy(false);
    }
  };

  const activeShareUrl = shareLink?.active ? (shareLink.url ?? null) : null;

  const mutate = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (caught) {
      setError(message(caught, "Could not update sharing settings."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="workspace-modal-backdrop">
      <section
        aria-labelledby="sharing-dialog-title"
        aria-modal="true"
        className="workspace-modal"
        role="dialog"
      >
        <header>
          <div>
            <h2 id="sharing-dialog-title">Share drawing</h2>
            <p>Invite people as editors or viewers.</p>
          </div>
          <button aria-label="Close sharing" onClick={onClose} type="button">
            ×
          </button>
        </header>

        <form
          className="sharing-invite-form"
          onSubmit={(event) => void invite(event)}
        >
          <label>
            Email
            <input
              disabled={busy}
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </label>
          <label>
            Access
            <select
              disabled={busy}
              onChange={(event) => setRole(event.target.value as MemberRole)}
              value={role}
            >
              <option value="editor">Can edit</option>
              <option value="viewer">Can view</option>
            </select>
          </label>
          <button disabled={busy || !email.trim()} type="submit">
            Invite
          </button>
        </form>

        {error ? <p role="alert">{error}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {manualUrl ? (
          <div className="sharing-manual-link">
            <label>
              Manual invitation link
              <input readOnly value={manualUrl} />
            </label>
            <button
              onClick={() => void copyInvitation(manualUrl, setNotice)}
              type="button"
            >
              Copy link
            </button>
          </div>
        ) : null}

        <section aria-labelledby="public-share-link">
          <h3 id="public-share-link">Public share link</h3>
          <p>
            Anyone with the link can view this drawing (read-only, live). No
            account needed.
          </p>
          {shareLink === null ? (
            // Unknown is not inactive: offering "Create link" before the
            // status loads would silently rotate an existing link.
            <p aria-live="polite">Checking share link status…</p>
          ) : activeShareUrl ? (
            <>
              <div className="sharing-manual-link">
                <label>
                  Share link
                  <input readOnly value={activeShareUrl} />
                </label>
                <button
                  disabled={busy}
                  onClick={() => void copyShareLink(activeShareUrl, setNotice)}
                  type="button"
                >
                  Copy link
                </button>
              </div>
              <div className="sharing-share-link-actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      await client.createShareLink(drawingId);
                      setNotice(
                        "Share link regenerated. The old link no longer works.",
                      );
                    })
                  }
                  type="button"
                >
                  Regenerate
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void mutate(async () => {
                      await client.revokeShareLink(drawingId);
                      setNotice("Share link revoked.");
                    })
                  }
                  type="button"
                >
                  Revoke
                </button>
              </div>
            </>
          ) : (
            <button
              disabled={busy}
              onClick={() =>
                void mutate(async () => {
                  const created = await client.createShareLink(drawingId);
                  await copyShareLink(created.url, setNotice);
                })
              }
              type="button"
            >
              Create link
            </button>
          )}
        </section>

        <section aria-labelledby="people-with-access">
          <h3 id="people-with-access">People with access</h3>
          {members.length === 0 ? <p>No members found.</p> : null}
          <ul className="sharing-list">
            {members.map((member) => (
              <li key={member.userId}>
                <span>
                  <strong>{member.name}</strong>
                  <small>{member.email}</small>
                </span>
                {member.role === "owner" ? (
                  <span className="workspace-role">Owner</span>
                ) : (
                  <>
                    <select
                      aria-label={`Access for ${member.email}`}
                      disabled={busy}
                      onChange={(event) =>
                        void mutate(() =>
                          client.updateMember(
                            drawingId,
                            member.userId,
                            event.target.value as MemberRole,
                          ),
                        )
                      }
                      value={member.role}
                    >
                      <option value="editor">Can edit</option>
                      <option value="viewer">Can view</option>
                    </select>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void mutate(() =>
                          client.removeMember(drawingId, member.userId),
                        )
                      }
                      type="button"
                    >
                      Remove
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>

        {invitations.length > 0 ? (
          <section aria-labelledby="pending-invitations">
            <h3 id="pending-invitations">Pending invitations</h3>
            <ul className="sharing-list">
              {invitations.map((invitation) => (
                <li key={invitation.id}>
                  <span>
                    <strong>{invitation.email}</strong>
                    <small>
                      Can {invitation.role === "editor" ? "edit" : "view"}
                    </small>
                  </span>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void mutate(() =>
                        client.revokeInvitation(drawingId, invitation.id),
                      )
                    }
                    type="button"
                  >
                    Cancel invite
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </section>
    </div>
  );
};

const copyInvitation = async (
  url: string,
  setNotice: (notice: string) => void,
) => {
  try {
    await navigator.clipboard.writeText(url);
    setNotice("Invitation link copied.");
  } catch {
    setNotice("Select and copy the invitation link above.");
  }
};

const copyShareLink = async (
  url: string,
  setNotice: (notice: string) => void,
) => {
  try {
    await navigator.clipboard.writeText(url);
    setNotice("Share link copied.");
  } catch {
    setNotice("Select and copy the share link above.");
  }
};

const message = (caught: unknown, fallback: string) =>
  caught instanceof Error ? caught.message : fallback;
