import {
  createInvitationResponseSchema,
  drawingMemberSchema,
  invitationSchema,
  type DrawingMember,
  type Invitation,
  type MemberRole,
} from "@open-excalidraw/contracts";
import { z } from "zod";

import { HttpApiClient } from "../../shared/api";

const sharingListSchema = z
  .object({
    invitations: z.array(invitationSchema),
    members: z.array(drawingMemberSchema),
  })
  .strict();

const invitationInspectionSchema = z
  .object({
    drawingTitle: z.string().min(1),
    invitation: invitationSchema,
  })
  .strict();

const invitationAcceptanceSchema = z
  .object({ membership: drawingMemberSchema })
  .strict();

export interface SharingList {
  invitations: Invitation[];
  members: DrawingMember[];
}

export interface InvitationInspection {
  drawingTitle: string;
  invitation: Invitation;
}

export interface SharingSource {
  invite(
    drawingId: string,
    email: string,
    role: MemberRole,
  ): Promise<{
    deliveryStatus: "sent" | "manual" | "failed" | "not-needed";
    invitation?: Invitation;
    manualUrl?: string;
    membership?: DrawingMember;
  }>;
  list(drawingId: string): Promise<SharingList>;
  removeMember(drawingId: string, userId: string): Promise<void>;
  revokeInvitation(drawingId: string, invitationId: string): Promise<void>;
  updateMember(
    drawingId: string,
    userId: string,
    role: MemberRole,
  ): Promise<void>;
}

export class SharingClient implements SharingSource {
  constructor(private readonly api = new HttpApiClient()) {}

  list(drawingId: string): Promise<SharingList> {
    return this.api.request(
      `/v1/drawings/${encodeURIComponent(drawingId)}/members`,
      { method: "GET" },
      sharingListSchema,
    );
  }

  invite(drawingId: string, email: string, role: MemberRole) {
    return this.api.request(
      `/v1/drawings/${encodeURIComponent(drawingId)}/invitations`,
      {
        body: JSON.stringify({ email, role }),
        method: "POST",
      },
      createInvitationResponseSchema,
    );
  }

  updateMember(drawingId: string, userId: string, role: MemberRole) {
    return this.api.request<void>(
      `/v1/drawings/${encodeURIComponent(drawingId)}/members/${encodeURIComponent(userId)}`,
      { body: JSON.stringify({ role }), method: "PATCH" },
    );
  }

  removeMember(drawingId: string, userId: string) {
    return this.api.request<void>(
      `/v1/drawings/${encodeURIComponent(drawingId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  revokeInvitation(drawingId: string, invitationId: string) {
    return this.api.request<void>(
      `/v1/drawings/${encodeURIComponent(drawingId)}/invitations/${encodeURIComponent(invitationId)}`,
      { method: "DELETE" },
    );
  }
}

export class InvitationClient {
  constructor(private readonly api = new HttpApiClient()) {}

  inspect(token: string): Promise<InvitationInspection> {
    return this.api.request(
      `/v1/invitations/${encodeURIComponent(token)}`,
      { method: "GET" },
      invitationInspectionSchema,
    );
  }

  accept(token: string) {
    return this.api.request(
      `/v1/invitations/${encodeURIComponent(token)}/accept`,
      { method: "POST" },
      invitationAcceptanceSchema,
    );
  }
}
