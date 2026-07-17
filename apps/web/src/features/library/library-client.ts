import {
  libraryResponseSchema,
  problemDetailsSchema,
  type LibraryItem,
  type LibraryResponse,
  type ProblemDetails,
  type SaveLibraryRequest,
} from "@open-excalidraw/contracts";

export class LibraryRequestError extends Error {
  constructor(
    readonly status: number,
    readonly problem: ProblemDetails | null,
  ) {
    super(
      problem?.detail ?? problem?.title ?? `Library request failed (${status})`,
    );
    this.name = "LibraryRequestError";
  }
}

export interface LibraryClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class LibraryClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor({
    baseUrl = "/api/v1",
    fetch = globalThis.fetch.bind(globalThis),
  }: LibraryClientOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetch;
  }

  async load(): Promise<LibraryResponse> {
    const response = await this.#fetch(this.#url(), {
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new LibraryRequestError(
        response.status,
        await readProblem(response),
      );
    }
    return libraryResponseSchema.parse(await response.json());
  }

  async save(items: readonly LibraryItem[]): Promise<LibraryResponse> {
    const request: SaveLibraryRequest = { items: items as LibraryItem[] };
    const response = await this.#fetch(this.#url(), {
      body: JSON.stringify(request),
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "PUT",
    });
    if (!response.ok) {
      throw new LibraryRequestError(
        response.status,
        await readProblem(response),
      );
    }
    return libraryResponseSchema.parse(await response.json());
  }

  #url() {
    return `${this.#baseUrl}/library`;
  }
}

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
