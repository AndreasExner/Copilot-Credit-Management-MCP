import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor } from "../auth/validate-token.js";
import {
  groupUsersPageUrl, policyAssignedGroupsPageUrl, userBasicProfileUrl,
  userServiceBalancePageUrl, validateUserBasicProfile, type GraphClient, type GraphResult,
} from "../graph/client.js";
import { ServiceError } from "../errors.js";

const callBudgetMs = 15000;
const workflowLifetimeMs = 15 * 60 * 1000;
const maxCalls = 8;
const maxRows = 5;
const maxResponseBytes = 256 * 1024;
const maxRowBytes = 128 * 1024;
const maxStateBytes = 2 * 1024 * 1024;
const maxWorkflows = 20;
const maxGroups = 100;
const maxUsers = 1000;
const maxPages = 1000;
const collectionSchema = z.object({
  value: z.array(z.record(z.unknown())),
  "@odata.nextLink": z.string().min(1).max(16000).optional(),
});
const directoryObjectSchema = z.object({
  id: z.string().uuid(),
  displayName: z.string().max(1024).nullable().optional(),
  userPrincipalName: z.string().max(1024).nullable().optional(),
});
type Profile = ReturnType<typeof validateUserBasicProfile>;
type ReadError = ReturnType<ServiceError["toJSON"]>;
type NameField = "displayName" | "userPrincipalName";
type Phase = "assigned_groups" | "members" | "balances" | "complete";
interface WorkflowError extends ReadError {
  stage: Phase;
  groupId?: string;
}
interface Member {
  id: string;
  displayName?: string | null;
  userPrincipalName?: string | null;
  sourceGroupIds: string[];
  nameSources: Partial<Record<NameField, string>>;
  nameConflicts: { field: NameField; retained: string; observed: string; source: string }[];
}
export interface PolicyBalanceRow extends Member {
  nameResolutionStatus: "complete" | "partial" | "unavailable";
  profileLookupStatus: "not_needed" | "resolved" | "failed";
  profileError?: ReadError;
  profileObservedAt?: string;
  balanceStatus: "complete" | "partial" | "failed" | "no_records";
  balanceError?: ReadError;
  serviceBalancePages: GraphResult[];
}
export interface PolicyBalancePage {
  policyId: string;
  membershipScope: "direct" | "transitive";
  consistencyLevel: "eventual";
  phase: Phase;
  status: "in_progress" | "paused" | "complete" | "partial";
  rosterComplete: boolean;
  usersDiscovered: number;
  usersProcessed: number;
  rows: PolicyBalanceRow[];
  errors: WorkflowError[];
  failedProfileReads: number;
  failedBalanceReads: number;
  startedAt: string;
  timestamp: string;
  expiresAt: string;
  continuationToken?: string;
  retryAfterSeconds?: number;
}
interface ActiveRow {
  data: PolicyBalanceRow;
  profilePending: boolean;
  balancesPending: boolean;
  nextLink?: string;
  visited: Set<string>;
}
interface Workflow {
  owner: string;
  policyId: string;
  transitive: boolean;
  phase: Phase;
  groups: string[];
  groupIndex: number;
  members: Map<string, Member>;
  userIndex: number;
  users: Member[];
  nextLink?: string;
  visited: Set<string>;
  fetchedPages: number;
  rosterComplete: boolean;
  errors: WorkflowError[];
  failedProfileReads: number;
  failedBalanceReads: number;
  activeRow?: ActiveRow;
  busy: boolean;
  expires: number;
  startedAt: string;
  timer: NodeJS.Timeout;
  activeToken?: string;
  replayToken?: string;
  replay?: PolicyBalancePage;
}

function owner(actor: Actor): string {
  return [actor.tenantId, actor.objectId, actor.clientId].map((value) => value.toLowerCase()).join(":");
}
function present(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function nameStatus(profile: Profile): PolicyBalanceRow["nameResolutionStatus"] {
  const count = [profile.displayName, profile.userPrincipalName].filter(present).length;
  return count === 2 ? "complete" : count === 1 ? "partial" : "unavailable";
}
function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}
function payloadBytes(value: unknown): number {
  return bytes({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });
}
function collection(result: GraphResult) {
  const parsed = collectionSchema.safeParse(result.data);
  if (!parsed.success) {
    throw new ServiceError("invalid_graph_collection", "Graph returned an invalid collection page.", 502);
  }
  return parsed.data;
}
function directoryObject(value: unknown) {
  const parsed = directoryObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new ServiceError("invalid_graph_directory_object", "Graph returned an invalid directory object.", 502);
  }
  return parsed.data;
}
function resumable(error: ServiceError): boolean {
  return error.status === 429 || error.status === 503 ||
    ["graph_timeout", "queue_timeout", "busy", "graph_network_error"].includes(error.code);
}
function mergeNames(member: Member, incoming: Profile, source: string): void {
  for (const field of ["displayName", "userPrincipalName"] as const) {
    const value = incoming[field];
    if (!present(value)) continue;
    const existing = member[field];
    if (!present(existing)) {
      member[field] = value;
      member.nameSources[field] = source;
    } else if (existing !== value) {
      member.nameConflicts.push({ field, retained: existing, observed: value, source });
    }
  }
}

