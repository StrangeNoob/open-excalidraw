import {
  adminOverviewSchema,
  adminSettingsSchema,
  adminUserListSchema,
  adminUserSchema,
  type AdminOverview,
  type AdminSettings,
  type AdminSettingsUpdate,
  type AdminUser,
  type AdminUserList,
  type AdminUserQuotaUpdate,
} from "@open-excalidraw/contracts";

import { HttpApiClient } from "../../shared/api";

// Shared so the page and its mutations agree on the cache entries.
export const ADMIN_OVERVIEW_QUERY_KEY = ["admin", "overview"] as const;
export const ADMIN_USERS_QUERY_KEY = ["admin", "users"] as const;
export const ADMIN_SETTINGS_QUERY_KEY = ["admin", "settings"] as const;
export const adminUsersQueryKey = (search: string) =>
  [...ADMIN_USERS_QUERY_KEY, search] as const;

export interface AdminApi {
  getOverview(): Promise<AdminOverview>;
  listUsers(search: string): Promise<AdminUserList>;
  disableUser(userId: string): Promise<void>;
  enableUser(userId: string): Promise<void>;
  resetTwoFactor(userId: string): Promise<void>;
  deleteUser(userId: string): Promise<void>;
  getSettings(): Promise<AdminSettings>;
  updateSettings(input: AdminSettingsUpdate): Promise<AdminSettings>;
  setUserQuota(userId: string, input: AdminUserQuotaUpdate): Promise<AdminUser>;
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

  getSettings(): Promise<AdminSettings> {
    return this.#api.request(
      "/v1/admin/settings",
      { method: "GET" },
      adminSettingsSchema,
    );
  }

  updateSettings(input: AdminSettingsUpdate): Promise<AdminSettings> {
    return this.#api.request(
      "/v1/admin/settings",
      { body: JSON.stringify(input), method: "PATCH" },
      adminSettingsSchema,
    );
  }

  setUserQuota(
    userId: string,
    input: AdminUserQuotaUpdate,
  ): Promise<AdminUser> {
    return this.#api.request(
      `/v1/admin/users/${userId}/quota`,
      { body: JSON.stringify(input), method: "PATCH" },
      adminUserSchema,
    );
  }
}

export const defaultAdminApi = new AdminApiClient();
