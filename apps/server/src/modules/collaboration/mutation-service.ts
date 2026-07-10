import { createHash } from "node:crypto";

import {
  sceneMutateEventSchema,
  type ClientRealtimeEvent,
} from "@open-excalidraw/contracts";

import { canonicalizeWithinStructuralLimits } from "./core/reconcile.js";
import {
  authorizeSocketEvent,
  type SocketAuthorizationBinding,
  type SocketSessionValidityResolver,
} from "./security/index.js";
import type {
  MutationOutcome,
  MutationRepository,
  SceneMutateEvent,
} from "./persistence/index.js";

export class MutationService {
  public constructor(
    private readonly options: {
      repository: MutationRepository;
      sessionValidityResolver: SocketSessionValidityResolver;
    },
  ) {}

  public async mutate(
    binding: SocketAuthorizationBinding,
    event: Extract<ClientRealtimeEvent, { type: "scene.mutate" }>,
  ): Promise<MutationOutcome> {
    const parsed = sceneMutateEventSchema.parse(event);
    await authorizeSocketEvent(
      binding,
      "scene.mutate",
      this.options.sessionValidityResolver,
    );
    const result = await this.options.repository.persist({
      binding,
      event: parsed,
      payloadHash: mutationHash(parsed),
    });
    if (result.status === "committed") {
      return {
        kind: "committed",
        event: {
          type: "scene.committed",
          mutationId: parsed.mutationId,
          revision: result.revision.toString(),
          elements: result.elements,
          ...(result.sharedSceneState
            ? { sharedSceneState: result.sharedSceneState }
            : {}),
        },
      };
    }
    return {
      kind: "ack",
      event: {
        type: "scene.ack",
        mutationId: parsed.mutationId,
        revision: result.revision.toString(),
        status: result.status,
      },
    };
  }
}

export function mutationHash(event: SceneMutateEvent) {
  return createHash("sha256")
    .update(canonicalizeWithinStructuralLimits(event))
    .digest();
}
