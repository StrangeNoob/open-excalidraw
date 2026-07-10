import {
  problemDetailsSchema,
  type ProblemDetails,
} from "@open-excalidraw/contracts";
import type { ZodType } from "zod";

export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails | null;

  constructor(status: number, problem: ProblemDetails | null) {
    super(
      problem?.detail ??
        problem?.title ??
        `Request failed with status ${status}`,
    );
    this.name = "ApiError";
    this.status = status;
    this.problem = problem;
  }
}

export interface HttpApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class HttpApiClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor({
    baseUrl = "/api",
    fetch = globalThis.fetch,
  }: HttpApiClientOptions = {}) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#fetch = fetch;
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    responseSchema?: ZodType<T>,
  ): Promise<T> {
    const headers = new Headers(init.headers);

    if (typeof init.body === "string" && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await this.#fetch(
      `${this.#baseUrl}${normalizePath(path)}`,
      {
        ...init,
        credentials: "include",
        headers,
      },
    );

    if (!response.ok) {
      throw new ApiError(response.status, await parseProblem(response));
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const body: unknown = await response.json();
    return responseSchema ? responseSchema.parse(body) : (body as T);
  }
}

const normalizePath = (path: string) =>
  path.startsWith("/") ? path : `/${path}`;

const parseProblem = async (
  response: Response,
): Promise<ProblemDetails | null> => {
  try {
    const result = problemDetailsSchema.safeParse(await response.json());
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};
