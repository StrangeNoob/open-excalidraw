import type { AdminUser } from "@open-excalidraw/contracts";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { useAuth } from "../auth";
import {
  ADMIN_OVERVIEW_QUERY_KEY,
  ADMIN_USERS_QUERY_KEY,
  AdminApiClient,
  adminUsersQueryKey,
  type AdminApi,
} from "./admin-api";

const defaultAdminApi = new AdminApiClient();

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

const formatJoined = (createdAt: string): string =>
  new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
    new Date(createdAt),
  );

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

  const pending =
    disableUser.isPending || enableUser.isPending || deleteUser.isPending;

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
                    <button
                      className="danger-button"
                      disabled={pending}
                      onClick={() => requestDelete(user)}
                      type="button"
                    >
                      Delete
                    </button>
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
