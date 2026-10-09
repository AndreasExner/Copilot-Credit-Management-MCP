import type { Config } from "../config.js";
import type { Actor } from "../auth/validate-token.js";
import type { GetGraphToken } from "../auth/graph-obo.js";
import { ServiceError } from "../errors.js";
import { RequestQueue } from "./request-queue.js";

export const graphBaseUrl = "https://graph.microsoft.com/beta/copilot/costManagement";
const maximumResponseBytes = 1024 * 1024;
const objectGuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export interface GraphResult {
  data: unknown;
  requestId?: string;
  timestamp: string;
}

function readPageUrl(path: string, nextLink: string | undefined, policies: boolean, caseInsensitive = !policies): string {
  if (!nextLink) return `https://graph.microsoft.com${path}`;
  let url;
  try {
    url = new URL(nextLink);
  } catch {
    throw new ServiceError("invalid_next_link", "The continuation URL is invalid.", 400);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "graph.microsoft.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    (url.pathname !== path && (!caseInsensitive || url.pathname.toLowerCase() !== path.toLowerCase()))
  ) {
    throw new ServiceError("invalid_next_link", policies
      ? "Only Graph policy continuation URLs are accepted."
      : "Only Graph continuation URLs for the requested resource are accepted.", 400);
  }
  if (policies && url.searchParams.has("$top")) {
    throw new ServiceError("unsupported_query", "$top is not supported by policy lists.", 400);
  }
  return nextLink;
}

export function policyPageUrl(nextLink?: string): string {
  return readPageUrl("/beta/copilot/costManagement/spendingPolicies", nextLink, true);
}

export function userServiceBalancePageUrl(userId: string, nextLink?: string): string {
  if (!objectGuid.test(userId)) {
    throw new ServiceError("invalid_user_id", "An Entra user object GUID is required, not a name or email address.", 400);
  }
  return readPageUrl(`/beta/copilot/costManagement/userBalances/${userId}/serviceBalances`, nextLink, false);
}

export function policyAssignedGroupsPageUrl(policyId: string, nextLink?: string): string {
  if (!policyId || policyId.length > 256 || /[\u0000-\u001f\u007f/\\?#]/.test(policyId) ||
      policyId === "." || policyId === "..") {
    throw new ServiceError("invalid_policy_id", "Use the policy identifier returned by the spending-policy list.", 400);
  }
  const path = `/beta/copilot/costManagement/spendingPolicies/${encodeURIComponent(policyId)}` +
    "/microsoft.graph.selectedGroupsSpendingPolicy/assignedGroups";
  return readPageUrl(path, nextLink, false, false);
}

export function groupUsersPageUrl(groupId: string, transitive: boolean, nextLink?: string): string {
  if (!objectGuid.test(groupId)) {
    throw new ServiceError("invalid_group_id", "An Entra group object GUID is required.", 400);
  }
  const path = `/v1.0/groups/${groupId}/${transitive ? "transitiveMembers" : "members"}/microsoft.graph.user`;
  const url = readPageUrl(path, nextLink, false);
  return nextLink ? url : `${url}?$count=true&$select=id,displayName,userPrincipalName`;
}

function retryAfterSeconds(header: string | null): number | undefined {
  if (!header) return undefined;
  if (/^\d+$/.test(header)) return Math.max(1, Number(header));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(1, Math.ceil((date - Date.now()) / 1000)) : undefined;
}

function graphErrorCode(data: unknown): string {
  if (typeof data !== "object" || data === null || !("error" in data)) return "graph_error";
  const error = data.error;
  if (typeof error !== "object" || error === null || !("code" in error)) return "graph_error";
  return typeof error.code === "string" && /^[\w.-]{1,100}$/.test(error.code)
    ? error.code : "graph_error";
}

async function readJson(response: Response): Promise<unknown> {
  const stream = response.body;
  if (!stream) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumResponseBytes) {
        await reader.cancel();
        throw new ServiceError("response_too_large", "The Graph response exceeds the supported size.", 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new ServiceError("invalid_graph_response", "Graph returned an invalid JSON response.", 502);
  }
}

export class GraphClient {
  private readonly queue: RequestQueue;

  constructor(
    private readonly config: Config,
    private readonly getToken: GetGraphToken,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.queue = new RequestQueue(config.graphMinIntervalMs, config.graphMaxQueue);
  }

  async get(actor: Actor, uri: string, scope: string, consistencyLevel?: "eventual"): Promise<GraphResult> {
    const deadline = Date.now() + this.config.graphTimeoutMs;
    const signal = AbortSignal.timeout(this.config.graphTimeoutMs);
    return this.queue.run(async () => {
      try {
        const token = await this.getToken(actor, [`https://graph.microsoft.com/${scope}`], signal);
        if (signal.aborted) {
          throw new ServiceError("graph_timeout", "Graph authentication exceeded the request time budget.", 504);
        }
        const response = await this.fetcher(uri, {
          method: "GET",
          redirect: "error",
          headers: {
            authorization: `Bearer ${token}`, accept: "application/json",
            ...(consistencyLevel ? { ConsistencyLevel: consistencyLevel } : {}),
          },
          signal,
        });
        const data = await readJson(response);
        const requestId = response.headers.get("request-id") ?? undefined;
        if (!response.ok) {
          const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
          if (response.status === 429 || response.status === 503) {
            this.queue.defer(retryAfter ?? 5);
          }
          throw new ServiceError(
            graphErrorCode(data),
            `Microsoft Graph returned HTTP ${response.status}. Check permission, consent, user role and endpoint availability.`,
            response.status,
            retryAfter,
            requestId,
          );
        }
        return {
          data,
          ...(requestId ? { requestId } : {}),
          timestamp: new Date().toISOString(),
        };
      } catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError(
          signal.aborted ? "graph_timeout" : "graph_network_error",
          signal.aborted ? "The Graph request exceeded its time budget." : "The Graph connection failed.",
          signal.aborted ? 504 : 502,
        );
      }
    }, deadline);
  }
}
