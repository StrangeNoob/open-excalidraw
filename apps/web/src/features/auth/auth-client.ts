import {
  sessionResponseSchema,
  type SessionResponse,
} from "@open-excalidraw/contracts";
import { z } from "zod";

import { HttpApiClient } from "../../shared/api";
import { getSafeReturnPath } from "./return-path";

export type OAuthProvider = "github" | "google";

export interface EmailSignInInput {
  email: string;
  password: string;
}

export interface EmailSignUpInput extends EmailSignInInput {
  callbackURL: string;
  name: string;
}

export interface AuthClient {
  getSession(): Promise<SessionResponse>;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  resendVerification(email: string, callbackURL: string): Promise<void>;
  resetPassword(newPassword: string, token: string): Promise<void>;
  signIn(input: EmailSignInInput): Promise<void>;
  signOut(): Promise<void>;
  signUp(input: EmailSignUpInput): Promise<void>;
  startOAuth(provider: OAuthProvider, returnPath: string): Promise<void>;
}

export interface CookieAuthClientOptions {
  api?: HttpApiClient;
  navigate?: (url: string) => void;
}

const oauthStartResponseSchema = z
  .object({
    url: z.string().url().optional(),
  })
  .passthrough();

export class CookieAuthClient implements AuthClient {
  readonly #api: HttpApiClient;
  readonly #navigate: (url: string) => void;

  constructor({
    api = new HttpApiClient(),
    navigate = (url) => globalThis.location.assign(url),
  }: CookieAuthClientOptions = {}) {
    this.#api = api;
    this.#navigate = navigate;
  }

  getSession(): Promise<SessionResponse> {
    return this.#api.request(
      "/v1/me",
      { method: "GET" },
      sessionResponseSchema,
    );
  }

  async requestPasswordReset(email: string, redirectTo: string): Promise<void> {
    await this.#api.request("/auth/request-password-reset", {
      body: JSON.stringify({ email, redirectTo }),
      method: "POST",
    });
  }

  async resendVerification(email: string, callbackURL: string): Promise<void> {
    await this.#api.request("/auth/send-verification-email", {
      body: JSON.stringify({
        callbackURL: getSafeReturnPath(callbackURL),
        email,
      }),
      method: "POST",
    });
  }

  async resetPassword(newPassword: string, token: string): Promise<void> {
    await this.#api.request("/auth/reset-password", {
      body: JSON.stringify({ newPassword, token }),
      method: "POST",
    });
  }

  async signIn(input: EmailSignInInput): Promise<void> {
    await this.#api.request("/auth/sign-in/email", {
      body: JSON.stringify(input),
      method: "POST",
    });
  }

  async signUp(input: EmailSignUpInput): Promise<void> {
    await this.#api.request("/auth/sign-up/email", {
      body: JSON.stringify({
        ...input,
        callbackURL: getSafeReturnPath(input.callbackURL),
      }),
      method: "POST",
    });
  }

  async signOut(): Promise<void> {
    await this.#api.request("/auth/sign-out", { method: "POST" });
  }

  async startOAuth(provider: OAuthProvider, returnPath: string): Promise<void> {
    const callbackURL = getSafeReturnPath(returnPath);
    const response = await this.#api.request(
      "/auth/sign-in/social",
      {
        body: JSON.stringify({ callbackURL, provider }),
        method: "POST",
      },
      oauthStartResponseSchema,
    );

    if (!response.url) {
      throw new Error("The authentication server did not return an OAuth URL.");
    }

    this.#navigate(response.url);
  }
}
