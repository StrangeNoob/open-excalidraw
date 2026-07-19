import {
  adminOverviewSchema,
  adminUserListSchema,
  type AdminOverview,
  type AdminUserList,
} from "@open-excalidraw/contracts";

import { HttpApiClient } from "../../shared/api";

// Shared so the page and its mutations agree on the cache entries.
export const ADMIN_OVERVIEW_QUERY_KEY = ["admin", "overview"] as const;
export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;
export const adminUsersQueryKey = (search: string) =>
  [...ADMIN_USERS_QUERY_KEY, search] as const;

export interface AdminApi {
  getOverview(): Promise<AdminOverview>;
  listUsers(search: string): Promise<AdminUserList>;
  disableUser(userId: string): Promise<void>;
  enableUser(userId: string): Promise<void>;
  resetTwoFactor(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
}

export class AdminApiClient implements AdminApi {
  readonly #api: HttpApiClient;

  constructor(api = new HttpApiClient()) {
    this.#api = api;
  }

  getOverview(): Promise<AdminOverview> {
    return this.#api.request(
      "/v1/admin/overview",
      { method: "GET" },
      adminOverviewSchema,
    );
  }

  listUsers(search: string): Promise<AdminUserList> {
    const query = search ? `?search=${encodeURIComponent(search)}` : "";
    return this.#api.request(
      `/v1/admin/users${query}`,
      { method: "GET" },
      adminUserListSchema,
    );
  }

  async disableUser(userId: string): Promise<void> {
    await this.#api.request<void>(`/v1/admin/users/${userId}/disable`, {
      method: "POST",
    });
  }

  async enableUser(userId: string): Promise<void> {
    await this.#api.request<void>(`/v1/admin/users/${userId}/enable`, {
      method: "POST",
    });
  }

  async resetTwoFactor(userId: string): Promise<void> {
    await this.#api.request<void>(
      `/v1/admin/users/${userId}/two-factor/disable`,
      { method: "POST" },
    );
  }

  async deleteUser(userId: string): Promise<void> {
    await this.#api.request<void>(`/v1/admin/users/${userId}`, {
      method: "DELETE",
    });
  }
}

export const defaultAdminApi = new AdminApiClient();
