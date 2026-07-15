import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { createDocsRouter } from "./docs.js";
import { openApiDocument } from "./openapi.js";

describe("API docs", () => {
  const app = createApp({ routers: [createDocsRouter()] });

  it("serves the OpenAPI document", async () => {
    const response = await request(app).get("/api/docs/openapi.json");
    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe("3.0.3");
    expect(response.body.paths).toHaveProperty("/api/v1/drawings");
  });

  it("serves Swagger UI", async () => {
    const response = await request(app).get("/api/docs/");
    expect(response.status).toBe(200);
    expect(response.text).toContain("swagger-ui");
  });

  it("only references schemas that exist", () => {
    const schemas = Object.keys(openApiDocument.components.schemas);
    const references = JSON.stringify(openApiDocument).matchAll(
      /"#\/components\/schemas\/([^"]+)"/g,
    );
    for (const [, name] of references) {
      expect(schemas).toContain(name);
    }
  });
});
