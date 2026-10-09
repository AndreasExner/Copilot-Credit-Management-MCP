import { randomUUID } from "node:crypto";
import express, { type ErrorRequestHandler } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import type { Actor, Authenticate } from "./auth/validate-token.js";
import { safeError } from "./errors.js";
import { projectNotices, renderProjectNotice } from "./project-notices.js";

export interface Dependencies {
  authenticate: Authenticate;
  createServer: (actor: Actor) => McpServer;
  log: (record: Record<string, string | number>) => void;
}

export function createApp(config: Config, dependencies: Dependencies) {
  const app = express();
  app.disable("x-powered-by");
  for (const [page, notice] of Object.entries(projectNotices)) {
    app.get(`/${page}`, (_req, res) => {
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
      res.type("html").send(renderProjectNotice(notice));
    });
  }
  app.get("/health/live", (_req, res) => { res.json({ status: "ok" }); });
  app.get("/health/ready", (_req, res) => { res.json({ status: "ready" }); });
  app.get("/setup/consent/callback", (_req, res) => {
    res.setHeader("cache-control", "no-store");
    res.type("text").send(
      "Consent redirect received; this does not verify success. Check the returned URL for errors and compare " +
      "its state with the setup script. Then verify access using an authenticated MCP read.",
    );
  });
  const metadataUrl = new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl).toString();
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    res.json({
      resource: config.publicUrl,
      authorization_servers: [`https://login.microsoftonline.com/${config.tenantId}/v2.0`],
      scopes_supported: [`api://${config.apiClientId}/Mcp.Read`],
      bearer_methods_supported: ["header"],
    });
  });

  app.use("/mcp", async (req, res, next) => {
    const correlationId = randomUUID();
    res.setHeader("x-correlation-id", correlationId);
    res.setHeader("cache-control", "no-store");
    res.locals.correlationId = correlationId;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.publicUrl).origin) {
      res.status(403).json({ error: "origin_not_allowed", correlationId });
      return;
    }
    try {
      res.locals.actor = await dependencies.authenticate(req.headers.authorization);
      next();
    } catch (error) {
      const failure = safeError(error);
      if (failure.status === 401) {
        res.setHeader("www-authenticate", `Bearer resource_metadata="${metadataUrl}"`);
      }
      dependencies.log({ event: "authentication_rejected", code: failure.code, status: failure.status, correlationId });
      res.status(failure.status).json({ error: failure.toJSON(), correlationId });
    }
  });
  app.post("/mcp", express.json({ limit: "64kb" }), async (req, res) => {
    const actor: Actor = res.locals.actor;
    const server = dependencies.createServer(actor);
    const transport = new StreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    res.once("close", () => {
      void Promise.all([transport.close(), server.close()]).catch(() => {
        dependencies.log({ event: "transport_cleanup_failed", correlationId: String(res.locals.correlationId) });
      });
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const failure = safeError(error);
      dependencies.log({ event: "mcp_request_failed", code: failure.code, correlationId: String(res.locals.correlationId) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: failure.message },
          id: null,
        });
      }
    }
  });
  app.all("/mcp", (_req, res) => {
    res.setHeader("allow", "POST");
    res.status(405).json({ error: "method_not_allowed" });
  });
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = error instanceof SyntaxError ? 400 : 413;
    dependencies.log({ event: "invalid_request_body", status });
    res.status(status).json({ error: "invalid_request_body" });
  };
  app.use(errorHandler);
  return app;
}
