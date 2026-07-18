/**
 * Hand-authored OpenAPI 3.0 document for the versioned REST API. Kept next to
 * the routers it describes; update it together with contract or route changes.
 * Realtime collaboration (scene mutations, presence, chat sends) runs over
 * Socket.IO at /socket.io and is documented in docs/operations/collaboration.md
 * rather than here.
 */

const PROBLEM = "application/problem+json";
const JSON_TYPE = "application/json";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

const problem = (description: string) => ({
  description,
  content: { [PROBLEM]: { schema: ref("ProblemDetails") } },
});

const json = (description: string, schema: unknown) => ({
  description,
  content: { [JSON_TYPE]: { schema } },
});

const jsonBody = (schema: unknown) => ({
  required: true,
  content: { [JSON_TYPE]: { schema } },
});

const uuid = { type: "string", format: "uuid" };
const isoDateTime = { type: "string", format: "date-time" };
const revision = {
  type: "string",
  pattern: "^(0|[1-9]\\d*)$",
  description: "Monotonically increasing revision, serialized as a string.",
};
const role = { type: "string", enum: ["owner", "editor", "viewer"] };
const memberRole = { type: "string", enum: ["editor", "viewer"] };

const drawingIdParameter = {
  name: "drawingId",
  in: "path",
  required: true,
  schema: uuid,
};
const shareTokenParameter = {
  name: "token",
  in: "path",
  required: true,
  schema: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
};
const adminUserIdParameter = {
  name: "userId",
  in: "path",
  required: true,
  schema: uuid,
};

