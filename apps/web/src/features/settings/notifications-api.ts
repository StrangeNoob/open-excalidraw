import {
  notificationSettingsSchema,
  type NotificationSettings,
} from "@open-excalidraw/contracts";

import { HttpApiClient } from "../../shared/api";

export const NOTIFICATION_SETTINGS_QUERY_KEY = [
  "notification-settings",
] as const;

export interface NotificationSettingsApi {
  getNotificationSettings(): Promise<NotificationSettings>;
  saveNotificationSettings(
    settings: NotificationSettings,
  ): Promise<NotificationSettings>;
}

export class NotificationSettingsApiClient implements NotificationSettingsApi {
  readonly #api: HttpApiClient;

  constructor(api = new HttpApiClient()) {
    this.#api = api;
  }

  getNotificationSettings(): Promise<NotificationSettings> {
    return this.#api.request(
      "/v1/notification-settings",
      { method: "GET" },
      notificationSettingsSchema,
    );
  }

  saveNotificationSettings(
    settings: NotificationSettings,
  ): Promise<NotificationSettings> {
    return this.#api.request(
      "/v1/notification-settings",
      { body: JSON.stringify(settings), method: "PUT" },
      notificationSettingsSchema,
    );
  }
}

export const defaultNotificationSettingsApi =
  new NotificationSettingsApiClient();