export class PolicyUserBalanceReader {
  private readonly workflows = new Set<Workflow>();
  private readonly continuations = new Map<string, Workflow>();

  constructor(private readonly graph: Pick<GraphClient, "get">) {}

  private discard(workflow: Workflow): void {
    clearTimeout(workflow.timer);
    if (workflow.activeToken) this.continuations.delete(workflow.activeToken);
    if (workflow.replayToken) this.continuations.delete(workflow.replayToken);
    this.workflows.delete(workflow);
  }

  private start(actor: Actor, policyId: string, transitive: boolean): Workflow {
    if (this.workflows.size >= maxWorkflows) {
      throw new ServiceError("aggregation_capacity", "Too many active or replayable workflows. Retry later.", 429, 60);
    }
    const started = Date.now();
    const workflow: Workflow = {
      owner: owner(actor), policyId, transitive, phase: "assigned_groups",
      groups: [], groupIndex: 0, members: new Map(), userIndex: 0, users: [],
      visited: new Set(), fetchedPages: 0, rosterComplete: false, errors: [],
      failedProfileReads: 0, failedBalanceReads: 0, busy: false,
      expires: started + workflowLifetimeMs, startedAt: new Date(started).toISOString(),
      timer: setTimeout(() => this.discard(workflow), workflowLifetimeMs).unref(),
    };
    this.workflows.add(workflow);
    return workflow;
  }

  private checkLimits(workflow: Workflow): void {
    if (workflow.groups.length > maxGroups || workflow.members.size > maxUsers ||
        workflow.fetchedPages > maxPages || bytes({
          groups: workflow.groups, members: [...workflow.members.values()], errors: workflow.errors,
          activeRow: workflow.activeRow, visited: [...workflow.visited], replay: workflow.replay,
          activeRowVisited: workflow.activeRow ? [...workflow.activeRow.visited] : [],
        }) > maxStateBytes) {
      throw new ServiceError("aggregation_limit", "The policy exceeds aggregate workflow limits. Use the individual paged read tools.", 413);
    }
  }

  private nextGroup(workflow: Workflow): void {
    workflow.groupIndex++;
    workflow.nextLink = undefined;
    workflow.visited.clear();
    if (workflow.groupIndex >= workflow.groups.length) {
      workflow.phase = "balances";
      workflow.users = [...workflow.members.values()];
      workflow.rosterComplete = workflow.errors.length === 0;
    }
  }

  private row(member: Member): ActiveRow {
    const needsProfile = nameStatus(member) !== "complete";
    return {
      data: {
        ...member, nameSources: { ...member.nameSources }, nameConflicts: [...member.nameConflicts],
        nameResolutionStatus: nameStatus(member), profileLookupStatus: "not_needed",
        balanceStatus: "failed", serviceBalancePages: [],
      },
      profilePending: needsProfile, balancesPending: true, visited: new Set(),
    };
  }

  private async fetchPage(actor: Actor, workflow: Workflow, uri: string, scope: string,
    deadline: number, visited: Set<string>, consistency?: "eventual"): Promise<GraphResult> {
    if (visited.has(uri)) {
      throw new ServiceError("repeated_next_link", "Graph repeated a collection continuation. Results are incomplete.", 502);
    }
    if (workflow.fetchedPages >= maxPages) {
      throw new ServiceError("aggregation_limit", "The policy exceeds the aggregate page limit. Use individual paged read tools.", 413);
    }
    const result = await this.graph.get(actor, uri, scope, consistency, deadline);
    visited.add(uri);
    workflow.fetchedPages++;
    return result;
  }