const unauthorized = problem("Authentication is required.");
const notFound = problem("Drawing not found or not accessible.");
const forbidden = problem("The caller's role does not permit this action.");
const invalidRequest = problem("Request validation failed.");

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "Open Excalidraw API",
    version: "v1",
    description: [
      "REST API of the Open Excalidraw collaboration server.",
      "",
      "**Authentication** uses the session cookie issued by the",
      "[better-auth](https://www.better-auth.com) endpoints mounted under",
      "`/api/auth` (email/password plus optional Google and GitHub OAuth).",
      "Sign-up, sign-in, sign-out, email verification, and password reset are",
      "standard better-auth routes and are not enumerated here.",
      "A generic OIDC provider can also be configured; its sign-in starts at",
      "`POST /api/auth/sign-in/oauth2` and the IdP redirects back to",
      "`/api/auth/oauth2/callback/oidc`.",
      "",
      "**Browser requests** with unsafe methods must be same-origin: the",
      "server rejects mutating requests whose `Origin` (or `Sec-Fetch-Site`)",
      "is not a trusted origin with `403 ORIGIN_NOT_ALLOWED`. Non-browser",
      "clients that omit these headers are unaffected.",
      "",
      "**Errors** are `application/problem+json` documents with a stable",
      "machine-readable `code` and the `x-request-id` echoed for correlation.",
      "",
      "**Realtime editing, presence, and chat sending** use Socket.IO at",
      "`/socket.io`; only chat history is read over REST.",
    ].join("\n"),
    license: { name: "MIT", url: "https://opensource.org/licenses/MIT" },
  },
  tags: [
    { name: "Health", description: "Liveness and readiness probes." },
    { name: "Auth", description: "Session introspection and account access." },
    { name: "Drawings", description: "Drawing metadata, tags, and lifecycle." },
    {
      name: "Content",
      description: "Scene content with revisioned, conflict-safe saves.",
    },
    { name: "Sharing", description: "Members, roles, and email invitations." },
    {
      name: "Library",
      description: "Per-account persistence of Excalidraw shape libraries.",
    },
    { name: "Chat", description: "Per-drawing chat history." },
    { name: "Assets", description: "Binary assets referenced by scenes." },
    {
      name: "Admin",
      description:
        "Operator endpoints: loopback-only recovery plus instance and user " +
        "management gated on a verified email listed in `ADMIN_EMAILS`.",
    },
  ],
  security: [{ sessionCookie: [] }],
  paths: {
    "/health/live": {
      get: {
        tags: ["Health"],
        summary: "Liveness probe",
        security: [],
        responses: {
          "200": json("The process is running.", ref("HealthStatus")),
        },
      },
    },
    "/health/ready": {
      get: {
        tags: ["Health"],
        summary: "Readiness probe",
        description: "Verifies database connectivity.",
        security: [],
        responses: {
          "200": json("Ready to serve traffic.", ref("HealthStatus")),
          "503": json("A dependency is unavailable.", ref("HealthStatus")),
        },
      },
    },
    "/api/v1/me": {
      get: {
        tags: ["Auth"],
        summary: "Current session and server capabilities",
        description:
          "Returns the signed-in user (or `null`) together with which " +
          "authentication capabilities the deployment has enabled.",
        security: [],
        responses: {
          "200": json("The current session.", ref("SessionResponse")),
        },
      },
    },
    "/api/v1/me/password": {
      post: {
        tags: ["Auth"],
        summary: "Set a password on the current account",
        description:
          "Lets OAuth-only users add an email/password credential. " +
          "Existing password holders must use the better-auth " +
          "change-password flow instead.",
        requestBody: jsonBody({
          type: "object",
          required: ["newPassword"],
          additionalProperties: false,
          properties: {
            newPassword: { type: "string", minLength: 12, maxLength: 128 },
          },
        }),
        responses: {
          "204": { description: "Password set." },
          "400": invalidRequest,
          "401": unauthorized,
        },
      },
    },
    "/api/admin/manual-reset-links/consume": {
      post: {
        tags: ["Admin"],
        summary: "Consume a pending manual password-reset link",
        description:
          "SMTP-disabled installations queue reset links in memory instead " +
          "of emailing them. This endpoint hands the one-time link to an " +
          "operator holding `ADMIN_RESET_TOKEN`. Only mounted when the " +
          "token is configured; intended for loopback access only.",
        security: [{ adminToken: [] }],
        requestBody: jsonBody({
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", format: "email" } },
        }),
        responses: {
          "200": json(
            "The one-time reset link.",
            ref("ManualResetLinkResponse"),
          ),
          "400": json("Email is required.", ref("AdminError")),
          "401": json("Missing or invalid bearer token.", ref("AdminError")),
          "404": json(
            "No reset link is queued for this email.",
            ref("AdminError"),
          ),
        },
      },
    },
    "/api/v1/admin/overview": {
      get: {
        tags: ["Admin"],
        summary: "Instance counts",
        description:
          "Total users, active drawings, and active asset storage bytes. " +
          "Restricted to callers with a verified email listed in `ADMIN_EMAILS`.",
        responses: {
          "200": json("Instance counts.", ref("AdminOverview")),
          "401": unauthorized,
          "403": problem("Administrator access is required."),
        },
      },
    },
    "/api/v1/admin/users": {
      get: {
        tags: ["Admin"],
        summary: "List users",
        description:
          "Users ordered by creation, oldest first. `search` filters email " +
          "and name case-insensitively; `total` counts all matches.",
        parameters: [
          {
            name: "search",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
          {
            name: "limit",
            in: "query",
            required: false,
            description: "Default 50, capped at 200.",
            schema: { type: "integer", minimum: 1, maximum: 200 },
          },
        ],
        responses: {
          "200": json("The matching users.", ref("AdminUserList")),
          "401": unauthorized,
          "403": problem("Administrator access is required."),
        },
      },
    },
    "/api/v1/admin/users/{userId}/disable": {
      parameters: [adminUserIdParameter],
      post: {
        tags: ["Admin"],
        summary: "Disable a user",
        description:
          "Sets `disabledAt` (idempotent) and revokes every session, so the " +
          "user is locked out immediately and cannot start a new session. " +
          "Fails when the target is the caller.",
        responses: {
          "204": { description: "Disabled." },
          "401": unauthorized,
          "403": problem("Administrator access is required."),
          "404": problem("User not found."),
          "409": problem("`CANNOT_TARGET_SELF`: cannot disable yourself."),
        },
      },
    },
    "/api/v1/admin/users/{userId}/enable": {
      parameters: [adminUserIdParameter],
      post: {
        tags: ["Admin"],
        summary: "Enable a user",
        description: "Clears `disabledAt`, allowing the user to sign in again.",
        responses: {
          "204": { description: "Enabled." },
          "401": unauthorized,
          "403": problem("Administrator access is required."),
          "404": problem("User not found."),
        },
      },
    },
    "/api/v1/admin/users/{userId}": {
      parameters: [adminUserIdParameter],
      delete: {
        tags: ["Admin"],
        summary: "Delete a user",
        description:
          "Permanently purges every drawing the user owns (storage blobs " +
          "included) and deletes the account. Content the user authored in " +
          "other users' drawings survives with its attribution nulled. Fails " +
          "when the target is the caller.",
        responses: {
          "204": { description: "Deleted." },
          "401": unauthorized,
          "403": problem("Administrator access is required."),
          "404": problem("User not found."),
          "409": problem("`CANNOT_TARGET_SELF`: cannot delete yourself."),
        },
      },
    },
    "/api/v1/drawings": {
      get: {
        tags: ["Drawings"],
        summary: "List accessible drawings",
        responses: {
          "200": json(
            "Drawings owned by and shared with the caller.",
            ref("DrawingListResponse"),
          ),
          "401": unauthorized,
        },
      },
      post: {
        tags: ["Drawings"],
        summary: "Create a drawing",
        requestBody: jsonBody(ref("CreateDrawingRequest")),
        responses: {
          "201": json("The created drawing.", ref("DrawingSummary")),
          "400": invalidRequest,
          "401": unauthorized,
        },
      },
    },
    "/api/v1/drawings/trash": {
      get: {
        tags: ["Drawings"],
        summary: "List the caller's trashed drawings",
        description:
          "Drawings the caller owns that were deleted but not yet purged, " +
          "newest deletion first. Trashed drawings are permanently deleted " +
          "automatically after 7 days.",
        responses: {
          "200": json("The trashed drawings.", ref("TrashListResponse")),
          "401": unauthorized,
        },
      },
    },
    "/api/v1/drawings/{drawingId}": {
      parameters: [drawingIdParameter],
      get: {
        tags: ["Drawings"],
        summary: "Get a drawing's metadata",
        responses: {
          "200": json("The drawing.", ref("DrawingSummary")),
          "401": unauthorized,
          "404": notFound,
        },
      },
      patch: {
        tags: ["Drawings"],
        summary: "Update a drawing's metadata (title, template flag)",
        description:
          "Optimistic concurrency: the request carries the last seen " +
          "`metadataRevision` and fails with `412 METADATA_VERSION_CONFLICT` " +
          "when the metadata changed in the meantime.",
        requestBody: jsonBody(ref("UpdateDrawingRequest")),
        responses: {
          "200": json("The renamed drawing.", ref("DrawingSummary")),
          "400": invalidRequest,
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
          "412": problem("`METADATA_VERSION_CONFLICT`: metadata changed."),
        },
      },
      delete: {
        tags: ["Drawings"],
        summary: "Delete a drawing (owner only)",
        responses: {
          "204": { description: "Deleted." },
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/tags": {
      parameters: [drawingIdParameter],
      put: {
        tags: ["Drawings"],
        summary: "Replace the caller's private tags on a drawing",
        description:
          "Tags are per-user and private; any member (including viewers) " +
          "may tag a drawing for their own dashboard.",
        requestBody: jsonBody(ref("SetDrawingTagsRequest")),
        responses: {
          "200": json("The drawing with updated tags.", ref("DrawingSummary")),
          "400": invalidRequest,
          "401": unauthorized,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/duplicate": {
      parameters: [drawingIdParameter],
      post: {
        tags: ["Drawings"],
        summary: "Duplicate a drawing into the caller's account",
        description:
          "Copies the scene, asset references, asset blobs, and thumbnail " +
          "into a new drawing owned by the caller. Any member (including " +
          "viewers) may duplicate. History, members, share links, tags, and " +
          "the template flag are not copied. Retrying with the same " +
          "`idempotencyKey` returns the copy already made for that key.",
        requestBody: {
          ...jsonBody(ref("DuplicateDrawingRequest")),
          required: false,
        },
        responses: {
          "201": json("The new copy.", ref("DrawingSummary")),
          "400": invalidRequest,
          "401": unauthorized,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/restore": {
      parameters: [drawingIdParameter],
      post: {
        tags: ["Drawings"],
        summary: "Restore a trashed drawing (owner only)",
        description:
          "Moves a drawing out of the trash. Members and share links were " +
          "never removed by the soft delete, so access resumes exactly as " +
          "before the deletion. A drawing whose permanent deletion has " +
          "already begun can no longer be restored. Distinct from the " +
          "revision-restore endpoint, which restores a drawing's content " +
          "to an earlier revision.",
        responses: {
          "200": json("The restored drawing.", ref("DrawingSummary")),
          "401": unauthorized,
          "404": problem(
            "Not trashed, not owned by the caller, or its purge has begun.",
          ),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/permanent": {
      parameters: [drawingIdParameter],
      delete: {
        tags: ["Drawings"],
        summary: "Permanently delete a trashed drawing (owner only)",
        description:
          "Only drawings already in the trash can be permanently deleted. " +
          "Removes the asset blobs and thumbnail from object storage, then " +
          "the drawing row and everything attached to it. Irreversible.",
        responses: {
          "204": { description: "Permanently deleted." },
          "401": unauthorized,
          "404": problem(
            "Not trashed, not owned by the caller, or already purged.",
          ),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/members/me": {
      parameters: [drawingIdParameter],
      delete: {
        tags: ["Drawings"],
        summary: "Leave a shared drawing",
        responses: {
          "204": { description: "Membership removed." },
          "401": unauthorized,
          "404": notFound,
          "409": problem("`OWNER_CANNOT_LEAVE`: owners must transfer first."),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/transfer-ownership": {
      parameters: [drawingIdParameter],
      post: {
        tags: ["Drawings"],
        summary: "Transfer ownership to another member (owner only)",
        requestBody: jsonBody({
          type: "object",
          required: ["newOwnerUserId"],
          additionalProperties: false,
          properties: { newOwnerUserId: uuid },
        }),
        responses: {
          "200": json(
            "The drawing under its new owner.",
            ref("DrawingSummary"),
          ),
          "401": unauthorized,
          "403": forbidden,
          "404": problem("Drawing or target user not found."),
          "409": problem("`INVALID_OWNERSHIP_TARGET`: already the owner."),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/content": {
      parameters: [drawingIdParameter],
      get: {
        tags: ["Content"],
        summary: "Load the current scene",
        responses: {
          "200": {
            ...json("The scene and its revision.", ref("ContentResponse")),
            headers: {
              ETag: {
                description: "Current content revision, quoted.",
                schema: { type: "string" },
              },
            },
          },
          "401": unauthorized,
          "404": notFound,
        },
      },
      put: {
        tags: ["Content"],
        summary: "Save the scene (conflict-safe autosave)",
        description:
          "Optimistic concurrency via `If-Match` with the last seen revision " +
          "plus an `Idempotency-Key` so retried saves replay instead of " +
          "double-applying. Every asset referenced by the scene must be " +
          "uploaded before it may be referenced.",
        parameters: [
          {
            name: "If-Match",
            in: "header",
            required: true,
            description: "Last seen content revision (quoted or bare).",
            schema: { type: "string" },
          },
          {
            name: "Idempotency-Key",
            in: "header",
            required: true,
            description: "Client-generated UUID identifying this save.",
            schema: uuid,
          },
        ],
        requestBody: jsonBody(ref("SaveContentRequest")),
        responses: {
          "200": {
            ...json("Saved (or replayed).", ref("SaveContentResponse")),
            headers: {
              ETag: {
                description: "New content revision, quoted.",
                schema: { type: "string" },
              },
            },
          },
          "400": invalidRequest,
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
          "409": problem(
            "`IDEMPOTENCY_MISMATCH`: key reused for a different payload.",
          ),
          "412": problem(
            "`VERSION_CONFLICT`: the drawing has changed; reload first.",
          ),
          "413": problem(
            "`SCENE_TOO_LARGE`: the serialized scene exceeds 10 MiB.",
          ),
          "422": problem(
            "`MISSING_ASSET` or `ASSET_MANIFEST_MISMATCH`: the scene " +
              "references assets that are absent or not in the manifest.",
          ),
          "428": problem("`PRECONDITION_REQUIRED`: `If-Match` is missing."),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/revisions": {
      parameters: [drawingIdParameter],
      get: {
        tags: ["Content"],
        summary: "List restorable revisions",
        responses: {
          "200": json(
            "Checkpoint and restore revisions.",
            ref("RevisionListResponse"),
          ),
          "401": unauthorized,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/revisions/{revision}/restore": {
      parameters: [
        drawingIdParameter,
        { name: "revision", in: "path", required: true, schema: revision },
      ],
      post: {
        tags: ["Content"],
        summary: "Restore a previous revision",
        description:
          "Writes the historical scene as a new head revision and asks " +
          "connected collaborators to resync.",
        responses: {
          "200": {
            ...json("Restored as a new revision.", ref("SaveContentResponse")),
            headers: {
              ETag: {
                description: "New content revision, quoted.",
                schema: { type: "string" },
              },
            },
          },
          "401": unauthorized,
          "403": forbidden,
          "404": problem("Drawing or revision not found."),
          "422": problem(
            "`MISSING_ASSET`: the revision references purged assets.",
          ),
        },
      },
    },
    "/api/v1/library": {
      get: {
        tags: ["Library"],
        summary: "Load the signed-in user's shape library",
        responses: {
          "200": json(
            "The stored library items and when they were last saved.",
            ref("LibraryResponse"),
          ),
          "401": unauthorized,
        },
      },
      put: {
        tags: ["Library"],
        summary: "Replace the signed-in user's shape library",
        description:
          "Last-write-wins: the posted items overwrite the stored library " +
          "in a single row per user.",
        requestBody: jsonBody(ref("SaveLibraryRequest")),
        responses: {
          "200": json(
            "The saved library items and their new timestamp.",
            ref("LibraryResponse"),
          ),
          "400": invalidRequest,
          "401": unauthorized,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/members": {
      parameters: [drawingIdParameter],
      get: {
        tags: ["Sharing"],
        summary: "List members and pending invitations",
        responses: {
          "200": json("Members and invitations.", ref("MemberListResponse")),
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/invitations": {
      parameters: [drawingIdParameter],
      post: {
        tags: ["Sharing"],
        summary: "Invite by email (owner only)",
        description:
          "Existing users are added as members immediately; unknown emails " +
          "receive a 7-day invitation. Without SMTP the response carries a " +
          "`manualUrl` for out-of-band delivery.",
        requestBody: jsonBody(ref("CreateInvitationRequest")),
        responses: {
          "201": json(
            "The resulting membership or invitation.",
            ref("CreateInvitationResponse"),
          ),
          "400": invalidRequest,
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/members/{userId}": {
      parameters: [
        drawingIdParameter,
        { name: "userId", in: "path", required: true, schema: uuid },
      ],
      patch: {
        tags: ["Sharing"],
        summary: "Change a member's role (owner only)",
        requestBody: jsonBody({
          type: "object",
          required: ["role"],
          additionalProperties: false,
          properties: { role: memberRole },
        }),
        responses: {
          "204": { description: "Role updated." },
          "400": invalidRequest,
          "401": unauthorized,
          "403": forbidden,
          "404": problem("Drawing or member not found."),
        },
      },
      delete: {
        tags: ["Sharing"],
        summary: "Remove a member (owner only)",
        responses: {
          "204": { description: "Member removed." },
          "401": unauthorized,
          "403": forbidden,
          "404": problem("Drawing or member not found."),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/invitations/{invitationId}": {
      parameters: [
        drawingIdParameter,
        { name: "invitationId", in: "path", required: true, schema: uuid },
      ],
      delete: {
        tags: ["Sharing"],
        summary: "Revoke a pending invitation (owner only)",
        responses: {
          "204": { description: "Invitation revoked." },
          "401": unauthorized,
          "403": forbidden,
          "404": problem("Drawing or invitation not found."),
        },
      },
    },
    "/api/v1/invitations/{token}": {
      parameters: [
        {
          name: "token",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        },
      ],
      get: {
        tags: ["Sharing"],
        summary: "Inspect an invitation token",
        security: [],
        responses: {
          "200": json(
            "The invitation and drawing title.",
            ref("InvitationInspectResponse"),
          ),
          "404": problem("`INVITATION_NOT_FOUND`."),
        },
      },
    },
    "/api/v1/invitations/{token}/accept": {
      parameters: [
        {
          name: "token",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
        },
      ],
      post: {
        tags: ["Sharing"],
        summary: "Accept an invitation",
        description:
          "The signed-in account must match the invited email. Deployments " +
          "with SMTP additionally require the email to be verified.",
        responses: {
          "200": json("The new membership.", ref("AcceptInvitationResponse")),
          "401": unauthorized,
          "403": problem(
            "`INVITATION_EMAIL_MISMATCH` or `EMAIL_VERIFICATION_REQUIRED`.",
          ),
          "404": problem("`INVITATION_NOT_FOUND`."),
          "409": problem("`INVITATION_USED`: already accepted."),
          "410": problem("`INVITATION_EXPIRED` or `INVITATION_REVOKED`."),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/share-link": {
      parameters: [drawingIdParameter],
      get: {
        tags: ["Sharing"],
        summary: "Read the public share link (owner only)",
        responses: {
          "200": json("Share link status.", ref("ShareLinkStatus")),
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
        },
      },
      post: {
        tags: ["Sharing"],
        summary: "Create or regenerate the public share link (owner only)",
        description:
          "Creates a read-only public link, revoking any previous link for " +
          "the drawing. Live share viewers on a replaced link are " +
          "disconnected.",
        responses: {
          "200": json("The new share link.", ref("CreateShareLinkResponse")),
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
        },
      },
      delete: {
        tags: ["Sharing"],
        summary: "Revoke the public share link (owner only)",
        responses: {
          "204": { description: "Share link revoked." },
          "401": unauthorized,
          "403": forbidden,
          "404": problem("Drawing or share link not found."),
        },
      },
    },
    "/api/v1/share/{token}": {
      parameters: [shareTokenParameter],
      get: {
        tags: ["Sharing"],
        summary: "Read a publicly shared drawing",
        description:
          "Unauthenticated read-only access via an active share link. Live " +
          "updates are delivered over Socket.IO using the same token in the " +
          "handshake `auth.shareToken` field.",
        security: [],
        responses: {
          "200": json("The shared drawing.", ref("SharedDrawing")),
          "404": problem("`SHARE_LINK_NOT_FOUND`."),
        },
      },
    },
    "/api/v1/share/{token}/assets/{fileId}": {
      parameters: [
        shareTokenParameter,
        {
          name: "fileId",
          in: "path",
          required: true,
          description: "Excalidraw file id of the embedded asset.",
          schema: {
            type: "string",
            maxLength: 256,
            pattern: "^[A-Za-z0-9_-]+$",
          },
        },
      ],
      get: {
        tags: ["Assets"],
        summary: "Download an asset of a publicly shared drawing",
        security: [],
        responses: {
          "200": {
            description:
              "The asset bytes, served as an attachment with a sandboxing " +
              "CSP and immutable caching.",
            content: {
              "image/*": { schema: { type: "string", format: "binary" } },
            },
          },
          "404": problem("`ASSET_NOT_FOUND`: unknown asset or inactive link."),
        },
      },
    },
    "/api/v1/drawings/{drawingId}/messages": {
      parameters: [drawingIdParameter],
      get: {
        tags: ["Chat"],
        summary: "Read chat history",
        description:
          "Newest-first pages of persisted chat messages. Sending messages " +
          "happens over the Socket.IO `chat.send` event.",
        parameters: [
          {
            name: "before",
            in: "query",
            required: false,
            description: "Opaque cursor from a previous page's `nextCursor`.",
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": json("A page of messages.", ref("ChatHistoryResponse")),
          "401": unauthorized,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/assets/{fileId}": {
      parameters: [
        drawingIdParameter,
        {
          name: "fileId",
          in: "path",
          required: true,
          description: "Excalidraw file id of the embedded asset.",
          schema: {
            type: "string",
            maxLength: 256,
            pattern: "^[A-Za-z0-9_-]+$",
          },
        },
      ],
      put: {
        tags: ["Assets"],
        summary: "Upload a binary asset",
        description:
          "Raw image bytes (4 MiB max by default). The declared " +
          "`Content-Type` must match the sniffed image type and the body " +
          "must match the declared SHA-256. Re-uploading identical content " +
          "returns `200` instead of `201`.",
        parameters: [
          {
            name: "x-content-sha256",
            in: "header",
            required: true,
            description: "Hex SHA-256 digest of the request body.",
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
          {
            name: "x-excalidraw-file-version",
            in: "header",
            required: false,
            description: "Excalidraw file version counter, when known.",
            schema: { type: "integer", minimum: 1 },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "image/*": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: {
          "200": json("Identical asset already existed.", ref("AssetMetadata")),
          "201": json("Asset stored.", ref("AssetMetadata")),
          "400": problem(
            "Invalid body, checksum, media type, or file version.",
          ),
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
          "413": problem("`ASSET_TOO_LARGE`: exceeds the size limit."),
        },
      },
      get: {
        tags: ["Assets"],
        summary: "Download a binary asset",
        responses: {
          "200": {
            description:
              "The asset bytes, served as an attachment with a sandboxing " +
              "CSP and immutable caching.",
            content: {
              "image/*": { schema: { type: "string", format: "binary" } },
            },
          },
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
        },
      },
    },
    "/api/v1/drawings/{drawingId}/thumbnail": {
      parameters: [drawingIdParameter],
      put: {
        tags: ["Assets"],
        summary: "Replace the dashboard thumbnail",
        description:
          "Raw PNG bytes (512 KiB max) rendered client-side from the scene. " +
          "The body must match the declared SHA-256. Replaces the previous " +
          "thumbnail; the summary's `thumbnailUpdatedAt` is bumped.",
        parameters: [
          {
            name: "x-content-sha256",
            in: "header",
            required: true,
            description: "Hex SHA-256 digest of the request body.",
            schema: { type: "string", pattern: "^[a-f0-9]{64}$" },
          },
        ],
        requestBody: {
          required: true,
          content: {
            "image/png": { schema: { type: "string", format: "binary" } },
          },
        },
        responses: {
          "204": { description: "Thumbnail stored." },
          "400": problem("Invalid body or checksum."),
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
          "409": problem(
            "`THUMBNAIL_WRITE_CONFLICT`: a concurrent writer replaced the " +
              "thumbnail; retry after the next edit.",
          ),
          "413": problem("`THUMBNAIL_TOO_LARGE`: exceeds 512 KiB."),
          "415": problem(
            "`UNSUPPORTED_THUMBNAIL_TYPE`: not image/png, or " +
              "`ASSET_MIME_MISMATCH`: the bytes are not PNG.",
          ),
          "422": problem(
            "`ASSET_CHECKSUM_MISMATCH`: the body does not match the " +
              "declared checksum.",
          ),
        },
      },
      get: {
        tags: ["Assets"],
        summary: "Download the dashboard thumbnail",
        responses: {
          "200": {
            description:
              "The PNG bytes with immutable caching; clients bust the URL " +
              "with `?v=<thumbnailUpdatedAt>`.",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
            },
          },
          "401": unauthorized,
          "404": problem(
            "`THUMBNAIL_NOT_FOUND`: no thumbnail yet, or no access.",
          ),
        },
      },
      delete: {
        tags: ["Assets"],
        summary: "Remove the dashboard thumbnail",
        description: "Used when the scene becomes empty.",
        responses: {
          "204": { description: "Thumbnail removed." },
          "401": unauthorized,
          "403": forbidden,
          "404": notFound,
        },
      },
    },
  },
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "better-auth.session_token",
        description:
          "Session cookie issued by the better-auth endpoints under /api/auth.",
      },
      adminToken: {
        type: "http",
        scheme: "bearer",
        description: "The deployment's ADMIN_RESET_TOKEN.",
      },
    },
    schemas: {
      HealthStatus: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "ready", "unavailable"] },
        },
      },
      ProblemDetails: {
        type: "object",
        description: "RFC 9457 style problem document.",
        required: ["code", "status", "title", "requestId"],
        properties: {
          code: {
            type: "string",
            description: "Stable machine-readable code.",
          },
          status: { type: "integer", minimum: 400, maximum: 599 },
          title: { type: "string" },
          detail: { type: "string" },
          requestId: { type: "string" },
          errors: {
            type: "object",
            description: "Per-field validation messages.",
            additionalProperties: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
      AdminError: {
        type: "object",
        required: ["error"],
        properties: { error: { type: "string" } },
      },
      ManualResetLinkResponse: {
        type: "object",
        required: ["email", "expiresAt", "reason", "url"],
        properties: {
          email: { type: "string", format: "email" },
          expiresAt: isoDateTime,
          reason: { type: "string" },
          url: { type: "string", format: "uri" },
        },
      },
      AuthCapabilities: {
        type: "object",
        required: [
          "emailPassword",
          "google",
          "github",
          "oidc",
          "oidcProviderName",
          "smtp",
        ],
        properties: {
          emailPassword: { type: "boolean" },
          google: { type: "boolean" },
          github: { type: "boolean" },
          oidc: { type: "boolean" },
          oidcProviderName: { type: "string", minLength: 1 },
          smtp: { type: "boolean" },
        },
      },
      CurrentUser: {
        type: "object",
        required: [
          "id",
          "email",
          "name",
          "image",
          "emailVerified",
          "isAdmin",
          "createdAt",
        ],
        properties: {
          id: uuid,
          email: { type: "string", format: "email" },
          name: { type: "string", maxLength: 120 },
          image: { type: "string", format: "uri", nullable: true },
          emailVerified: { type: "boolean" },
          isAdmin: {
            type: "boolean",
            description:
              "Whether this user has a verified email listed in `ADMIN_EMAILS`.",
          },
          createdAt: isoDateTime,
        },
      },
      SessionResponse: {
        type: "object",
        required: ["user", "capabilities"],
        properties: {
          user: { ...ref("CurrentUser"), nullable: true },
          capabilities: ref("AuthCapabilities"),
        },
      },
      DrawingSummary: {
        type: "object",
        required: [
          "id",
          "title",
          "ownerUserId",
          "ownerName",
          "role",
          "tags",
          "contentRevision",
          "metadataRevision",
          "createdAt",
          "updatedAt",
        ],
        properties: {
          id: uuid,
          title: { type: "string", maxLength: 120 },
          ownerUserId: uuid,
          ownerName: { type: "string", maxLength: 120 },
          role: role,
          tags: {
            type: "array",
            maxItems: 20,
            items: { type: "string", maxLength: 32 },
            description: "The requesting user's private tags.",
          },
          contentRevision: revision,
          metadataRevision: revision,
          createdAt: isoDateTime,
          updatedAt: isoDateTime,
          thumbnailUpdatedAt: {
            ...isoDateTime,
            nullable: true,
            description:
              "When the dashboard thumbnail was last replaced; null until " +
              "a client has rendered one.",
          },
          isTemplate: {
            type: "boolean",
            description:
              "Templates appear in the dashboard's " +
              "“New from template” list.",
          },
        },
      },
      DrawingListResponse: {
        type: "object",
        required: ["owned", "shared", "nextCursor"],
        properties: {
          owned: { type: "array", items: ref("DrawingSummary") },
          shared: { type: "array", items: ref("DrawingSummary") },
          nextCursor: { type: "string", nullable: true },
        },
      },
      TrashedDrawing: {
        allOf: [
          ref("DrawingSummary"),
          {
            type: "object",
            required: ["deletedAt"],
            properties: {
              deletedAt: {
                ...isoDateTime,
                description: "When the drawing was moved to the trash.",
              },
            },
          },
        ],
      },
      TrashListResponse: {
        type: "object",
        required: ["drawings"],
        properties: {
          drawings: { type: "array", items: ref("TrashedDrawing") },
        },
      },
      CreateDrawingRequest: {
        type: "object",
        required: ["title"],
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          idempotencyKey: uuid,
        },
      },
      DuplicateDrawingRequest: {
        type: "object",
        additionalProperties: false,
        properties: {
          idempotencyKey: uuid,
        },
      },
      UpdateDrawingRequest: {
        type: "object",
        required: ["title", "metadataRevision"],
        additionalProperties: false,
        properties: {
          title: { type: "string", minLength: 1, maxLength: 120 },
          metadataRevision: revision,
          isTemplate: { type: "boolean" },
        },
      },
      SetDrawingTagsRequest: {
        type: "object",
        required: ["tags"],
        additionalProperties: false,
        properties: {
          tags: {
            type: "array",
            maxItems: 20,
            items: { type: "string", minLength: 1, maxLength: 32 },
          },
        },
      },
      ShareLinkStatus: {
        oneOf: [
          {
            type: "object",
            required: ["active", "url", "createdAt"],
            additionalProperties: false,
            properties: {
              active: { type: "boolean", enum: [true] },
              url: {
                type: "string",
                format: "uri",
                description: "The public share URL.",
              },
              createdAt: isoDateTime,
            },
          },
          {
            type: "object",
            required: ["active"],
            additionalProperties: false,
            properties: {
              active: { type: "boolean", enum: [false] },
            },
          },
        ],
      },
      CreateShareLinkResponse: {
        type: "object",
        required: ["url", "createdAt"],
        additionalProperties: false,
        properties: {
          url: { type: "string", format: "uri" },
          createdAt: isoDateTime,
        },
      },
      SharedDrawing: {
        type: "object",
        required: ["drawingId", "title", "scene", "revision"],
        additionalProperties: false,
        properties: {
          drawingId: uuid,
          title: { type: "string", maxLength: 120 },
          scene: ref("SceneEnvelope"),
          revision: revision,
        },
      },
      SceneEnvelope: {
        type: "object",
        description: "Excalidraw scene export envelope.",
        required: ["type", "version", "source", "elements", "appState"],
        properties: {
          type: { type: "string", enum: ["excalidraw"] },
          version: { type: "integer", minimum: 0 },
          source: { type: "string", maxLength: 2048 },
          elements: {
            type: "array",
            maxItems: 50000,
            items: {
              type: "object",
              description:
                "Excalidraw element; extra properties are preserved.",
              required: ["id", "type", "version", "versionNonce", "isDeleted"],
              properties: {
                id: { type: "string" },
                type: { type: "string" },
                version: { type: "integer" },
                versionNonce: { type: "integer" },
                isDeleted: { type: "boolean" },
              },
            },
          },
          appState: { type: "object" },
        },
      },
      ContentResponse: {
        type: "object",
        required: ["revision", "scene", "assetIds", "savedAt"],
        properties: {
          revision: revision,
          scene: ref("SceneEnvelope"),
          assetIds: {
            type: "array",
            items: { type: "string" },
            description: "File ids of every asset the scene references.",
          },
          savedAt: isoDateTime,
        },
      },
      SaveContentRequest: {
        type: "object",
        required: ["scene", "assetIds"],
        additionalProperties: false,
        properties: {
          scene: ref("SceneEnvelope"),
          assetIds: {
            type: "array",
            items: { type: "string" },
            description:
              "Sorted, de-duplicated manifest of every referenced asset.",
          },
        },
      },
      SaveContentResponse: {
        type: "object",
        required: ["revision", "savedAt"],
        properties: { revision: revision, savedAt: isoDateTime },
      },
      RevisionListResponse: {
        type: "object",
        required: ["revisions"],
        properties: {
          revisions: {
            type: "array",
            items: {
              type: "object",
              required: ["revision", "reason", "authorUserId", "createdAt"],
              properties: {
                revision: revision,
                reason: { type: "string", enum: ["checkpoint", "restore"] },
                authorUserId: {
                  ...uuid,
                  nullable: true,
                  description: "Null when the authoring account was deleted.",
                },
                createdAt: isoDateTime,
              },
            },
          },
        },
      },
      AdminOverview: {
        type: "object",
        required: ["users", "drawings", "storageBytes"],
        properties: {
          users: { type: "integer", minimum: 0 },
          drawings: {
            type: "integer",
            minimum: 0,
            description: "Active (non-trashed) drawings.",
          },
          storageBytes: {
            type: "integer",
            minimum: 0,
            description: "Total bytes of active drawing assets.",
          },
        },
      },
      AdminUser: {
        type: "object",
        required: [
          "id",
          "name",
          "email",
          "emailVerified",
          "createdAt",
          "disabledAt",
          "drawingCount",
        ],
        properties: {
          id: uuid,
          name: { type: "string", maxLength: 120 },
          email: { type: "string", format: "email" },
          emailVerified: { type: "boolean" },
          createdAt: isoDateTime,
          disabledAt: {
            ...isoDateTime,
            nullable: true,
            description: "Null when active; a timestamp when disabled.",
          },
          drawingCount: {
            type: "integer",
            minimum: 0,
            description: "Active drawings the user owns.",
          },
        },
      },
      AdminUserList: {
        type: "object",
        required: ["users", "total"],
        properties: {
          users: { type: "array", items: ref("AdminUser") },
          total: {
            type: "integer",
            minimum: 0,
            description: "Users matching the search, ignoring the limit.",
          },
        },
      },
      LibraryItem: {
        type: "object",
        description:
          "An Excalidraw library item; extra properties are preserved.",
        required: ["id"],
        properties: { id: { type: "string", minLength: 1, maxLength: 256 } },
      },
      LibraryResponse: {
        type: "object",
        required: ["items", "updatedAt"],
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            maxItems: 500,
            items: ref("LibraryItem"),
          },
          updatedAt: isoDateTime,
        },
      },
      SaveLibraryRequest: {
        type: "object",
        required: ["items"],
        additionalProperties: false,
        properties: {
          items: {
            type: "array",
            maxItems: 500,
            items: ref("LibraryItem"),
          },
        },
      },
      DrawingMember: {
        type: "object",
        required: ["userId", "email", "name", "image", "role", "createdAt"],
        properties: {
          userId: uuid,
          email: { type: "string", format: "email" },
          name: { type: "string", maxLength: 120 },
          image: { type: "string", format: "uri", nullable: true },
          role: role,
          createdAt: isoDateTime,
        },
      },
      Invitation: {
        type: "object",
        required: [
          "id",
          "drawingId",
          "email",
          "role",
          "status",
          "expiresAt",
          "createdAt",
        ],
        properties: {
          id: uuid,
          drawingId: uuid,
          email: { type: "string", format: "email" },
          role: memberRole,
          status: {
            type: "string",
            enum: ["pending", "accepted", "revoked", "expired"],
          },
          expiresAt: isoDateTime,
          createdAt: isoDateTime,
        },
      },
      MemberListResponse: {
        type: "object",
        required: ["members", "invitations"],
        properties: {
          members: { type: "array", items: ref("DrawingMember") },
          invitations: { type: "array", items: ref("Invitation") },
        },
      },
      CreateInvitationRequest: {
        type: "object",
        required: ["email", "role"],
        additionalProperties: false,
        properties: {
          email: { type: "string", format: "email" },
          role: memberRole,
        },
      },
      CreateInvitationResponse: {
        type: "object",
        required: ["deliveryStatus"],
        description:
          "Exactly one of `membership` (the email already had an account) " +
          "or `invitation` is present.",
        properties: {
          membership: ref("DrawingMember"),
          invitation: ref("Invitation"),
          deliveryStatus: {
            type: "string",
            enum: ["sent", "manual", "failed", "not-needed"],
          },
          manualUrl: {
            type: "string",
            format: "uri",
            description:
              "Invitation link for manual delivery when email was not sent.",
          },
        },
      },
      InvitationInspectResponse: {
        type: "object",
        required: ["invitation", "drawingTitle"],
        properties: {
          invitation: ref("Invitation"),
          drawingTitle: { type: "string" },
        },
      },
      AcceptInvitationResponse: {
        type: "object",
        required: ["membership"],
        properties: { membership: ref("DrawingMember") },
      },
      ChatMessage: {
        type: "object",
        required: [
          "id",
          "drawingId",
          "userId",
          "authorName",
          "body",
          "createdAt",
        ],
        properties: {
          id: uuid,
          drawingId: uuid,
          userId: uuid,
          authorName: { type: "string", maxLength: 120 },
          body: { type: "string", maxLength: 4000 },
          createdAt: isoDateTime,
        },
      },
      ChatHistoryResponse: {
        type: "object",
        required: ["messages", "nextCursor"],
        properties: {
          messages: { type: "array", items: ref("ChatMessage") },
          nextCursor: {
            type: "string",
            nullable: true,
            description: "Pass as `before` to fetch the next older page.",
          },
        },
      },
      AssetMetadata: {
        type: "object",
        required: [
          "id",
          "drawingId",
          "fileId",
          "mimeType",
          "byteSize",
          "sha256",
          "fileVersion",
          "createdAt",
        ],
        properties: {
          id: uuid,
          drawingId: uuid,
          fileId: { type: "string", maxLength: 256 },
          mimeType: { type: "string" },
          byteSize: { type: "integer", minimum: 0 },
          sha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
          fileVersion: { type: "integer", minimum: 1, nullable: true },
          createdAt: isoDateTime,
        },
      },
    },
  },
};
