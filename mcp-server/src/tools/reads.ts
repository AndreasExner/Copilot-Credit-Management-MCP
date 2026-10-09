import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Actor } from "../auth/validate-token.js";
import { graphBaseUrl, policyPageUrl, userServiceBalancePageUrl, type GraphClient } from "../graph/client.js";
import { safeError } from "../errors.js";

export function createReadServer(actor: Actor, graph: GraphClient): McpServer {
  const server = new McpServer({ name: "copilot-credit-management", version: "0.2.0" });
  const readAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  server.registerTool("get_tenant_credit_balance", {
    description: "Read the current tenant's Copilot credit balances as the signed-in user. Missing quantities are not zero; use remainingQuantity as returned.",
    inputSchema: {},
    annotations: readAnnotations,
  }, async () => {
    try {
      const result = await graph.get(actor, `${graphBaseUrl}/getTenantCreditBalance()`, "CopilotCostManagement.Read.All");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      const failure = safeError(error).toJSON();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
    }
  });

  server.registerTool("list_spending_policies", {
    description: "Read one page of spending policies. Follow the returned @odata.nextLink unchanged with nextLink. Does not use $top and does not claim a page is the complete list.",
    inputSchema: {
      nextLink: z.string().max(16000).optional().describe("The unchanged @odata.nextLink returned by the preceding page, omitted for the first page."),
    },
    annotations: readAnnotations,
  }, async ({ nextLink }) => {
    try {
      const result = await graph.get(actor, policyPageUrl(nextLink), "CopilotCostManagement-Policy.Read.All");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      const failure = safeError(error).toJSON();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
    }
  });

  server.registerTool("list_user_service_balances", {
    description: "Read one page of a user's per-service Copilot balance/consumption data as the signed-in caller. Omit userId for the caller's own balances, or supply an authorized user's Entra object GUID. Requires delegated CopilotCostManagement-UserData.Read.All admin consent. Preserve returned units and fields; do not invent missing quantities.",
    inputSchema: {
      userId: z.string().uuid().optional().describe("Entra user object GUID. Omit for the signed-in user's own data; never supply a name or email address."),
      nextLink: z.string().max(16000).optional().describe("The unchanged @odata.nextLink from the preceding service-balance page for the same user, omitted for the first page."),
    },
    annotations: readAnnotations,
  }, async ({ userId, nextLink }) => {
    try {
      const result = await graph.get(actor, userServiceBalancePageUrl(userId ?? actor.objectId, nextLink),
        "CopilotCostManagement-UserData.Read.All");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      const failure = safeError(error).toJSON();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
    }
  });

  return server;
}
