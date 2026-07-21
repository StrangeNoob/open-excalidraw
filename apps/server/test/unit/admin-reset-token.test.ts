import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import {
  createAuthRouter,
  OneTimeManualResetLinkStore,
} from "../../src/modules/auth/index.js";

// The admin reset token guards POST /api/admin/manual-reset-links/consume,
// which returns live password-reset URLs. That route sits outside Better Auth's
// rate limiter and no Express limiter is applied, so a short token is
// brute-forceable and the length floor must hold whether or not SMTP is on.
const routerInput = (adminResetToken: string | undefined) => ({
  auth: {} as never,
  identity: {} as never,
  capabilities: {} as never,
  manualResetLinks: new OneTimeManualResetLinkStore(),
  ...(adminResetToken === undefined ? {} : { adminResetToken }),
});

describe("admin reset token validation", () => {
  it("rejects a token shorter than 32 characters", () => {
    expect(() => createAuthRouter(routerInput("a".repeat(31)))).toThrow(
      /at least 32 characters/,
    );
  });

  it("rejects a trivially guessable token", () => {
    expect(() => createAuthRouter(routerInput("admin"))).toThrow(TypeError);
  });

  it("accepts a token of exactly the minimum length", () => {
    expect(() => createAuthRouter(routerInput("a".repeat(32)))).not.toThrow();
  });

  it("accepts a comfortably long token", () => {
    expect(() => createAuthRouter(routerInput("a".repeat(64)))).not.toThrow();
  });

  it("allows the token to be omitted entirely", () => {
    expect(() => createAuthRouter(routerInput(undefined))).not.toThrow();
  });
});

describe("manual reset link endpoint throttling", () => {
  // The endpoint returns live password-reset URLs and sits outside Better
  // Auth's rate limiter, so unlimited guessing must not be possible.
  const app = () => {
    const instance = express();
    instance.use(express.json());
    instance.use(createAuthRouter(routerInput("b".repeat(48))));
    return instance;
  };

  it("throttles repeated attempts and keeps rejecting a wrong token", async () => {
    const instance = app();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(instance)
        .post("/api/admin/manual-reset-links/consume")
        .set("authorization", "Bearer wrong-token")
        .send({ email: "victim@example.test" })
        .expect(401);
    }

    // The 11th attempt is refused by the limiter rather than reaching the
    // token comparison at all.
    await request(instance)
      .post("/api/admin/manual-reset-links/consume")
      .set("authorization", "Bearer wrong-token")
      .send({ email: "victim@example.test" })
      .expect(429);
  });

  it("counts failed attempts against the correct token too", async () => {
    const instance = app();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await request(instance)
        .post("/api/admin/manual-reset-links/consume")
        .set("authorization", "Bearer wrong-token")
        .send({ email: "victim@example.test" })
        .expect(401);
    }

    // A valid token cannot be used to bypass an exhausted bucket, so guessing
    // cannot be interleaved with legitimate use to reset the counter.
    await request(instance)
      .post("/api/admin/manual-reset-links/consume")
      .set("authorization", `Bearer ${"b".repeat(48)}`)
      .send({ email: "victim@example.test" })
      .expect(429);
  });
});
