/**
 * OpenAPI 3.0 document for the versioned REST API. Component schemas that
 * have a zod contract in @open-excalidraw/contracts are generated from it at
 * module load and cannot drift; paths and the few server-only schemas are
 * hand-authored — update those together with route changes.
 * Realtime collaboration (scene mutations, presence, chat sends) runs over
 * Socket.IO at /socket.io and is documented in docs/operations/collaboration.md
 * rather than here.
 */
import {
  adminOverviewSchema,
  adminSettingsSchema,
  adminSettingsUpdateSchema,
  adminUserListSchema,
  adminUserQuotaUpdateSchema,
  adminUserSchema,
  assetMetadataSchema,
  authCapabilitiesSchema,
  chatHistoryResponseSchema,
  chatMessageSchema,
  contentResponseSchema,
  createDrawingRequestSchema,
  createInvitationRequestSchema,
  createInvitationResponseSchema,
  createShareLinkResponseSchema,
  currentUserSchema,
  drawingListResponseSchema,
  drawingMemberSchema,
  drawingSummarySchema,
  duplicateDrawingRequestSchema,
  invitationSchema,
  libraryItemSchema,
  libraryResponseSchema,
  personalAccessTokenCreateSchema,
  personalAccessTokenCreatedSchema,
  personalAccessTokenListSchema,
  personalAccessTokenSchema,
  problemDetailsSchema,
  saveContentRequestSchema,
  saveContentResponseSchema,
  saveLibraryRequestSchema,
  sceneEnvelopeSchema,
  sessionResponseSchema,
  setDrawingTagsRequestSchema,
  sharedDrawingResponseSchema,
  trashedDrawingSchema,
  trashListResponseSchema,
  updateDrawingRequestSchema,
} from "@open-excalidraw/contracts";
import { z } from "zod";

/** OpenAPI component name → the zod contract it mirrors. */
const contractSchemas = {
  AdminOverview: adminOverviewSchema,
  AdminSettings: adminSettingsSchema,
  AdminSettingsUpdate: adminSettingsUpdateSchema,
  AdminUser: adminUserSchema,
  AdminUserList: adminUserListSchema,
  AdminUserQuotaUpdate: adminUserQuotaUpdateSchema,
  AssetMetadata: assetMetadataSchema,
  AuthCapabilities: authCapabilitiesSchema,
  ChatHistoryResponse: chatHistoryResponseSchema,
  ChatMessage: chatMessageSchema,
  ContentResponse: contentResponseSchema,
  CreateDrawingRequest: createDrawingRequestSchema,
  CreateInvitationRequest: createInvitationRequestSchema,
  CreateInvitationResponse: createInvitationResponseSchema,
  CreateShareLinkResponse: createShareLinkResponseSchema,
  CurrentUser: currentUserSchema,
  DrawingListResponse: drawingListResponseSchema,
  DrawingMember: drawingMemberSchema,
  DrawingSummary: drawingSummarySchema,
  DuplicateDrawingRequest: duplicateDrawingRequestSchema,
  Invitation: invitationSchema,
  LibraryItem: libraryItemSchema,
  LibraryResponse: libraryResponseSchema,
  PersonalAccessToken: personalAccessTokenSchema,
  PersonalAccessTokenCreate: personalAccessTokenCreateSchema,
  PersonalAccessTokenCreated: personalAccessTokenCreatedSchema,
  PersonalAccessTokenList: personalAccessTokenListSchema,
  ProblemDetails: problemDetailsSchema,
  SaveContentRequest: saveContentRequestSchema,
  SaveContentResponse: saveContentResponseSchema,
  SaveLibraryRequest: saveLibraryRequestSchema,
  SceneEnvelope: sceneEnvelopeSchema,
  SessionResponse: sessionResponseSchema,
  SetDrawingTagsRequest: setDrawingTagsRequestSchema,
  SharedDrawing: sharedDrawingResponseSchema,
  TrashedDrawing: trashedDrawingSchema,
  TrashListResponse: trashListResponseSchema,
  UpdateDrawingRequest: updateDrawingRequestSchema,
};

