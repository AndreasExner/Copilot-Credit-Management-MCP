import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Actor } from "../auth/validate-token.js";
import {
  graphBaseUrl, groupUsersPageUrl, policyAssignedGroupsPageUrl, policyPageUrl,
  userBasicProfileUrl, userServiceBalancePageUrl, validateUserBasicProfile, type GraphClient,
} from "../graph/client.js";
import { safeError } from "../errors.js";

export function createReadServer(actor: Actor, graph: GraphClient): McpServer {
  const server = new McpServer({ name: "copilot-credit-management", version: "0.4.0" });
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

  server.registerTool("list_policy_assigned_groups", {
    description: "Read one page of groups assigned to a selected-groups spending policy. Use the policy ID returned by list_spending_policies, not its display name. Requires delegated CopilotCostManagement-Assignment.Read.All. This returns groups, not user membership; unsupported policy types or unavailable endpoints remain errors.",
    inputSchema: {
      policyId: z.string().min(1).max(256).describe("Exact spending-policy identifier returned by list_spending_policies; not assumed to be a GUID."),
      nextLink: z.string().max(16000).optional().describe("The unchanged @odata.nextLink for this same policy's assigned groups, omitted for the first page."),
    },
    annotations: readAnnotations,
  }, async ({ policyId, nextLink }) => {
    try {
      const result = await graph.get(actor, policyAssignedGroupsPageUrl(policyId, nextLink),
        "CopilotCostManagement-Assignment.Read.All");
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: { ...result } };
    } catch (error) {
      const failure = safeError(error).toJSON();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
    }
  });

  server.registerTool("list_group_users", {
    description: "Read one page of users in an assigned Entra group. Defaults to transitive membership (includes nested groups); set transitive false for direct users only. Requires delegated GroupMember.ReadBasic.All. Uses an eventual-consistency index: recent membership changes may lag. Names/UPNs may be unavailable; retain user GUIDs. Hidden membership requires separate authorization, not requested automatically. This directory roster does not prove spending-policy enforcement or policy-specific consumption.",
    inputSchema: {
      groupId: z.string().uuid().describe("Entra object GUID returned by list_policy_assigned_groups."),
      transitive: z.boolean().optional().describe("Defaults to true to include users in nested groups. False lists direct users only. Keep the same value while paging."),
      nextLink: z.string().max(16000).optional().describe("The unchanged @odata.nextLink for this same group and membership mode, omitted for the first page."),
    },
    annotations: readAnnotations,
  }, async ({ groupId, transitive = true, nextLink }) => {
    try {
      const result = await graph.get(actor, groupUsersPageUrl(groupId, transitive, nextLink),
        "GroupMember.ReadBasic.All", "eventual");
      const output = { ...result, membershipScope: transitive ? "transitive" : "direct", consistencyLevel: "eventual" };
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      const failure = safeError(error).toJSON();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
    }
  });

  server.registerTool("get_user_basic_profile", {
    description: "Read an authorized user's basic profile by Entra object GUID as the signed-in caller. Selects only id, displayName and userPrincipalName; requires delegated User.ReadBasic.All consent according to tenant policy. Use once per deduplicated group user whose name/UPN is missing. Complete, partial and unavailable name resolution are explicit; null or absent fields are not invented. Does not change group/balance permissions or resolve email addresses to IDs.",
    inputSchema: {
      userId: z.string().uuid().describe("Entra user object GUID supplied by the user or returned by list_group_users; never a display name or email address."),
    },
    annotations: readAnnotations,
  }, async ({ userId }) => {
    try {
      const result = await graph.get(actor, userBasicProfileUrl(userId), "User.ReadBasic.All");
      const data = validateUserBasicProfile(result.data, userId);
      const availableNames = [data.displayName, data.userPrincipalName]
        .filter((value) => typeof value === "string" && value.trim().length > 0).length;
      const output = {
        ...result, data,
        nameResolutionStatus: availableNames === 2 ? "complete" : availableNames === 1 ? "partial" : "unavailable",
      };
      return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      const failure = safeError(error).toJSON();
      return { isError: true, content: [{ type: "text", text: JSON.stringify(failure) }] };
    }
  });

  return server;
}
