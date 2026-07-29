import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Router, type Request, type Response } from "express";

import { requestIdFor } from "../../http/request-context.js";

import type { IdentityService } from "../auth/identity.js";
import { createMcpServer, type McpServices } from "./tools.js";

export type CreateMcpRouterInput = McpServices & { identity: IdentityService };

/**
 * Stateless Streamable HTTP endpoint: a server and transport per request, no
 * sessions and no SSE stream, authenticated with the same personal access
 * tokens as the REST API.
 */
export function createMcpRouter(input: CreateMcpRouterInput): Router {
  const router = Router();

  router.post("/api/mcp", async (request, response) => {
    const requestId = requestIdFor(request, response);
    try {
      const identity = await input.identity.resolve(request.headers);
      if (!identity) {
        response.setHeader("x-request-id", requestId);
        response.status(401).type("application/problem+json").json({
          code: "AUTHENTICATION_REQUIRED",
          status: 401,
          title: "Authentication is required",
          requestId,
        });
        return;
      }
      const server = createMcpServer(input, identity.userId, requestId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on("close", () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch {
      if (response.headersSent) return;
      response.setHeader("x-request-id", requestId);
      response.status(500).type("application/problem+json").json({
        code: "INTERNAL_ERROR",
        status: 500,
        title: "The request could not be completed",
        requestId,
      });
    }
  });

  // No sessions to delete and no stream to open, so both are protocol errors
  // rather than a 404. MCP clients read the JSON-RPC body, not problem+json.
  const methodNotAllowed = (_request: Request, response: Response) => {
    response
      .status(405)
      .setHeader("allow", "POST")
      .json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed" },
        id: null,
      });
  };
  router.get("/api/mcp", methodNotAllowed);
  router.delete("/api/mcp", methodNotAllowed);

  return router;
}
