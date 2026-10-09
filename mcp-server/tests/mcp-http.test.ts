import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.js";
import { createReadServer } from "../src/tools/reads.js";
import { GraphClient, graphBaseUrl, groupUsersPageUrl, policyAssignedGroupsPageUrl, userBasicProfileUrl } from "../src/graph/client.js";
import { ServiceError } from "../src/errors.js";
import { actor, config } from "./helpers.js";
const secondActor = { ...actor, objectId: "ab26bfc5-2c56-4553-bd75-aa9946340b14", assertion: "another-mocked-user-assertion" };

describe("authenticated stateless MCP HTTP vertical slice", () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    billingMethodBalances: [{ remainingQuantity: 7 }],
  }));
  const log = vi.fn();
  const getToken = vi.fn(async () => "mock-graph-token");
  const graph = new GraphClient(config, getToken, fetcher);
  const app = createApp(config, {
    authenticate: async (header) => {
      if (header === "Bearer another-mocked-token") return secondActor;
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
        "list_policy_assigned_groups", "list_group_users",
        "get_user_basic_profile",
      ]);
      for (const tool of tools.tools) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      }
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
  it("reads assigned groups and user-only membership with exact scopes, caller and membership modes", async () => {
    const client = new Client({ name: "offline-policy-roster-test", version: "1" });
    const policyId = "opaque-policy";
    const groupId = "bb26bfc5-2c56-4553-bd75-aa9946340b14";
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      fetcher.mockResolvedValueOnce(Response.json({ value: [{ id: groupId }] }));
      expect(await client.callTool({ name: "list_policy_assigned_groups", arguments: { policyId } }))
        .toMatchObject({ structuredContent: { data: { value: [{ id: groupId }] } } });
      expect(fetcher).toHaveBeenLastCalledWith(policyAssignedGroupsPageUrl(policyId), expect.objectContaining({ method: "GET" }));
      expect(getToken).toHaveBeenLastCalledWith(actor,
        ["https://graph.microsoft.com/CopilotCostManagement-Assignment.Read.All"], expect.any(AbortSignal));

      const nextLink = `${groupUsersPageUrl(groupId, true).split("?")[0]}?$count=true&$skiptoken=A%2fb%3D`;
      fetcher.mockResolvedValueOnce(Response.json({ value: [{ id: actor.objectId, displayName: null }], "@odata.nextLink": nextLink }));
      expect(await client.callTool({ name: "list_group_users", arguments: { groupId } })).toMatchObject({
        structuredContent: {
          membershipScope: "transitive", consistencyLevel: "eventual",
          data: { value: [{ id: actor.objectId, displayName: null }], "@odata.nextLink": nextLink },
        },
      });
      expect(fetcher).toHaveBeenLastCalledWith(groupUsersPageUrl(groupId, true), expect.objectContaining({
        headers: expect.objectContaining({ ConsistencyLevel: "eventual" }),
      }));
      expect(getToken).toHaveBeenLastCalledWith(actor,
        ["https://graph.microsoft.com/GroupMember.ReadBasic.All"], expect.any(AbortSignal));
      fetcher.mockResolvedValueOnce(Response.json({ value: [] }));
      expect(await client.callTool({ name: "list_group_users", arguments: { groupId, nextLink } }))
        .toMatchObject({ structuredContent: { membershipScope: "transitive", data: { value: [] } } });
      expect(fetcher).toHaveBeenLastCalledWith(nextLink, expect.objectContaining({
        headers: expect.objectContaining({ ConsistencyLevel: "eventual" }),
      }));
      fetcher.mockResolvedValueOnce(Response.json({ value: [] }));
      expect(await client.callTool({ name: "list_group_users", arguments: { groupId, transitive: false } }))
        .toMatchObject({ structuredContent: { membershipScope: "direct" } });
      expect(fetcher).toHaveBeenLastCalledWith(groupUsersPageUrl(groupId, false), expect.objectContaining({ method: "GET" }));
      const calls = fetcher.mock.calls.length;
      for (const request of [
        { name: "list_policy_assigned_groups", arguments: { policyId: "../users" } },
        { name: "list_policy_assigned_groups", arguments: { policyId, nextLink: policyAssignedGroupsPageUrl("another") } },
        { name: "list_group_users", arguments: { groupId: "invalid" } },
        { name: "list_group_users", arguments: { groupId, transitive: false, nextLink } },
        { name: "list_group_users", arguments: { groupId: actor.objectId, nextLink } },
      ]) {
        expect(await client.callTool(request)).toMatchObject({ isError: true });
      }
      expect(fetcher.mock.calls.length).toBe(calls);
    } finally {
      await client.close();
    }
  });
  it.each([
    { name: "list_policy_assigned_groups", arguments: { policyId: "opaque-policy" } },
    { name: "list_group_users", arguments: { groupId: actor.objectId } },
  ])("surfaces missing roster consent for $name without Graph dispatch", async (request) => {
    getToken.mockRejectedValueOnce(new ServiceError("graph_consent_or_authentication_required",
      "Delegated consent required.", 403));
    const calls = fetcher.mock.calls.length;
    const client = new Client({ name: "offline-roster-consent-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      expect(await client.callTool(request)).toMatchObject({ isError: true });
      expect(fetcher.mock.calls.length).toBe(calls);
    } finally {
      await client.close();
    }
  });
  it.each([
    { status: 403, code: "Authorization_RequestDenied" },
    { status: 404, code: "Request_ResourceNotFound" },
  ])("keeps inaccessible groups or unavailable preview endpoints as errors ($status)", async ({ status, code }) => {
    fetcher.mockResolvedValueOnce(Response.json({ error: { code, message: "private directory information" } }, { status }));
    const client = new Client({ name: "offline-roster-graph-error-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      const response = await client.callTool({ name: "list_policy_assigned_groups", arguments: { policyId: "opaque-policy" } });
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).toContain(code);
      expect(JSON.stringify(response)).not.toContain("private directory information");
    } finally {
      await client.close();
    }
  });
  it.each([
    { names: { displayName: "Test User", userPrincipalName: "test-user@example.test" }, status: "complete" },
    { names: { displayName: "Test User", userPrincipalName: null }, status: "partial" },
    { names: { displayName: null, userPrincipalName: "test-user@example.test" }, status: "partial" },
    { names: {}, status: "unavailable" },
    { names: { displayName: null, userPrincipalName: " " }, status: "unavailable" },
  ])("reports $status profile resolution without inventing fields", async ({ names, status }) => {
    const userId = "bb26bfc5-2c56-4553-bd75-aa9946340b14";
    const data = { id: userId, ...names };
    fetcher.mockResolvedValueOnce(Response.json({ ...data, mail: "not-selected@example.test" }, {
      headers: { "request-id": "profile-test-request" },
    }));
    const client = new Client({ name: "offline-profile-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      const response = await client.callTool({ name: "get_user_basic_profile", arguments: { userId } });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toEqual({
        data, requestId: "profile-test-request", nameResolutionStatus: status, timestamp: expect.any(String),
      });
      expect(fetcher).toHaveBeenLastCalledWith(userBasicProfileUrl(userId), expect.objectContaining({ method: "GET" }));
      expect(fetcher.mock.lastCall?.[1]?.headers).not.toHaveProperty("ConsistencyLevel");
      expect(getToken).toHaveBeenLastCalledWith(actor,
        ["https://graph.microsoft.com/User.ReadBasic.All"], expect.any(AbortSignal));
      const calls = fetcher.mock.calls.length;
      const tokenCalls = getToken.mock.calls.length;
      for (const input of [{}, { userId: "name@example.test" }, { userId: "../users" }]) {
        expect(await client.callTool({ name: "get_user_basic_profile", arguments: input })).toMatchObject({ isError: true });
      }
      expect(fetcher.mock.calls.length).toBe(calls);
      expect(getToken.mock.calls.length).toBe(tokenCalls);
    } finally {
      await client.close();
    }
  });
  it("resolves a GUID-only group user through the separate profile read", async () => {
    const userId = "bb26bfc5-2c56-4553-bd75-aa9946340b14";
    const client = new Client({ name: "offline-guid-to-profile-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      fetcher.mockResolvedValueOnce(Response.json({
        value: [{ id: userId, displayName: null, userPrincipalName: null }],
      }));
      expect(await client.callTool({ name: "list_group_users", arguments: { groupId: actor.objectId } }))
        .toMatchObject({ structuredContent: { data: { value: [{ id: userId, displayName: null, userPrincipalName: null }] } } });
      expect(getToken).toHaveBeenLastCalledWith(actor,
        ["https://graph.microsoft.com/GroupMember.ReadBasic.All"], expect.any(AbortSignal));
      fetcher.mockResolvedValueOnce(Response.json({
        id: userId, displayName: "Resolved Test User", userPrincipalName: "resolved-user@example.test",
      }));
      expect(await client.callTool({ name: "get_user_basic_profile", arguments: { userId } }))
        .toMatchObject({ structuredContent: {
          data: { id: userId, displayName: "Resolved Test User", userPrincipalName: "resolved-user@example.test" },
          nameResolutionStatus: "complete",
        } });
      expect(getToken).toHaveBeenLastCalledWith(actor,
        ["https://graph.microsoft.com/User.ReadBasic.All"], expect.any(AbortSignal));
    } finally {
      await client.close();
    }
  });
  it("keeps the delegated caller separate from the target profile across user contexts", async () => {
    for (const [caller, header] of [[actor, "Bearer valid-mocked-token"], [secondActor, "Bearer another-mocked-token"]] as const) {
      fetcher.mockResolvedValueOnce(Response.json({ id: actor.objectId, displayName: "Same Target" }));
      const client = new Client({ name: "offline-profile-isolation-test", version: "1" });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: header } },
        }));
        expect(await client.callTool({ name: "get_user_basic_profile", arguments: { userId: actor.objectId } }))
          .toMatchObject({ structuredContent: { data: { id: actor.objectId }, nameResolutionStatus: "partial" } });
        expect(getToken).toHaveBeenLastCalledWith(caller,
          ["https://graph.microsoft.com/User.ReadBasic.All"], expect.any(AbortSignal));
      } finally {
        await client.close();
      }
    }
  });
  it.each([403, 404])("keeps inaccessible or deleted profiles as errors (%s) and permits subsequent balance reads", async (status) => {
    fetcher.mockResolvedValueOnce(Response.json({
      error: { code: "ProfileUnavailable", message: "private user details" },
    }, { status }));
    const client = new Client({ name: "offline-profile-error-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      const response = await client.callTool({ name: "get_user_basic_profile", arguments: { userId: actor.objectId } });
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).toContain("ProfileUnavailable");
      expect(JSON.stringify(response)).not.toContain("private user details");
      fetcher.mockResolvedValueOnce(Response.json({ value: [{ serviceId: "cowork", remainingQuantity: 0 }] }));
      expect(await client.callTool({ name: "list_user_service_balances", arguments: { userId: actor.objectId } }))
        .toMatchObject({ structuredContent: { data: { value: [{ serviceId: "cowork", remainingQuantity: 0 }] } } });
      expect(getToken).toHaveBeenLastCalledWith(actor,
        ["https://graph.microsoft.com/CopilotCostManagement-UserData.Read.All"], expect.any(AbortSignal));
    } finally {
      await client.close();
    }
  });
  it("rejects a mismatched profile response explicitly", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ id: secondActor.objectId, displayName: "Wrong User" }));
    const client = new Client({ name: "offline-profile-mismatch-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      const response = await client.callTool({ name: "get_user_basic_profile", arguments: { userId: actor.objectId } });
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).toContain("invalid_graph_profile");
      expect(JSON.stringify(response)).not.toContain("Wrong User");
    } finally {
      await client.close();
    }
  });
  it("does not dispatch Graph when profile consent/authentication is missing", async () => {
    getToken.mockRejectedValueOnce(new ServiceError("graph_consent_or_authentication_required",
      "Delegated consent required.", 403));
    const calls = fetcher.mock.calls.length;
    const client = new Client({ name: "offline-profile-consent-test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: "Bearer valid-mocked-token" } },
      }));
      const response = await client.callTool({ name: "get_user_basic_profile", arguments: { userId: actor.objectId } });
      expect(response).toMatchObject({ isError: true });
      expect(JSON.stringify(response)).toContain("graph_consent_or_authentication_required");
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
