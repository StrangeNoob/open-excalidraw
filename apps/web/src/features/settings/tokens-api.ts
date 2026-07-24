import {
  personalAccessTokenCreatedSchema,
  personalAccessTokenListSchema,
  type PersonalAccessTokenCreate,
  type PersonalAccessTokenCreated,
  type PersonalAccessTokenList,
} from "@open-excalidraw/contracts";

import { HttpApiClient } from "../../shared/api";

export const TOKENS_QUERY_KEY = ["tokens"] as const;

export interface TokensApi {
  listTokens(): Promise<PersonalAccessTokenList>;
  createToken(
    input: PersonalAccessTokenCreate,
  ): Promise<PersonalAccessTokenCreated>;
  revokeToken(tokenId: string): Promise<void>;
}

export class TokensApiClient implements TokensApi {
  readonly #api: HttpApiClient;

  constructor(api = new HttpApiClient()) {
    this.#api = api;
  }

  listTokens(): Promise<PersonalAccessTokenList> {
    return this.#api.request(
      "/v1/tokens",
      { method: "GET" },
      personalAccessTokenListSchema,
    );
  }

  createToken(
    input: PersonalAccessTokenCreate,
  ): Promise<PersonalAccessTokenCreated> {
    return this.#api.request(
      "/v1/tokens",
      { body: JSON.stringify(input), method: "POST" },
      personalAccessTokenCreatedSchema,
    );
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.#api.request<void>(`/v1/tokens/${tokenId}`, {
      method: "DELETE",
    });
  }
}

export const defaultTokensApi = new TokensApiClient();
