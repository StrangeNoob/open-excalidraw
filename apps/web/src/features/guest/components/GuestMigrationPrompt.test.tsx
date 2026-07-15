import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import type { GuestMigrationService } from "../services";
import { GuestMigrationPrompt } from "./GuestMigrationPrompt";

describe("GuestMigrationPrompt", () => {
  const candidate = (title: string) => ({
    alreadyMigrated: false,
    drawingId: "guest",
    localRevision: 1,
    title,
  });
  const dismissKey =
    "open-excalidraw:guest-migration-dismissed:user-a\u0000guest";

  beforeEach(() => {
    localStorage.clear();
  });

  it("hides the prompt when dismissed and persists the dismissal", async () => {
    const inspect = vi
      .fn<GuestMigrationService["inspect"]>()
      .mockResolvedValue(candidate("Local sketch"));
    const migrate = vi.fn<GuestMigrationService["migrate"]>();

    render(
      <GuestMigrationPrompt
        drawingId="guest"
        onMigrated={vi.fn()}
        service={{ inspect, migrate }}
        userId="user-a"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Dismiss" }));

    expect(
      screen.queryByText("Save “Local sketch” to your account?"),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem(dismissKey)).toBe("1");
  });

  it("stays hidden when a previous dismissal is stored", async () => {
    localStorage.setItem(dismissKey, "1");
    const inspect = vi
      .fn<GuestMigrationService["inspect"]>()
      .mockResolvedValue(candidate("Local sketch"));
    const migrate = vi.fn<GuestMigrationService["migrate"]>();

    render(
      <GuestMigrationPrompt
        drawingId="guest"
        onMigrated={vi.fn()}
        service={{ inspect, migrate }}
        userId="user-a"
      />,
    );

    await waitFor(() => expect(inspect).toHaveBeenCalled());
    expect(
      screen.queryByText("Save “Local sketch” to your account?"),
    ).not.toBeInTheDocument();
  });

  it("shows inspection failures and retries for the same account", async () => {
    const inspect = vi
      .fn<GuestMigrationService["inspect"]>()
      .mockRejectedValueOnce(new Error("IndexedDB unavailable"))
      .mockResolvedValueOnce({
        alreadyMigrated: false,
        drawingId: "guest",
        localRevision: 1,
        title: "Local sketch",
      });
    const migrate = vi.fn<GuestMigrationService["migrate"]>();

    render(
      <GuestMigrationPrompt
        drawingId="guest"
        onMigrated={vi.fn()}
        service={{ inspect, migrate }}
        userId="user-a"
      />,
    );

    expect(
      await screen.findByRole("alert", {
        name: "Local drawing inspection failed",
      }),
    ).toHaveTextContent("IndexedDB unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByText("Save “Local sketch” to your account?"),
    ).toBeVisible();
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    expect(inspect).toHaveBeenNthCalledWith(1, "user-a", "guest");
    expect(inspect).toHaveBeenNthCalledWith(2, "user-a", "guest");
  });

  it("aborts and suppresses account-A completion after switching to account B", async () => {
    let resolveMigration!: (value: {
      completedAt: string;
      drawingId: string;
      migratedLocalRevision: number;
      targetCloudDrawingId: string;
      userId: string;
    }) => void;
    let migrationSignal: AbortSignal | undefined;
    const inspect = vi.fn<GuestMigrationService["inspect"]>((userId) =>
      Promise.resolve(candidate(userId === "user-a" ? "A sketch" : "B sketch")),
    );
    const migrate = vi.fn<GuestMigrationService["migrate"]>(
      (_userId, _drawingId, scope) => {
        migrationSignal = scope.signal;
        return new Promise((resolve) => {
          resolveMigration = resolve;
        });
      },
    );
    const onMigrated = vi.fn();
    const view = render(
      <GuestMigrationPrompt
        drawingId="guest"
        onMigrated={onMigrated}
        service={{ inspect, migrate }}
        userId="user-a"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save to my account" }),
    );

    view.rerender(
      <GuestMigrationPrompt
        drawingId="guest"
        onMigrated={onMigrated}
        service={{ inspect, migrate }}
        userId="user-b"
      />,
    );
    expect(
      await screen.findByText("Save “B sketch” to your account?"),
    ).toBeVisible();
    expect(migrationSignal?.aborted).toBe(true);
    await act(async () => {
      resolveMigration({
        completedAt: "2026-07-11T00:00:00.000Z",
        drawingId: "guest",
        migratedLocalRevision: 1,
        targetCloudDrawingId: "cloud-a",
        userId: "user-a",
      });
      await Promise.resolve();
    });

    expect(onMigrated).not.toHaveBeenCalled();
  });

  it("aborts and suppresses navigation when unmounted during migration", async () => {
    let resolveMigration!: (value: {
      completedAt: string;
      drawingId: string;
      migratedLocalRevision: number;
      targetCloudDrawingId: string;
      userId: string;
    }) => void;
    let migrationSignal: AbortSignal | undefined;
    const inspect = vi
      .fn<GuestMigrationService["inspect"]>()
      .mockResolvedValue(candidate("Local sketch"));
    const migrate = vi.fn<GuestMigrationService["migrate"]>(
      (_userId, _drawingId, scope) => {
        migrationSignal = scope.signal;
        return new Promise((resolve) => {
          resolveMigration = resolve;
        });
      },
    );
    const onMigrated = vi.fn();
    const view = render(
      <GuestMigrationPrompt
        drawingId="guest"
        onMigrated={onMigrated}
        service={{ inspect, migrate }}
        userId="user-a"
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Save to my account" }),
    );
    view.unmount();
    expect(migrationSignal?.aborted).toBe(true);
    await act(async () => {
      resolveMigration({
        completedAt: "2026-07-11T00:00:00.000Z",
        drawingId: "guest",
        migratedLocalRevision: 1,
        targetCloudDrawingId: "cloud-a",
        userId: "user-a",
      });
      await Promise.resolve();
    });

    expect(onMigrated).not.toHaveBeenCalled();
  });
});
