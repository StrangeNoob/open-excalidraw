import type { CollaborationController } from "../collaboration";
import type { CloudOutboxDb } from "../connectivity/storage/cloudOutboxDb";
import type { AutosaveController } from "../persistence";
import type { RestoreResponse } from "../revisions";

export const restoreWithRealtimeBoundary = async (input: {
  autosave: Pick<AutosaveController, "flush"> | null;
  drawingId: string;
  outbox: Pick<CloudOutboxDb, "list"> | null;
  realtime: Pick<
    CollaborationController,
    "pauseWrites" | "resumeWrites" | "stop"
  > | null;
  restore: () => Promise<RestoreResponse>;
  userId: string;
}): Promise<RestoreResponse> => {
  await input.autosave?.flush();
  let paused = false;
  try {
    if (input.realtime && input.outbox) {
      paused = true;
      await input.realtime.pauseWrites();
      await waitForOutboxDrain(input.outbox, input.userId, input.drawingId);
    }
    const restored = await input.restore();
    await input.realtime?.stop().catch(() => undefined);
    return restored;
  } catch (caught) {
    if (paused) {
      await input.realtime?.resumeWrites().catch(() => undefined);
    }
    throw caught;
  }
};

const waitForOutboxDrain = async (
  outbox: Pick<CloudOutboxDb, "list">,
  userId: string,
  drawingId: string,
) => {
  const deadline = Date.now() + 3_000;
  while ((await outbox.list(userId, drawingId)).length > 0) {
    if (Date.now() >= deadline) {
      throw new Error(
        "Reconnect and let pending changes finish saving before restoring history.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
