import type { AdminUser } from "@open-excalidraw/contracts";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth";
import {
  ADMIN_OVERVIEW_QUERY_KEY,
  ADMIN_SETTINGS_QUERY_KEY,
  ADMIN_USERS_QUERY_KEY,
  AdminApiClient,
  adminUsersQueryKey,
  type AdminApi,
} from "./admin-api";

const defaultAdminApi = new AdminApiClient();

const BYTES_PER_MB = 1024 * 1024;

const formatCount = (value: number): string =>
  new Intl.NumberFormat().format(value);

const formatBytes = (bytes: number): string => {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0,
  }).format(value)} ${units[unit]}`;
};

// Quotas are edited in MB but stored as bytes; empty input means "no override".
const bytesToMbInput = (bytes: number | null): string =>
  bytes === null ? "" : String(bytes / BYTES_PER_MB);

// Returns bytes for a positive MB value, null for empty, or false when invalid.
const mbInputToBytes = (raw: string): number | null | false => {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const mb = Number(trimmed);
  if (!Number.isFinite(mb) || mb <= 0) return false;
  return Math.round(mb * BYTES_PER_MB);
};

const formatJoined = (createdAt: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(createdAt),
  );

const StorageSettingsCard = ({ api }: { api: AdminApi }) => {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery({
    queryFn: () => api.getSettings(),
    queryKey: ADMIN_SETTINGS_QUERY_KEY,
  });

  const update = useMutation({
    mutationFn: (bytes: number | null) =>
      api.updateSettings({ storageQuotaPerUserBytes: bytes }),
    onError: (mutationError) => setError(mutationError.message),
    onSuccess: (data) => {
      setError(null);
      queryClient.setQueryData(ADMIN_SETTINGS_QUERY_KEY, data);
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = new FormData(event.currentTarget).get("quota");
    const bytes = mbInputToBytes(typeof raw === "string" ? raw : "");
    if (bytes === false) {
      setError(
        "Enter a positive number of MB, or leave it empty for the default.",
      );
      return;
    }
    setError(null);
    update.mutate(bytes);
  };

  let body: ReactNode;
  if (settings.isPending) {
    body = <p aria-live="polite">Loading settings…</p>;
  } else if (settings.isError) {
    body = (
      <div className="dashboard-error" role="alert">
        <p>{settings.error.message}</p>
        <button onClick={() => void settings.refetch()} type="button">
          Try again
        </button>
      </div>
    );
  } else {
    const { envFallbackBytes, storageQuotaPerUserBytes } = settings.data;
    const effective = storageQuotaPerUserBytes ?? envFallbackBytes;
    // key on the server value so the input resets when a save changes it.
    const overrideMb = bytesToMbInput(storageQuotaPerUserBytes);
    body = (
      <>
        <p className="admin-settings-effective">
          Effective per-user quota:{" "}
          <strong>
            {effective === null ? "Unlimited" : formatBytes(effective)}
          </strong>{" "}
          (
          {storageQuotaPerUserBytes !== null
            ? "instance override"
            : "environment default"}
          ).
        </p>
        <p className="admin-settings-fallback">
          Environment default:{" "}
          {envFallbackBytes === null
            ? "Unlimited"
            : formatBytes(envFallbackBytes)}
          .
        </p>
        <form className="admin-settings-form" onSubmit={submit}>
          <label>
            Instance-wide quota (MB)
            <input
              defaultValue={overrideMb}
              inputMode="decimal"
              key={overrideMb}
              min="0"
              name="quota"
              placeholder="use environment default"
              step="any"
              type="number"
            />
          </label>
          <button disabled={update.isPending} type="submit">
            Save
          </button>
        </form>
        {error ? (
          <p className="admin-settings-error" role="alert">
            {error}
          </p>
        ) : null}
      </>
    );
  }

  return (
    <section aria-labelledby="admin-storage-title" className="admin-settings">
      <h2 id="admin-storage-title">Storage quota</h2>
      {body}
    </section>
  );
};

const UserQuotaControl = ({
  user,
  disabled,
  onSave,
}: {
  user: AdminUser;
  disabled: boolean;
  onSave: (bytes: number | null) => void;
}) => {
  const [value, setValue] = useState(() =>
    bytesToMbInput(user.storageQuotaBytes),
  );
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const bytes = mbInputToBytes(value);
    if (bytes === false) {
      setError("Enter a positive number of MB.");
      return;
    }
    setError(null);
    onSave(bytes);
  };

  return (
    <form className="admin-quota-form" onSubmit={submit}>
      <label>
        Quota (MB)
        <input
          disabled={disabled}
          inputMode="decimal"
          min="0"
          onChange={(event) => setValue(event.target.value)}
          placeholder="default"
          step="any"
          type="number"
          value={value}
        />
      </label>
      <button disabled={disabled} type="submit">
        Save quota
      </button>
      {error ? (
        <p className="admin-quota-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
};

export interface AdminPageProps {
  api?: AdminApi;
}

export const AdminPage = ({ api = defaultAdminApi }: AdminPageProps) => {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const overview = useQuery({
    queryFn: () => api.getOverview(),
    queryKey: ADMIN_OVERVIEW_QUERY_KEY,
  });

  const users = useQuery({
    // keepPreviousData keeps the list steady while a keystroke refetches.
    placeholderData: keepPreviousData,
    queryFn: () => api.listUsers(search),
    queryKey: adminUsersQueryKey(search),
  });

  const invalidateUsers = () =>
    queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });

  const disableUser = useMutation({
    mutationFn: (user: AdminUser) => api.disableUser(user.id),
    onError: (error) => setActionError(error.message),
    onSuccess: () => {
      setActionError(null);
      void invalidateUsers();
    },
  });

  const enableUser = useMutation({
    mutationFn: (user: AdminUser) => api.enableUser(user.id),
    onError: (error) => setActionError(error.message),
    onSuccess: () => {
      setActionError(null);
      void invalidateUsers();
    },
  });

  const resetTwoFactor = useMutation({
    mutationFn: (user: AdminUser) => api.resetTwoFactor(user.id),
    onError: (error) => setActionError(error.message),
    onSuccess: () => {
      setActionError(null);
      void invalidateUsers();
    },
  });

  const deleteUser = useMutation({
    mutationFn: (user: AdminUser) => api.deleteUser(user.id),
    onError: (error) => setActionError(error.message),
    onSuccess: () => {
      setActionError(null);
      void invalidateUsers();
      // Deleting a user also shifts the overview counts.
      void queryClient.invalidateQueries({
        queryKey: ADMIN_OVERVIEW_QUERY_KEY,
      });
    },
  });

  const setUserQuota = useMutation({
    mutationFn: ({ user, bytes }: { user: AdminUser; bytes: number | null }) =>
      api.setUserQuota(user.id, { storageQuotaBytes: bytes }),
    onError: (error) => setActionError(error.message),
    onSuccess: () => {
      setActionError(null);
      void invalidateUsers();
    },
  });

  const pending =
    disableUser.isPending ||
    enableUser.isPending ||
    resetTwoFactor.isPending ||
    deleteUser.isPending ||
    setUserQuota.isPending;

  const requestResetTwoFactor = (user: AdminUser) => {
    if (
      globalThis.confirm(
        `Reset two-factor for ${user.email}? They will have to re-enroll.`,
      )
    ) {
      resetTwoFactor.mutate(user);
    }
  };

  const requestDelete = (user: AdminUser) => {
    if (
      globalThis.confirm(
        `Permanently delete ${user.email}? This cannot be undone.`,
      )
    ) {
      deleteUser.mutate(user);
    }
  };

  return (
    <main className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="dashboard-eyebrow">Open Excalidraw</p>
          <h1>Admin</h1>
          <Link to="/app">Back to dashboard</Link>
        </div>
      </header>

      {overview.isPending ? (
        <p aria-live="polite">Loading stats…</p>
      ) : overview.isError ? (
        <section className="dashboard-error" role="alert">
          <h2>Could not load the overview</h2>
          <p>{overview.error.message}</p>
          <button onClick={() => void overview.refetch()} type="button">
            Try again
          </button>
        </section>
      ) : (
        <dl className="admin-stats">
          <div className="admin-stat">
            <dt>Users</dt>
            <dd>{formatCount(overview.data.users)}</dd>
          </div>
          <div className="admin-stat">
            <dt>Drawings</dt>
            <dd>{formatCount(overview.data.drawings)}</dd>
          </div>
          <div className="admin-stat">
            <dt>Storage</dt>
            <dd>{formatBytes(overview.data.storageBytes)}</dd>
          </div>
        </dl>
      )}

      <StorageSettingsCard api={api} />

      {actionError ? <p role="alert">{actionError}</p> : null}

      <label className="admin-search">
        Search users
        <input
          onChange={(event) => setSearch(event.target.value)}
          placeholder="name or email"
          type="search"
          value={search}
        />
      </label>

      {users.isPending ? (
        <p aria-live="polite">Loading users…</p>
      ) : users.isError ? (
        <section className="dashboard-error" role="alert">
          <h2>Could not load users</h2>
          <p>{users.error.message}</p>
          <button onClick={() => void users.refetch()} type="button">
            Try again
          </button>
        </section>
      ) : users.data.users.length === 0 ? (
        <p className="dashboard-empty">
          {search ? `No users match “${search}”.` : "No users found."}
        </p>
      ) : (
        <>
          {users.data.total > users.data.users.length ? (
            <p className="dashboard-notice">
              Showing {users.data.users.length} of {users.data.total} users.
            </p>
          ) : null}
          <div className="drawing-grid">
            {users.data.users.map((user) => (
              <article className="drawing-card" key={user.id}>
                <div className="drawing-card-heading">
                  <h3>{user.name}</h3>
                  {user.disabledAt ? (
                    <span className="role-badge admin-badge-disabled">
                      disabled
                    </span>
                  ) : null}
                </div>
                <dl>
                  <div>
                    <dt>Email</dt>
                    <dd>
                      {user.email}
                      {!user.emailVerified ? (
                        <span className="role-badge admin-badge-unverified">
                          unverified
                        </span>
                      ) : null}
                    </dd>
                  </div>
                  <div>
                    <dt>Joined</dt>
                    <dd>
                      <time dateTime={user.createdAt}>
                        {formatJoined(user.createdAt)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Drawings</dt>
                    <dd>{formatCount(user.drawingCount)}</dd>
                  </div>
                  <div>
                    <dt>Storage</dt>
                    <dd>
                      {formatBytes(user.storageBytes)}
                      {user.storageQuotaBytes !== null
                        ? ` of ${formatBytes(user.storageQuotaBytes)}`
                        : null}
                    </dd>
                  </div>
                </dl>
                {user.id !== auth.user?.id ? (
                  <div className="drawing-card-actions">
                    {user.disabledAt ? (
                      <button
                        disabled={pending}
                        onClick={() => enableUser.mutate(user)}
                        type="button"
                      >
                        Enable
                      </button>
                    ) : (
                      <button
                        disabled={pending}
                        onClick={() => disableUser.mutate(user)}
                        type="button"
                      >
                        Disable
                      </button>
                    )}
                    {user.twoFactorEnabled ? (
                      <button
                        disabled={pending}
                        onClick={() => requestResetTwoFactor(user)}
                        type="button"
                      >
                        Reset 2FA
                      </button>
                    ) : null}
                    <button
                      className="danger-button"
                      disabled={pending}
                      onClick={() => requestDelete(user)}
                      type="button"
                    >
                      Delete
                    </button>
                    <UserQuotaControl
                      disabled={pending}
                      onSave={(bytes) => setUserQuota.mutate({ bytes, user })}
                      user={user}
                    />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </>
      )}
    </main>
  );
};
