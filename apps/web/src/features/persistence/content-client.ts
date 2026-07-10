import {
  contentResponseSchema,
  problemDetailsSchema,
  saveContentResponseSchema,
  type ContentResponse,
  type ProblemDetails,
  type SaveContentRequest,
} from "@open-excalidraw/contracts";

export class ContentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(
      problem?.detail ?? problem?.title ?? `Content request failed (${status})`,
    );
    this.name = "ContentRequestError";
  }
}

export class VersionConflictError extends ContentRequestError {
  constructor(
    problem: ProblemDetails | null,
    readonly localRevision: string,
    readonly server: LoadedContent | null,
  ) {
    super(412, problem);
    this.name = "VersionConflictError";
  }
}

export interface LoadedContent {
  content: ContentResponse;
  revision: string;
}

export interface SavedContent {
  revision: string;
  savedAt: string;
}

export interface ContentClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class ContentClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor({
    baseUrl = "/api/v1",
    fetch = globalThis.fetch,
  }: ContentClientOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetch;
  }

  async load(drawingId: string): Promise<LoadedContent> {
    const response = await this.#fetch(this.#url(drawingId), {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new ContentRequestError(
        response.status,
        await readProblem(response),
      );
    }
    const content = contentResponseSchema.parse(await response.json());
    return {
      content,
      revision: readRevision(response.headers.get("etag")) ?? content.revision,
    };
  }

  async save(
    drawingId: string,
    request: SaveContentRequest,
    revision: string,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<SavedContent> {
    const response = await this.#fetch(this.#url(drawingId), {
      body: JSON.stringify(request),
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "if-match": quoteRevision(revision),
      },
      method: "PUT",
      signal,
    });

    if (response.status === 412) {
      const problem = await readProblem(response);
      let server: LoadedContent | null = null;
      try {
        server = await this.load(drawingId);
      } catch {
        // A conflict remains actionable even if the follow-up load is offline.
      }
      throw new VersionConflictError(problem, revision, server);
    }
    if (!response.ok) {
      throw new ContentRequestError(
        response.status,
        await readProblem(response),
      );
    }

    const saved = saveContentResponseSchema.parse(await response.json());
    return {
      revision: readRevision(response.headers.get("etag")) ?? saved.revision,
      savedAt: saved.savedAt,
    };
  }

  #url(drawingId: string) {
    return `${this.#baseUrl}/drawings/${encodeURIComponent(drawingId)}/content`;
  }
}

export const quoteRevision = (revision: string) => `"${revision}"`;

export const readRevision = (etag: string | null): string | null => {
  if (!etag) {
    return null;
  }
  const match = /^(?:W\/)?"(0|[1-9]\d*)"$/.exec(etag.trim());
  return match?.[1] ?? null;
};

const readProblem = async (
  response: Response,
): Promise<ProblemDetails | null> => {
  try {
    const parsed = problemDetailsSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};
