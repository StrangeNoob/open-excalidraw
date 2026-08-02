import { ContentDomainError } from "./errors.js";
import { ContentService } from "./service.js";
import type {
  ContentRepository,
  SaveContentResult,
  RestoreRevisionResult,
} from "./types.js";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const DRAWING_ID = "10000000-0000-4000-8000-000000000002";
const MUTATION_ID = "10000000-0000-4000-8000-000000000003";
const SAVED_AT = new Date("2026-07-29T00:00:00.000Z");

const body = {
  scene: {
    type: "excalidraw",
    version: 2,
    source: "test",
    elements: [],
    appState: {},
  },
  assetIds: [],
};

function createService(
  results: {
    save?: SaveContentResult;
    restore?: RestoreRevisionResult;
  } = {},
  withEvents = true,
) {
  const events = { restored: vi.fn(), saved: vi.fn() };
  const repository = {
    save: vi.fn().mockResolvedValue(results.save),
    restore: vi.fn().mockResolvedValue(results.restore),
  } as unknown as ContentRepository;
  const service = new ContentService(
    repository,
    undefined,
    withEvents ? events : undefined,
  );
  return { service, events };
}

const save = (service: ContentService) =>
  service.save(USER_ID, DRAWING_ID, 4n, MUTATION_ID, body);

describe("ContentService.save", () => {
  it("announces a committed save with the new revision", async () => {
    const { service, events } = createService({
      save: { status: "saved", revision: 5n, savedAt: SAVED_AT },
    });

    await expect(save(service)).resolves.toEqual({
      revision: "5",
      savedAt: SAVED_AT.toISOString(),
    });
    expect(events.saved).toHaveBeenCalledWith(DRAWING_ID, 5n);
  });

  it("stays silent on an idempotent replay", async () => {
    const { service, events } = createService({
      save: { status: "replayed", revision: 5n, savedAt: SAVED_AT },
    });

    await expect(save(service)).resolves.toMatchObject({ revision: "5" });
    expect(events.saved).not.toHaveBeenCalled();
  });

  it("stays silent on a version conflict", async () => {
    const { service, events } = createService({
      save: { status: "conflict", currentRevision: 9n },
    });

    await expect(save(service)).rejects.toBeInstanceOf(ContentDomainError);
    expect(events.saved).not.toHaveBeenCalled();
  });

  it("saves without listeners wired", async () => {
    const { service } = createService(
      { save: { status: "saved", revision: 5n, savedAt: SAVED_AT } },
      false,
    );

    await expect(save(service)).resolves.toMatchObject({ revision: "5" });
  });
});

describe("ContentService.restore", () => {
  it("announces a restore with the new revision", async () => {
    const { service, events } = createService({
      restore: { status: "restored", revision: 7n, savedAt: SAVED_AT },
    });

    await expect(
      service.restore(USER_ID, DRAWING_ID, 3n),
    ).resolves.toMatchObject({ revision: "7" });
    expect(events.restored).toHaveBeenCalledWith(DRAWING_ID, 7n);
    expect(events.saved).not.toHaveBeenCalled();
  });
});
