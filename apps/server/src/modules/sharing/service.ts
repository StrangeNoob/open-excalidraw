import { createHash, randomBytes } from "node:crypto";

import {
  createInvitationResponseSchema,
  type MemberRole,
} from "@open-excalidraw/contracts";
import { renderInvitationEmail, type Mailer } from "@open-excalidraw/mail";
import type { z } from "zod";

import type { RequestIdentity } from "../auth/identity.js";
import { SharingDomainError } from "./errors.js";
import { toInvitation, toMember, type SharingRepository } from "./types.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;

export interface SharingServiceOptions {
  repository: SharingRepository;
  mailer: Mailer;
  publicBaseUrl: string;
  requireVerifiedEmailForAcceptance: boolean;
  invitationLifetimeMs?: number;
}

type CreateInvitationResponse = z.infer<typeof createInvitationResponseSchema>;

export class SharingService {
  readonly #repository: SharingRepository;
  readonly #mailer: Mailer;
  readonly #publicBaseUrl: URL;
  readonly #requireVerifiedEmail: boolean;
  readonly #invitationLifetimeMs: number;

  public constructor(options: SharingServiceOptions) {
    this.#repository = options.repository;
    this.#mailer = options.mailer;
    this.#publicBaseUrl = new URL(options.publicBaseUrl);
    if (!["http:", "https:"].includes(this.#publicBaseUrl.protocol)) {
      throw new TypeError("publicBaseUrl must use HTTP or HTTPS");
    }
    this.#requireVerifiedEmail = options.requireVerifiedEmailForAcceptance;
    this.#invitationLifetimeMs = options.invitationLifetimeMs ?? SEVEN_DAYS_MS;
    if (
      !Number.isSafeInteger(this.#invitationLifetimeMs) ||
      this.#invitationLifetimeMs <= 0
    ) {
      throw new RangeError("invitationLifetimeMs must be a positive integer");
    }
  }

  public async list(actorUserId: string, drawingId: string) {
    const result = await this.#repository.list(drawingId, actorUserId);
    if (result.status !== "ok") {
      if (result.status === "not-found") throw notFound();
      throw forbidden();
    }
    return {
      members: result.members.map(toMember),
      invitations: result.invitations.map(toInvitation),
    };
  }

  public async invite(
    actorUserId: string,
    drawingId: string,
    input: { email: string; role: MemberRole },
  ): Promise<CreateInvitationResponse> {
    const token = randomBytes(32).toString("base64url");
    const result = await this.#repository.createShare({
      drawingId,
      actorUserId,
      email: normalizeEmail(input.email),
      role: input.role,
      tokenHash: tokenHash(token),
      expiresAt: new Date(Date.now() + this.#invitationLifetimeMs),
    });
    if (result.status === "not-found") throw notFound();
    if (result.status === "forbidden") throw forbidden();
    if (result.status === "membership") {
      return createInvitationResponseSchema.parse({
        membership: toMember(result.member),
        deliveryStatus: "not-needed",
      });
    }

    const manualUrl = new URL(
      `/invite/${encodeURIComponent(token)}`,
      this.#publicBaseUrl,
    ).toString();
    const message = renderInvitationEmail({
      to: result.invitation.email,
      invitationUrl: manualUrl,
      inviterName: result.invitation.inviterName,
      drawingTitle: result.invitation.drawingTitle,
      role: result.invitation.role,
    });
    const delivery = await this.#mailer.send(message).catch(() => ({
      status: "failed" as const,
      reason: "transport" as const,
      retryable: true,
      code: "SMTP_TRANSPORT" as const,
    }));
    const deliveryStatus =
      delivery.status === "sent"
        ? "sent"
        : delivery.status === "disabled"
          ? "manual"
          : "failed";
    await this.#repository.updateInvitationDelivery(
      result.invitation.id,
      deliveryStatus,
    );
    return createInvitationResponseSchema.parse({
      invitation: toInvitation(result.invitation),
      deliveryStatus,
      ...(deliveryStatus === "sent" ? {} : { manualUrl }),
    });
  }

  public async updateMember(
    actorUserId: string,
    drawingId: string,
    memberUserId: string,
    role: MemberRole,
  ) {
    const result = await this.#repository.updateMember({
      drawingId,
      actorUserId,
      memberUserId,
      role,
    });
    this.#handleMutationResult(result, "updated");
  }

  public async removeMember(
    actorUserId: string,
    drawingId: string,
    memberUserId: string,
  ) {
    const result = await this.#repository.removeMember({
      drawingId,
      actorUserId,
      memberUserId,
    });
    this.#handleMutationResult(result, "removed");
  }

  public async revokeInvitation(
    actorUserId: string,
    drawingId: string,
    invitationId: string,
  ) {
    const result = await this.#repository.revokeInvitation({
      drawingId,
      actorUserId,
      invitationId,
    });
    this.#handleMutationResult(result, "revoked");
  }

  public async inspect(token: string) {
    const invitation = await this.#repository.inspect(tokenHash(token));
    if (!invitation) throw invitationNotFound();
    return {
      invitation: toInvitation(invitation),
      drawingTitle: invitation.drawingTitle,
    };
  }

  public async accept(identity: RequestIdentity, token: string) {
    const result = await this.#repository.accept({
      tokenHash: tokenHash(token),
      userId: identity.userId,
      email: normalizeEmail(identity.email),
      emailVerified: identity.emailVerified,
      requireVerifiedEmail: this.#requireVerifiedEmail,
    });
    switch (result.status) {
      case "accepted":
        return { membership: toMember(result.member) };
      case "not-found":
        throw invitationNotFound();
      case "expired":
        throw new SharingDomainError(
          "INVITATION_EXPIRED",
          410,
          "Invitation expired",
        );
      case "used":
        throw new SharingDomainError(
          "INVITATION_USED",
          409,
          "Invitation was already accepted",
        );
      case "revoked":
        throw new SharingDomainError(
          "INVITATION_REVOKED",
          410,
          "Invitation was revoked",
        );
      case "email-mismatch":
        throw new SharingDomainError(
          "INVITATION_EMAIL_MISMATCH",
          403,
          "Sign in with the invited email address",
        );
      case "verification-required":
        throw new SharingDomainError(
          "EMAIL_VERIFICATION_REQUIRED",
          403,
          "Verify the invited email address before accepting",
        );
    }
  }

  #handleMutationResult(
    result: "updated" | "removed" | "revoked" | "not-found" | "forbidden",
    success: "updated" | "removed" | "revoked",
  ) {
    if (result === success) return;
    if (result === "forbidden") throw forbidden();
    throw new SharingDomainError(
      success === "revoked" ? "INVITATION_NOT_FOUND" : "MEMBER_NOT_FOUND",
      404,
      success === "revoked" ? "Invitation not found" : "Member not found",
    );
  }
}

export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest();
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

const notFound = () =>
  new SharingDomainError("DRAWING_NOT_FOUND", 404, "Drawing not found");
const forbidden = () =>
  new SharingDomainError(
    "FORBIDDEN",
    403,
    "Only the drawing owner can manage sharing",
  );
const invitationNotFound = () =>
  new SharingDomainError("INVITATION_NOT_FOUND", 404, "Invitation not found");
