import { Router } from "express";
import swaggerUi from "swagger-ui-express";

import { openApiDocument } from "./openapi.js";

/** Serves Swagger UI at /api/docs and the raw spec at /api/docs/openapi.json. */
export function createDocsRouter(): Router {
  const router = Router();
  router.get("/api/docs/openapi.json", (_request, response) => {
    response.json(openApiDocument);
  });
  router.use(
    "/api/docs",
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: "Open Excalidraw API",
    }),
  );
  return router;
}
