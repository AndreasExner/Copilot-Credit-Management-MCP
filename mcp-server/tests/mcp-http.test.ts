import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.js";
import { createReadServer } from "../src/tools/reads.js";
import { GraphClient, graphBaseUrl } from "../src/graph/client.js";
import { ServiceError } from "../src/errors.js";
import { actor, config } from "./helpers.js";

describe("authenticated stateless MCP HTTP vertical slice", () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    billingMethodBalances: [{ remainingQuantity: 7 }],
  }));
  const log = vi.fn();
  const getToken = vi.fn(async () => "mock-graph-token");
  const graph = new GraphClient(config, getToken, fetcher);
  const app = createApp(config, {
    authenticate: async (header) => {
      if (header === "Bearer valid-mocked-token") return actor;
      if (header !== "Bearer local-test-token") {
        throw new ServiceError("unauthorized", "Authentication required.", 401);
      }
      return actor;
    },
    createServer: (caller) => createReadServer(caller, graph),
    log,
  });
  const http = app.listen(0, "127.0.0.1");
  let base: string;
  beforeAll(async () => {
    if (!http.listening) await new Promise<void>((resolve) => http.once("listening", resolve));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });

  it("allows minimal public health and OAuth metadata", async () => {
    expect((await fetch(`${base}/health/live`)).status).toBe(200);
    const response = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    const metadata = await response.json();
    expect(metadata.resource).toBe(config.publicUrl);
  });
  it("does not treat a consent callback as verified approval", async () => {
    const response = await fetch(`${base}/setup/consent/callback?admin_consent=True&state=untrusted&error=denied`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("this does not verify success");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["about", "privacy", "terms"])("serves static project notice /%s without Graph or reflected input", async (page) => {
    const calls = fetcher.mock.calls.length;
    const response = await fetch(`${base}/${page}?token=do-not-reflect&name=%3Cscript%3E`);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(html).not.toContain("do-not-reflect");
    expect(html).not.toContain("<script>");
    expect(fetcher.mock.calls.length).toBe(calls);
  });
  it("does not turn public project notices into mutation endpoints", async () => {
    const response = await fetch(`${base}/privacy`, { method: "POST" });
    expect(response.status).toBe(404);
  });
  it("rejects anonymous MCP calls before dispatching Graph", async () => {
    const response = await fetch(`${base}/mcp`, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });
  it("performs initialize, tools/list and tools/call with the official SDK", async () => {
    const client = new Client({ name: "offline-mcp-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { authorization: "Bearer local-test-token" } },
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "get_tenant_credit_balance", "list_spending_policies", "list_user_service_balances",
      ]);
      const response = await client.callTool({ name: "get_tenant_credit_balance", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({
        data: { billingMethodBalances: [{ remainingQuantity: 7 }] },
      });
    } finally {
      await client.close();
    }
  });
  it("reads the signed-in user's service balances with only the UserData scope", async () => {
    const data = { value: [{ serviceId: "cowork", remainingQuantity: 0 }, { serviceId: "workIQ" }] };
    fetcher.mockResolvedValueOnce(Response.json(data));
    const client = new Client({ name: "offline-user-balance-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      const response = await client.callTool({ name: "list_user_service_balances", arguments: {} });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ data });
      expect(fetcher).toHaveBeenLastCalledWith(
        `${graphBaseUrl}/userBalances/${actor.objectId}/serviceBalances`,
        expect.objectContaining({ method: "GET" }),
      );
      expect(getToken).toHaveBeenLastCalledWith(actor,
        ["https://graph.microsoft.com/CopilotCostManagement-UserData.Read.All"], expect.any(AbortSignal));
    } finally {
      await client.close();
    }
  });
  it("preserves an explicit user's continuation and rejects invalid/cross-user input before dispatch", async () => {
    const userId = "bb26bfc5-2c56-4553-bd75-aa9946340b14";
    const nextLink = `${graphBaseUrl}/userBalances/${userId}/serviceBalances?$skiptoken=A%2fb%2B%3D`;
    const data = { value: [] };
    fetcher.mockResolvedValueOnce(Response.json(data));
    const client = new Client({ name: "offline-other-user-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      const response = await client.callTool({
        name: "list_user_service_balances", arguments: { userId, nextLink },
      });
      expect(response.structuredContent).toMatchObject({ data });
      expect(fetcher).toHaveBeenLastCalledWith(nextLink, expect.objectContaining({ method: "GET" }));
      const calls = fetcher.mock.calls.length;
      const wrongUser = await client.callTool({
        name: "list_user_service_balances", arguments: { userId: actor.objectId, nextLink },
      });
      expect(wrongUser.isError).toBe(true);
      const invalidUser = await client.callTool({
        name: "list_user_service_balances", arguments: { userId: "name@example.test" },
      });
      expect(invalidUser.isError).toBe(true);
      expect(fetcher.mock.calls.length).toBe(calls);
    } finally {
      await client.close();
    }
  });
  it("returns missing UserData consent as an explicit tool error without a Graph request", async () => {
    getToken.mockRejectedValueOnce(new ServiceError("graph_consent_or_authentication_required",
      "Delegated consent required.", 403));
    const calls = fetcher.mock.calls.length;
    const client = new Client({ name: "offline-consent-error-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      expect(await client.callTool({ name: "list_user_service_balances", arguments: {} })).toMatchObject({
        isError: true,
        content: [{ type: "text", text: expect.stringContaining("graph_consent_or_authentication_required") }],
      });
      expect(fetcher.mock.calls.length).toBe(calls);
    } finally {
      await client.close();
    }
  });
  it("rejects unexpected browser origins", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer local-test-token", origin: "https://attacker.test" },
    });
    expect(response.status).toBe(403);
  });
});