  private async step(actor: Actor, workflow: Workflow, deadline: number): Promise<void> {
    if (workflow.phase === "assigned_groups") {
      const page = collection(await this.fetchPage(actor, workflow,
        policyAssignedGroupsPageUrl(workflow.policyId, workflow.nextLink),
        "CopilotCostManagement-Assignment.Read.All", deadline, workflow.visited));
      const ids = page.value.map((value) => directoryObject(value).id);
      for (const id of ids) {
        if (!workflow.groups.some((existing) => existing.toLowerCase() === id.toLowerCase())) workflow.groups.push(id);
      }
      workflow.nextLink = page["@odata.nextLink"];
      if (workflow.nextLink) policyAssignedGroupsPageUrl(workflow.policyId, workflow.nextLink);
      else {
        workflow.visited.clear();
        workflow.phase = workflow.groups.length ? "members" : "complete";
        workflow.rosterComplete = !workflow.groups.length;
      }
    } else if (workflow.phase === "members") {
      const groupId = workflow.groups[workflow.groupIndex]!;
      const page = collection(await this.fetchPage(actor, workflow,
        groupUsersPageUrl(groupId, workflow.transitive, workflow.nextLink),
        "GroupMember.ReadBasic.All", deadline, workflow.visited, "eventual"));
      const members = page.value.map(directoryObject);
      for (const value of members) {
        const key = value.id.toLowerCase();
        let member = workflow.members.get(key);
        if (!member) {
          member = { ...value, sourceGroupIds: [], nameSources: {}, nameConflicts: [] };
          for (const field of ["displayName", "userPrincipalName"] as const) {
            if (present(value[field])) member.nameSources[field] = `group:${groupId}`;
          }
          workflow.members.set(key, member);
        } else mergeNames(member, value, `group:${groupId}`);
        if (!member.sourceGroupIds.includes(groupId)) member.sourceGroupIds.push(groupId);
      }
      workflow.nextLink = page["@odata.nextLink"];
      if (workflow.nextLink) groupUsersPageUrl(groupId, workflow.transitive, workflow.nextLink);
      else this.nextGroup(workflow);
    } else if (workflow.phase === "balances") {
      const current = workflow.activeRow ??= this.row(workflow.users[workflow.userIndex]!);
      if (current.profilePending) {
        const result = await this.graph.get(actor, userBasicProfileUrl(current.data.id), "User.ReadBasic.All", undefined, deadline);
        const profile = directoryObject(validateUserBasicProfile(result.data, current.data.id));
        mergeNames(current.data, profile, "basic_profile");
        current.data.nameResolutionStatus = nameStatus(current.data);
        current.data.profileLookupStatus = "resolved";
        current.data.profileObservedAt = result.timestamp;
        current.profilePending = false;
      } else {
        const result = await this.fetchPage(actor, workflow,
          userServiceBalancePageUrl(current.data.id, current.nextLink),
          "CopilotCostManagement-UserData.Read.All", deadline, current.visited);
        const page = collection(result);
        const nextLink = page["@odata.nextLink"];
        if (bytes({ ...current.data, serviceBalancePages: [...current.data.serviceBalancePages, result] }) > maxRowBytes) {
          throw new ServiceError("aggregation_row_too_large", "User data exceeds the aggregate row limit. Use list_user_service_balances for this user.", 413);
        }
        current.data.serviceBalancePages.push(result);
        if (nextLink) userServiceBalancePageUrl(current.data.id, nextLink);
        current.nextLink = nextLink;
        current.balancesPending = !!nextLink;
        const hasRecords = current.data.serviceBalancePages.some((value) => collection(value).value.length > 0);
        current.data.balanceStatus = nextLink ? "partial" : hasRecords ? "complete" : "no_records";
      }
    }
    this.checkLimits(workflow);
  }

  private failStep(workflow: Workflow, error: ServiceError): void {
    if (workflow.phase === "balances") {
      const row = workflow.activeRow;
      if (!row) throw error;
      if (row.profilePending) {
        row.data.profileLookupStatus = "failed";
        row.data.profileError = error.toJSON();
        row.profilePending = false;
        workflow.failedProfileReads++;
      } else {
        row.data.balanceStatus = row.data.serviceBalancePages.length ? "partial" : "failed";
        row.data.balanceError = error.toJSON();
        row.balancesPending = false;
        workflow.failedBalanceReads++;
      }
    } else {
      workflow.errors.push({
        ...error.toJSON(), stage: workflow.phase,
        ...(workflow.phase === "members" ? { groupId: workflow.groups[workflow.groupIndex] } : {}),
      });
      if (workflow.phase === "members") this.nextGroup(workflow);
      else {
        workflow.phase = "balances";
        workflow.users = [...workflow.members.values()];
      }
    }
  }