const contractRegistry = z.registry<{ id: string }>();
for (const [id, schema] of Object.entries(contractSchemas)) {
  contractRegistry.add(schema, { id });
}

/**
 * zod emits `$id` (not valid in OpenAPI 3.0 schema objects), a redundant
 * `pattern` next to every string `format`, and ±MAX_SAFE_INTEGER bounds on
 * integers; strip them so the served document stays readable.
 */
const tidy = (node: unknown): void => {
  if (Array.isArray(node)) {
    for (const item of node) tidy(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const schema = node as Record<string, unknown>;
  delete schema.$id;
  if (typeof schema.format === "string") delete schema.pattern;
  if (schema.maximum === Number.MAX_SAFE_INTEGER) delete schema.maximum;
  if (schema.minimum === -Number.MAX_SAFE_INTEGER) delete schema.minimum;
  for (const value of Object.values(schema)) tidy(value);
};

const generatedSchemas = z.toJSONSchema(contractRegistry, {
  target: "openapi-3.0",
  io: "output",
  uri: (id) => `#/components/schemas/${id}`,
}).schemas;
tidy(generatedSchemas);

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
      "**Personal access tokens** offer non-interactive access for automation.",
      "Send `Authorization: Bearer oepat_…` and every REST route resolves the",
      "caller from the token instead of the session cookie. Tokens cannot manage",
      "tokens (create/list/revoke stay session-only) or open realtime sessions.",
      "Manage them under `/api/v1/tokens`.",
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
      name: "Tokens",
      description:
        "Personal access tokens for REST automation. Managed from a " +
        "signed-in session only.",
    },
    {
      name: "Admin",
      description:
        "Operator endpoints: loopback-only recovery plus instance and user " +
        "management gated on a verified email listed in `ADMIN_EMAILS`.",
    },
  ],
  security: [{ sessionCookie: [] }, { bearerAuth: [] }],
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
    "/api/v1/tokens": {
      get: {
        tags: ["Tokens"],
        summary: "List your personal access tokens",
        description:
          "The caller's own tokens, newest first. The secret is never " +
          "returned; only `lastFour` identifies each token.",
        security: [{ sessionCookie: [] }],
        responses: {
          "200": json("Your tokens.", ref("PersonalAccessTokenList")),
          "401": unauthorized,
          "403": problem(
            "`TOKEN_MANAGEMENT_REQUIRES_SESSION`: a personal access token " +
              "cannot manage tokens.",
          ),
        },
      },
      post: {
        tags: ["Tokens"],
        summary: "Create a personal access token",
        description:
          "Returns the full secret exactly once in `secret`; store it now, it " +
          "cannot be retrieved later. Each account may hold at most 25 tokens.",
        security: [{ sessionCookie: [] }],
        requestBody: jsonBody(ref("PersonalAccessTokenCreate")),
        responses: {
          "201": json(
            "The created token and its one-time secret.",
            ref("PersonalAccessTokenCreated"),
          ),
          "400": problem(
            "Request validation failed, or `TOKEN_LIMIT_REACHED`: the " +
              "25-token cap is reached.",
          ),
          "401": unauthorized,
          "403": problem(
            "`TOKEN_MANAGEMENT_REQUIRES_SESSION`: a personal access token " +
              "cannot manage tokens.",
          ),
        },
      },
    },
    "/api/v1/tokens/{tokenId}": {
      parameters: [
        { name: "tokenId", in: "path", required: true, schema: uuid },
      ],
      delete: {
        tags: ["Tokens"],
        summary: "Revoke a personal access token",
        description:
          "Immediately and irreversibly revokes one of the caller's own " +
          "tokens.",
        security: [{ sessionCookie: [] }],
        responses: {
          "204": { description: "Revoked." },
          "401": unauthorized,
          "403": problem(
            "`TOKEN_MANAGEMENT_REQUIRES_SESSION`: a personal access token " +
              "cannot manage tokens.",
          ),
          "404": problem(
            "`TOKEN_NOT_FOUND`: no such token belongs to the caller.",
          ),
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
    "/api/v1/admin/settings": {
      get: {
        tags: ["Admin"],
        summary: "Read instance settings",
        description:
          "The instance-wide per-user storage quota and the read-only " +
          "`STORAGE_QUOTA_PER_USER_BYTES` environment fallback. `null` means " +
          "unlimited.",
        responses: {
          "200": json("Instance settings.", ref("AdminSettings")),
          "401": unauthorized,
          "403": problem("Administrator access is required."),
        },
      },
      patch: {
        tags: ["Admin"],
        summary: "Update instance settings",
        description:
          "Sets the instance-wide per-user storage quota (bytes), overriding " +
          "the environment fallback. `null` clears the override and falls " +
          "back to the environment value (unlimited only when that is also " +
          "unset). Writes an audit event.",
        requestBody: jsonBody(ref("AdminSettingsUpdate")),
        responses: {
          "200": json("Updated settings.", ref("AdminSettings")),
          "400": problem("Request validation failed."),
          "401": unauthorized,
          "403": problem("Administrator access is required."),
        },
      },
    },
    "/api/v1/admin/users/{userId}/quota": {
      parameters: [adminUserIdParameter],
      patch: {
        tags: ["Admin"],
        summary: "Set a user's storage quota override",
        description:
          "Sets or clears (`null`) the user's per-user storage quota override " +
          "in bytes, which takes precedence over the instance-wide setting. " +
          "Writes an audit event.",
        requestBody: jsonBody(ref("AdminUserQuotaUpdate")),
        responses: {
          "200": json("The updated user.", ref("AdminUser")),
          "400": problem("Request validation failed."),
          "401": unauthorized,
          "403": problem("Administrator access is required."),
          "404": problem("User not found."),
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
    "/api/v1/admin/users/{userId}/two-factor/disable": {
      parameters: [adminUserIdParameter],
      post: {
        tags: ["Admin"],
        summary: "Reset a user's two-factor enrollment",
        description:
          "Deletes the user's TOTP enrollment and backup codes and clears " +
          "`twoFactorEnabled`, so a user who lost both their device and " +
          "backup codes can sign in and re-enroll. Idempotent when the user " +
          "has no enrollment.",
        responses: {
          "204": { description: "Two-factor enrollment reset." },
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
        description:
          "A client may supply its own `id` (offline-created drawings mint " +
          "the primary key locally); omitting it lets the server assign one.",
        requestBody: jsonBody(ref("CreateDrawingRequest")),
        responses: {
          "201": json("The created drawing.", ref("DrawingSummary")),
          "400": invalidRequest,
          "401": unauthorized,
          "409": problem(
            "`DRAWING_ID_CONFLICT`: the supplied id belongs to another user. Re-creating an id you own replays the existing drawing.",
          ),
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
          "413": problem(
            "`ASSET_TOO_LARGE`: exceeds the size limit, or " +
              "`STORAGE_QUOTA_EXCEEDED`: the owner's storage quota is full.",
          ),
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
      bearerAuth: {
        type: "http",
        scheme: "bearer",
        description:
          "A personal access token (`oepat_…`) created under /api/v1/tokens. " +
          "Authenticates any REST route in place of the session cookie, but " +
          "cannot manage tokens or open realtime collaboration sessions.",
      },
    },
    schemas: {
      // Hand-written: server-only shapes with no zod contract.
      // ShareLinkStatus also stays manual — its discriminated oneOf is
      // richer than the contract's refine().
      HealthStatus: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["ok", "ready", "unavailable"] },
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
      MemberListResponse: {
        type: "object",
        required: ["members", "invitations"],
        properties: {
          members: { type: "array", items: ref("DrawingMember") },
          invitations: { type: "array", items: ref("Invitation") },
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
      ...generatedSchemas,
    },
  },
};
