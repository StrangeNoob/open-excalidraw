import request from "supertest";

import { createApp } from "../../src/app";

describe("health endpoint", () => {
  it("reports the process as live", async () => {
    const response = await request(createApp()).get("/health/live");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
  });
});
