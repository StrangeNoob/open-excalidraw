import {
  sessionResponseSchema,
  type SessionResponse,
} from "@open-excalidraw/contracts";
import { z } from "zod";

import { HttpApiClient } from "../../shared/api";
import { getSafeReturnPath } from "./return-path";

export type OAuthProvider = "github" | "google" | "oidc";

export interface EmailSignInInput {
  email: string;
  password: string;
}

export interface EmailSignUpInput extends EmailSignInInput {
  callbackURL: string;
  name: string;
}

export interface LinkedAccount {
  providerId: string;
}

export interface AuthClient {
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  disableTwoFactor(password: string): Promise<void>;
  enableTwoFactor(
    password: string,
  ): Promise<{ backupCodes: string[]; totpURI: string }>;
  generateBackupCodes(password: string): Promise<{ backupCodes: string[] }>;
  getSession(): Promise<SessionResponse>;
  getTotpUri(password: string): Promise<{ totpURI: string }>;
  linkSocial(provider: OAuthProvider, returnPath: string): Promise<void>;
  listAccounts(): Promise<LinkedAccount[]>;
  requestPasswordReset(email: string, redirectTo: string): Promise<void>;
  resendVerification(email: string, callbackURL: string): Promise<void>;
  resetPassword(newPassword: string, token: string): Promise<void>;
  setPassword(newPassword: string): Promise<void>;
  signIn(input: EmailSignInInput): Promise<{ twoFactorRedirect: boolean }>;
  signOut(): Promise<void>;
  signUp(input: EmailSignUpInput): Promise<void>;
  startOAuth(provider: OAuthProvider, returnPath: string): Promise<void>;
  unlinkAccount(providerId: string): Promise<void>;
  verifyBackupCode(code: string, trustDevice: boolean): Promise<void>;
  verifyTotp(code: string, trustDevice: boolean): Promise<void>;
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

const linkedAccountsSchema = z.array(z.object({ providerId: z.string() }));

// Enrolled users get a 200 whose body carries `twoFactorRedirect` instead of a
// session; every other field of the sign-in body is irrelevant to the client.
const signInResponseSchema = z
  .object({ twoFactorRedirect: z.boolean().optional() })
  .passthrough();

const twoFactorEnableResponseSchema = z.object({
  backupCodes: z.array(z.string()),
  totpURI: z.string(),
});

const totpUriResponseSchema = z.object({ totpURI: z.string() });

const backupCodesResponseSchema = z.object({
  backupCodes: z.array(z.string()),
});

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

  async signIn(
    input: EmailSignInInput,
  ): Promise<{ twoFactorRedirect: boolean }> {
    const response = await this.#api.request(
      "/auth/sign-in/email",
      {
        body: JSON.stringify(input),
        method: "POST",
      },
      signInResponseSchema,
    );
    // A 204 (no body) decodes to undefined; treat it as "no challenge".
    return { twoFactorRedirect: response?.twoFactorRedirect === true };
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

  async changePassword(
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    await this.#api.request("/auth/change-password", {
      // Sessions cannot be listed or revoked individually in this app, so
      // revoking the others on every change is the leaked-password recovery.
      body: JSON.stringify({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      }),
      method: "POST",
    });
  }

  async setPassword(newPassword: string): Promise<void> {
    await this.#api.request("/v1/me/password", {
      body: JSON.stringify({ newPassword }),
      method: "POST",
    });
  }

  async listAccounts(): Promise<LinkedAccount[]> {
    return this.#api.request(
      "/auth/list-accounts",
      { method: "GET" },
      linkedAccountsSchema,
    );
  }

  async linkSocial(provider: OAuthProvider, returnPath: string): Promise<void> {
    const callbackURL = getSafeReturnPath(returnPath);
    // The generic OIDC provider lives behind Better Auth's genericOAuth
    // plugin, which uses oauth2 routes keyed by providerId instead.
    const [path, body] =
      provider === "oidc"
        ? ([
            "/auth/oauth2/link",
            { callbackURL, providerId: provider },
          ] as const)
        : (["/auth/link-social", { callbackURL, provider }] as const);
    const response = await this.#api.request(
      path,
      {
        body: JSON.stringify(body),
        method: "POST",
      },
      oauthStartResponseSchema,
    );

    if (!response.url) {
      throw new Error("The authentication server did not return an OAuth URL.");
    }

    this.#navigate(response.url);
  }

  async unlinkAccount(providerId: string): Promise<void> {
    await this.#api.request("/auth/unlink-account", {
      body: JSON.stringify({ providerId }),
      method: "POST",
    });
  }

  async startOAuth(provider: OAuthProvider, returnPath: string): Promise<void> {
    const callbackURL = getSafeReturnPath(returnPath);
    const [path, body] =
      provider === "oidc"
        ? ([
            "/auth/sign-in/oauth2",
            { callbackURL, providerId: provider },
          ] as const)
        : (["/auth/sign-in/social", { callbackURL, provider }] as const);
    const response = await this.#api.request(
      path,
      {
        body: JSON.stringify(body),
        method: "POST",
      },
      oauthStartResponseSchema,
    );

    if (!response.url) {
      throw new Error("The authentication server did not return an OAuth URL.");
    }

    this.#navigate(response.url);
  }

  async enableTwoFactor(
    password: string,
  ): Promise<{ backupCodes: string[]; totpURI: string }> {
    return this.#api.request(
      "/auth/two-factor/enable",
      { body: JSON.stringify({ password }), method: "POST" },
      twoFactorEnableResponseSchema,
    );
  }

  async disableTwoFactor(password: string): Promise<void> {
    await this.#api.request("/auth/two-factor/disable", {
      body: JSON.stringify({ password }),
      method: "POST",
    });
  }

  async getTotpUri(password: string): Promise<{ totpURI: string }> {
    return this.#api.request(
      "/auth/two-factor/get-totp-uri",
      { body: JSON.stringify({ password }), method: "POST" },
      totpUriResponseSchema,
    );
  }

  async generateBackupCodes(
    password: string,
  ): Promise<{ backupCodes: string[] }> {
    return this.#api.request(
      "/auth/two-factor/generate-backup-codes",
      { body: JSON.stringify({ password }), method: "POST" },
      backupCodesResponseSchema,
    );
  }

  async verifyTotp(code: string, trustDevice: boolean): Promise<void> {
    await this.#api.request("/auth/two-factor/verify-totp", {
      body: JSON.stringify({ code, trustDevice }),
      method: "POST",
    });
  }

  async verifyBackupCode(code: string, trustDevice: boolean): Promise<void> {
    await this.#api.request("/auth/two-factor/verify-backup-code", {
      body: JSON.stringify({ code, trustDevice }),
      method: "POST",
    });
  }
}