  async read(actor: Actor, input: { policyId: string; transitive?: boolean; continuationToken?: string }): Promise<PolicyBalancePage> {
    policyAssignedGroupsPageUrl(input.policyId);
    const token = input.continuationToken;
    let workflow: Workflow;
    if (token) {
      const saved = this.continuations.get(token);
      if (!saved || saved.expires <= Date.now() || saved.owner !== owner(actor) ||
          saved.policyId !== input.policyId || (input.transitive !== undefined && saved.transitive !== input.transitive)) {
        throw new ServiceError("invalid_or_expired_continuation", "The continuation is invalid, expired or belongs to a different request. Start a new workflow.", 410);
      }
      workflow = saved;
      if (token === saved.replayToken && saved.replay) return structuredClone(saved.replay);
    } else workflow = this.start(actor, input.policyId, input.transitive ?? true);
    if (workflow.busy) {
      throw new ServiceError("aggregation_busy", "This workflow is already advancing. Retry later with the same continuation.", 409, 5);
    }
    workflow.busy = true;
    const deadline = Math.min(Date.now() + callBudgetMs, workflow.expires);
    const rows: PolicyBalanceRow[] = [];
    let paused: WorkflowError | undefined;
    try {
      let calls = 0;
      while (workflow.phase !== "complete") {
        if (workflow.phase === "balances") {
          if (workflow.userIndex >= workflow.users.length) {
            workflow.phase = "complete";
            break;
          }
          const row = workflow.activeRow;
          if (row && !row.profilePending && !row.balancesPending) {
            if (rows.length && payloadBytes({ rows: [...rows, row.data], errors: workflow.errors }) > maxResponseBytes - 4096) break;
            rows.push(row.data);
            workflow.userIndex++;
            workflow.activeRow = undefined;
            if (rows.length >= maxRows) break;
            continue;
          }
        }
        if (calls >= maxCalls || Date.now() + 500 >= deadline) break;
        calls++;
        try {
          await this.step(actor, workflow, deadline);
        } catch (error) {
          if (!(error instanceof ServiceError) || error.code === "aggregation_limit") throw error;
          if (resumable(error)) {
            paused = { ...error.toJSON(), stage: workflow.phase };
            break;
          }
          this.failStep(workflow, error);
          this.checkLimits(workflow);
        }
      }
      if (Date.now() >= workflow.expires) {
        throw new ServiceError("invalid_or_expired_continuation", "The workflow expired. Start a new workflow.", 410);
      }
      if (workflow.phase === "balances" && !workflow.activeRow && workflow.userIndex >= workflow.users.length) {
        workflow.phase = "complete";
      }
      const continuationToken = workflow.phase === "complete" ? undefined : randomUUID();
      const incomplete = !workflow.rosterComplete || workflow.failedProfileReads > 0 || workflow.failedBalanceReads > 0;
      const result: PolicyBalancePage = {
        policyId: workflow.policyId, membershipScope: workflow.transitive ? "transitive" : "direct",
        consistencyLevel: "eventual", phase: workflow.phase,
        status: paused ? "paused" : workflow.phase !== "complete" ? "in_progress" : incomplete ? "partial" : "complete",
        rosterComplete: workflow.rosterComplete, usersDiscovered: workflow.members.size,
        usersProcessed: workflow.userIndex, rows, errors: [...workflow.errors, ...(paused ? [paused] : [])],
        failedProfileReads: workflow.failedProfileReads, failedBalanceReads: workflow.failedBalanceReads,
        startedAt: workflow.startedAt, timestamp: new Date().toISOString(),
        expiresAt: new Date(workflow.expires).toISOString(),
        ...(continuationToken ? { continuationToken } : {}),
        ...(paused ? { retryAfterSeconds: paused.retryAfterSeconds ?? 5 } : {}),
      };
      if (payloadBytes(result) > maxResponseBytes) {
        throw new ServiceError("aggregation_response_too_large", "Aggregate output exceeds its response limit. Use the individual paged read tools.", 413);
      }
      if (workflow.replayToken) this.continuations.delete(workflow.replayToken);
      workflow.replayToken = token;
      workflow.replay = token ? structuredClone(result) : undefined;
      workflow.activeToken = continuationToken;
      if (token) this.continuations.set(token, workflow);
      if (continuationToken) this.continuations.set(continuationToken, workflow);
      this.checkLimits(workflow);
      if (!token && !continuationToken) this.discard(workflow);
      return result;
    } catch (error) {
      this.discard(workflow);
      throw error;
    } finally {
      workflow.busy = false;
    }
  }
}
