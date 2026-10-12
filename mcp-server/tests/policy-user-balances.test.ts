import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GraphClient, groupUsersPageUrl, policyAssignedGroupsPageUrl,
  userBasicProfileUrl, userServiceBalancePageUrl, type GraphResult,
} from "../src/graph/client.js";
import {
  PolicyUserBalanceReader, type PolicyBalancePage,
} from "../src/tools/policy-user-balances.js";
import { ServiceError } from "../src/errors.js";
import { actor, config } from "./helpers.js";

const policyId = "opaque-policy";
const firstGroup = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondGroup = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function userId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}
function result(data: unknown): GraphResult {
  return { data, timestamp: new Date().toISOString(), requestId: "offline-request" };
}
function payloadLength(page: PolicyBalancePage): number {
  return Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(page) }], structuredContent: page,
  }));
}
function fixture(count = 53, transitive = true) {
  const ids = Array.from({ length: count }, (_, index) => userId(index + 1));
  const memberNext = `${groupUsersPageUrl(firstGroup, transitive)}&$skiptoken=members`;
  const balanceNext = `${userServiceBalancePageUrl(ids[0]!)}?$skiptoken=balances`;
  const implementation: GraphClient["get"] = async (_caller, uri) => {
    if (uri === policyAssignedGroupsPageUrl(policyId)) {
      return result({ value: [{ id: firstGroup }, { id: secondGroup }] });
    }
    if (uri === groupUsersPageUrl(firstGroup, transitive)) {
      return result({
        value: ids.slice(0, 30).map((id) => ({ id, displayName: null, userPrincipalName: null })),
        ...(ids.length > 30 ? { "@odata.nextLink": memberNext } : {}),
      });
    }
    if (uri === memberNext) return result({ value: ids.slice(30).map((id) => ({ id })) });
    if (uri === groupUsersPageUrl(secondGroup, transitive)) {
      return result({ value: ids.slice(0, 15).map((id) => ({ id: id.toUpperCase() })) });
    }
    const id = ids.find((value) => uri === userBasicProfileUrl(value));
    if (id) return result({ id, displayName: `User ${id}`, userPrincipalName: `${id}@example.test` });
    if (uri === balanceNext) return result({ value: [{ serviceId: "other", unit: "credits" }], period: "returned-period" });
    const target = ids.find((value) => uri === userServiceBalancePageUrl(value));
    if (target) {
      return result({
        value: [{ serviceId: "cowork", remainingQuantity: 0, unit: "credits" }],
        ...(target === ids[0] ? { "@odata.nextLink": balanceNext } : {}),
      });
    }
    throw new Error(`Unexpected offline URI: ${uri}`);
  };
  const get = vi.fn<GraphClient["get"]>(implementation);
  return { get, implementation, ids, memberNext, balanceNext, reader: new PolicyUserBalanceReader({ get }) };
}

async function collect(reader: PolicyUserBalanceReader, transitive?: boolean) {
  const pages: PolicyBalancePage[] = [];
  let continuationToken: string | undefined;
  do {
    if (pages.length >= 100) throw new Error("Offline workflow did not terminate.");
    const page = await reader.read(actor, { policyId, transitive, continuationToken });
    expect(page.status).not.toBe("paused");
    pages.push(page);
    continuationToken = page.continuationToken;
  } while (continuationToken);
  return { pages, rows: pages.flatMap((page) => page.rows), last: pages[pages.length - 1]! };
}

afterEach(() => vi.useRealTimers());

describe("bounded policy user balance aggregation", () => {
  it("resolves all 53 distinct users with paging and fewer than 53 bounded tool calls", async () => {
    const { reader, get, ids, memberNext, balanceNext } = fixture();
    const pages: PolicyBalancePage[] = [];
    let continuationToken: string | undefined;
    do {
      const before = get.mock.calls.length;
      const page = await reader.read(actor, { policyId, continuationToken });
      expect(get.mock.calls.length - before).toBeLessThanOrEqual(8);
      expect(page.rows.length).toBeLessThanOrEqual(5);
      expect(payloadLength(page)).toBeLessThanOrEqual(256 * 1024);
      pages.push(page);
      continuationToken = page.continuationToken;
      if (pages.length > 53) throw new Error("Aggregate call reduction failed.");
    } while (continuationToken);
    expect(pages).toHaveLength(14);
    const rows = pages.flatMap((page) => page.rows);
    expect(rows).toHaveLength(53);
    expect(new Set(rows.map((row) => row.id.toLowerCase()))).toEqual(new Set(ids));
    expect(rows.every((row) => row.nameResolutionStatus === "complete" && row.balanceStatus === "complete")).toBe(true);
    expect(pages.at(-1)).toMatchObject({
      status: "complete", rosterComplete: true, usersDiscovered: 53, usersProcessed: 53,
      failedProfileReads: 0, failedBalanceReads: 0, errors: [],
    });
    expect(rows[0]).toMatchObject({
      sourceGroupIds: [firstGroup, secondGroup], nameSources: { displayName: "basic_profile" },
      serviceBalancePages: [
        { data: { value: [{ remainingQuantity: 0, unit: "credits" }] } },
        { data: { value: [{ serviceId: "other", unit: "credits" }], period: "returned-period" } },
      ],
    });
    expect(get.mock.calls.filter((call) => call[2] === "User.ReadBasic.All")).toHaveLength(53);
    expect(get.mock.calls.filter((call) => call[2] === "CopilotCostManagement-UserData.Read.All")).toHaveLength(54);
    expect(get.mock.calls.some((call) => call[1] === memberNext)).toBe(true);
    expect(get.mock.calls.some((call) => call[1] === balanceNext)).toBe(true);
    for (const call of get.mock.calls) {
      expect(call[0]).toBe(actor);
      expect(call[4]).toBeTypeOf("number");
      if (call[2] === "GroupMember.ReadBasic.All") expect(call[3]).toBe("eventual");
    }
  });

  it("retains direct membership mode when it is omitted on continuation", async () => {
    const { reader, get } = fixture(10, false);
    const first = await reader.read(actor, { policyId, transitive: false });
    expect(first.membershipScope).toBe("direct");
    const next = await reader.read(actor, { policyId, continuationToken: first.continuationToken });
    expect(next.membershipScope).toBe("direct");
    expect(get.mock.calls.filter((call) => call[2] === "GroupMember.ReadBasic.All")
      .every((call) => call[1].includes("/members/"))).toBe(true);
  });

  it("deduplicates paged assignments before enumerating each group", async () => {
    const { reader, get, implementation } = fixture(2);
    const nextLink = `${policyAssignedGroupsPageUrl(policyId)}?$skiptoken=groups`;
    get.mockResolvedValueOnce(result({ value: [{ id: firstGroup }], "@odata.nextLink": nextLink }));
    get.mockImplementation(async (...args) => args[1] === nextLink
      ? result({ value: [{ id: firstGroup.toUpperCase() }, { id: secondGroup }] })
      : implementation(...args));
    const { rows, last } = await collect(reader);
    expect(last.rosterComplete).toBe(true);
    expect(rows).toHaveLength(2);
    expect(get.mock.calls.filter((call) => call[1] === groupUsersPageUrl(firstGroup, true))).toHaveLength(1);
  });

  it("retains membership name provenance/conflicts and skips unnecessary profile reads", async () => {
    const { reader, get, implementation, ids } = fixture(2);
    get.mockImplementation(async (...args) => {
      if (args[1] === groupUsersPageUrl(firstGroup, true)) {
        return result({ value: [
          { id: ids[0], displayName: "Retained name", userPrincipalName: "retained@example.test" },
          { id: ids[1], displayName: "Retained partial name", userPrincipalName: null },
        ] });
      }
      if (args[1] === groupUsersPageUrl(secondGroup, true)) {
        return result({ value: [{ id: ids[0], displayName: "Conflicting membership name" }] });
      }
      return implementation(...args);
    });
    const { rows } = await collect(reader);
    expect(rows[0]).toMatchObject({
      displayName: "Retained name", userPrincipalName: "retained@example.test", profileLookupStatus: "not_needed",
      nameSources: { displayName: `group:${firstGroup}` },
      nameConflicts: [{ field: "displayName", retained: "Retained name", observed: "Conflicting membership name" }],
    });
    expect(rows[1]).toMatchObject({
      displayName: "Retained partial name", nameResolutionStatus: "complete",
      nameSources: { displayName: `group:${firstGroup}`, userPrincipalName: "basic_profile" },
      nameConflicts: [{ field: "displayName", retained: "Retained partial name" }],
    });
    expect(get.mock.calls.filter((call) => call[2] === "User.ReadBasic.All")).toHaveLength(1);
  });

  it("replays the preceding response without rereading or corrupting retained state", async () => {
    const { reader, get } = fixture(20);
    const first = await reader.read(actor, { policyId });
    const input = { policyId, continuationToken: first.continuationToken };
    const next = await reader.read(actor, input);
    const calls = get.mock.calls.length;
    expect(await reader.read(actor, input)).toEqual(next);
    const replay = await reader.read(actor, input);
    replay.rows[0]!.displayName = "changed by consumer";
    expect(await reader.read(actor, input)).toEqual(next);
    expect(get.mock.calls).toHaveLength(calls);
    const following = await reader.read(actor, { policyId, continuationToken: next.continuationToken });
    expect(following.usersProcessed).toBeGreaterThan(next.usersProcessed);
    await expect(reader.read(actor, input)).rejects.toMatchObject({ code: "invalid_or_expired_continuation" });
  });

  it("binds continuations to tenant, user, client, policy and mode before dispatch", async () => {
    const { reader, get } = fixture(20);
    const first = await reader.read(actor, { policyId });
    const calls = get.mock.calls.length;
    for (const caller of [
      { ...actor, tenantId: secondGroup },
      { ...actor, objectId: secondGroup },
      { ...actor, clientId: secondGroup },
    ]) {
      await expect(reader.read(caller, { policyId, continuationToken: first.continuationToken }))
        .rejects.toMatchObject({ code: "invalid_or_expired_continuation" });
    }
    for (const input of [
      { policyId: "other-policy", continuationToken: first.continuationToken },
      { policyId, transitive: false, continuationToken: first.continuationToken },
      { policyId, continuationToken: firstGroup },
    ]) {
      await expect(reader.read(actor, input)).rejects.toMatchObject({ code: "invalid_or_expired_continuation" });
    }
    expect(get.mock.calls).toHaveLength(calls);
  });

  it("uses the refreshed caller assertion for subsequent dispatches", async () => {
    const { reader, get } = fixture(20);
    const first = await reader.read(actor, { policyId });
    const calls = get.mock.calls.length;
    const refreshed = { ...actor, assertion: "new-offline-assertion" };
    await reader.read(refreshed, { policyId, continuationToken: first.continuationToken });
    expect(get.mock.calls.slice(calls).every((call) => call[0] === refreshed)).toBe(true);
  });

  it("rejects concurrent advancement without duplicating Graph requests", async () => {
    const { reader, get, implementation } = fixture(20);
    const first = await reader.read(actor, { policyId });
    let release!: (value: GraphResult) => void;
    get.mockImplementationOnce(() => new Promise<GraphResult>((resolve) => { release = resolve; }));
    const input = { policyId, continuationToken: first.continuationToken };
    const advance = reader.read(actor, input);
    await expect(reader.read(actor, input)).rejects.toMatchObject({ code: "aggregation_busy", status: 409 });
    const args = get.mock.lastCall!;
    release(await implementation(...args));
    expect((await advance).status).toBe("in_progress");
  });

  it("expires continuations and discards state after 15 minutes", async () => {
    vi.useFakeTimers();
    const { reader, get } = fixture(20);
    const first = await reader.read(actor, { policyId });
    const calls = get.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await expect(reader.read(actor, { policyId, continuationToken: first.continuationToken }))
      .rejects.toMatchObject({ code: "invalid_or_expired_continuation" });
    expect(get.mock.calls).toHaveLength(calls);
  });

  it("does not disguise a denied assignment read as an empty policy", async () => {
    const { reader, get } = fixture();
    get.mockRejectedValueOnce(new ServiceError("Authorization_RequestDenied", "Read denied.", 403));
    const page = await reader.read(actor, { policyId });
    expect(page).toMatchObject({
      status: "partial", rosterComplete: false, rows: [],
      errors: [{ stage: "assigned_groups", code: "Authorization_RequestDenied", status: 403 }],
    });
    expect(page.continuationToken).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("preserves known users while marking inaccessible groups and roster incompleteness", async () => {
    const { reader, get, implementation } = fixture(3);
    get.mockImplementation(async (...args) => {
      if (args[1] === groupUsersPageUrl(secondGroup, true)) {
        throw new ServiceError("Authorization_RequestDenied", "Hidden group denied.", 403);
      }
      return implementation(...args);
    });
    const { rows, last } = await collect(reader);
    expect(rows).toHaveLength(3);
    expect(last).toMatchObject({
      status: "partial", rosterComplete: false, errors: [{ groupId: secondGroup, status: 403 }],
    });
  });

  it.each([403, 404])("continues balances after profile read failure (%s)", async (status) => {
    const { reader, get, implementation, ids } = fixture(3);
    get.mockImplementation(async (...args) => {
      if (args[1] === userBasicProfileUrl(ids[0]!)) throw new ServiceError("ProfileUnavailable", "Profile read failed.", status);
      return implementation(...args);
    });
    const { rows, last } = await collect(reader);
    expect(rows[0]).toMatchObject({
      nameResolutionStatus: "unavailable", profileLookupStatus: "failed",
      profileError: { status }, balanceStatus: "complete", serviceBalancePages: expect.any(Array),
    });
    expect(last).toMatchObject({ status: "partial", failedProfileReads: 1, failedBalanceReads: 0 });
  });

  it("rejects mismatched profile IDs and still reads that user's balance", async () => {
    const { reader, get, implementation, ids } = fixture(2);
    get.mockImplementation(async (...args) => args[1] === userBasicProfileUrl(ids[0]!)
      ? result({ id: ids[1], displayName: "Wrong user's name" })
      : implementation(...args));
    const { rows } = await collect(reader);
    expect(rows[0]).toMatchObject({
      profileError: { code: "invalid_graph_profile" }, balanceStatus: "complete",
    });
    expect(rows[0]?.displayName).not.toBe("Wrong user's name");
  });

  it("preserves missing/empty profile values and explicitly distinguishes no service records from zero", async () => {
    const { reader, get, implementation, ids } = fixture(1);
    get.mockImplementation(async (...args) => {
      if (args[1] === userBasicProfileUrl(ids[0]!)) return result({ id: ids[0], displayName: " ", userPrincipalName: null });
      if (args[2] === "CopilotCostManagement-UserData.Read.All") return result({ value: [] });
      return implementation(...args);
    });
    const { rows } = await collect(reader);
    expect(rows[0]).toMatchObject({ nameResolutionStatus: "unavailable", balanceStatus: "no_records" });
    expect(JSON.stringify(rows)).not.toContain("remainingQuantity");
  });

  it("retains earlier balance pages when a subsequent read is denied", async () => {
    const { reader, get, implementation, balanceNext } = fixture(2);
    get.mockImplementation(async (...args) => {
      if (args[1] === balanceNext) throw new ServiceError("BalanceUnavailable", "Balance read failed.", 403);
      return implementation(...args);
    });
    const { rows, last } = await collect(reader);
    expect(rows[0]).toMatchObject({
      balanceStatus: "partial", balanceError: { status: 403 },
      serviceBalancePages: [{ data: { value: [{ remainingQuantity: 0 }] } }],
    });
    expect(rows[0]?.serviceBalancePages).toHaveLength(1);
    expect(last.failedBalanceReads).toBe(1);
  });

  it("rejects cross-user continuations while retaining the valid returned page", async () => {
    const { reader, get, implementation, ids } = fixture(2);
    get.mockImplementation(async (...args) => args[1] === userServiceBalancePageUrl(ids[0]!)
      ? result({ value: [{ serviceId: "cowork" }], "@odata.nextLink": userServiceBalancePageUrl(ids[1]!) })
      : implementation(...args));
    const { rows } = await collect(reader);
    expect(rows[0]).toMatchObject({
      balanceStatus: "partial", balanceError: { code: "invalid_next_link" },
      serviceBalancePages: [{ data: { value: [{ serviceId: "cowork" }] } }],
    });
    expect(get.mock.calls.filter((call) => call[1] === userServiceBalancePageUrl(ids[1]!))).toHaveLength(1);
  });

  it("detects cyclic upstream paging without repeating the request", async () => {
    const { reader, get, implementation, ids } = fixture(1);
    const uri = userServiceBalancePageUrl(ids[0]!);
    get.mockImplementation(async (...args) => args[1] === uri
      ? result({ value: [{ serviceId: "cowork" }], "@odata.nextLink": uri })
      : implementation(...args));
    const { rows } = await collect(reader);
    expect(rows[0]).toMatchObject({ balanceStatus: "partial", balanceError: { code: "repeated_next_link" } });
    expect(get.mock.calls.filter((call) => call[1] === uri)).toHaveLength(1);
  });

  it("pauses on throttling, surfaces Retry-After and permits deliberate continuation without an internal retry loop", async () => {
    vi.useFakeTimers();
    const { reader, get } = fixture(3);
    get.mockRejectedValueOnce(new ServiceError("TooManyRequests", "Throttled.", 429, 7, "upstream-retry"));
    const first = await reader.read(actor, { policyId });
    expect(first).toMatchObject({
      status: "paused", retryAfterSeconds: 7, errors: [{ status: 429, requestId: "upstream-retry" }],
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(first.continuationToken).toBeDefined();
    const pending = reader.read(actor, { policyId, continuationToken: first.continuationToken });
    await vi.advanceTimersByTimeAsync(6999);
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const next = await pending;
    expect(next.status).not.toBe("paused");
  });

  it.each([
    ["graph_timeout", 504, 5, "profile"],
    ["TooManyRequests", 429, 7, "profile"],
    ["ServiceUnavailable", 503, 10, "profile"],
    ["graph_timeout", 504, 5, "balance"],
    ["TooManyRequests", 429, 7, "balance"],
    ["ServiceUnavailable", 503, 10, "balance"],
  ])("resumes %s after user 35 on %s without losing, duplicating or rounding any of 53 users", async (code, status, delay, stage) => {
    vi.useFakeTimers();
    const { reader, get, implementation, ids, balanceNext } = fixture();
    const failingUri = stage === "profile" ? userBasicProfileUrl(ids[35]!) : userServiceBalancePageUrl(ids[35]!);
    let failed = false;
    const raw = { value: [
      { serviceId: "cowork", remainingQuantity: 12.5, consumedQuantity: -2.5, unit: "credits" },
      { serviceId: "other", remainingQuantity: null, unit: "credits" },
      { serviceId: "missing", unit: "credits" },
    ] };
    get.mockImplementation(async (...args) => {
      if (!failed && args[1] === failingUri) {
        failed = true;
        throw new ServiceError(code, "Transient offline failure.", status, delay);
      }
      if (args[1] === userServiceBalancePageUrl(ids[0]!)) {
        return result({ ...raw, "@odata.nextLink": balanceNext });
      }
      return implementation(...args);
    });
    const pages: PolicyBalancePage[] = [];
    let token: string | undefined;
    let sentToken: string | undefined;
    do {
      sentToken = token;
      const page = await reader.read(actor, { policyId, continuationToken: token });
      pages.push(page);
      token = page.continuationToken;
      if (page.status === "paused") break;
    } while (token);
    expect(pages.at(-1)).toMatchObject({ status: "paused", usersProcessed: 35, retryAfterSeconds: delay });
    const before = get.mock.calls.length;
    expect(await reader.read(actor, { policyId, continuationToken: sentToken })).toEqual(pages.at(-1));
    expect(get).toHaveBeenCalledTimes(before);
    const pending = reader.read(actor, { policyId, continuationToken: token });
    await expect(reader.read(actor, { policyId, continuationToken: token }))
      .rejects.toMatchObject({ code: "aggregation_busy" });
    await vi.advanceTimersByTimeAsync(delay * 1000 - 1);
    expect(get).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    const resumed = await pending;
    pages.push(resumed);
    token = resumed.continuationToken;
    while (token) {
      const page = await reader.read(actor, { policyId, continuationToken: token });
      pages.push(page);
      token = page.continuationToken;
    }
    const rows = pages.flatMap((page) => page.rows);
    expect(rows).toHaveLength(53);
    expect(new Set(rows.map((row) => row.id))).toEqual(new Set(ids));
    expect(rows[0]!.serviceBalancePages[0]!.data).toMatchObject(raw);
    expect(rows[0]!.serviceBalancePages).toHaveLength(2);
    expect(pages.at(-1)).toMatchObject({ status: "complete", usersProcessed: 53, usersDiscovered: 53 });
    expect(get.mock.calls.filter((call) => call[1] === failingUri)).toHaveLength(2);
    expect(get.mock.calls.filter((call) => call[2] === "CopilotCostManagement-UserData.Read.All"))
      .toHaveLength(stage === "balance" ? 55 : 54);
  });

  it("reports remaining long waits without dispatch and allows continuation when only ten seconds remain", async () => {
    vi.useFakeTimers();
    const { reader, get } = fixture(1);
    get.mockRejectedValueOnce(new ServiceError("TooManyRequests", "Wait.", 429, 120));
    const first = await reader.read(actor, { policyId });
    await vi.advanceTimersByTimeAsync(3000);
    const paused = await reader.read(actor, { policyId, continuationToken: first.continuationToken });
    expect(paused).toMatchObject({ status: "paused", retryAfterSeconds: 117, usersProcessed: 0 });
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(107000);
    const pending = reader.read(actor, { policyId, continuationToken: paused.continuationToken });
    await vi.advanceTimersByTimeAsync(10000);
    expect((await pending).status).not.toBe("paused");
  });

  it("does not wait beyond workflow expiry or dispatch near its deadline", async () => {
    vi.useFakeTimers();
    const { reader, get } = fixture(1);
    get.mockRejectedValueOnce(new ServiceError("TooManyRequests", "Wait.", 429, 898));
    const first = await reader.read(actor, { policyId });
    await vi.advanceTimersByTimeAsync(895000);
    const paused = await reader.read(actor, { policyId, continuationToken: first.continuationToken });
    expect(paused).toMatchObject({ status: "paused", retryAfterSeconds: 3 });
    expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(reader.read(actor, { policyId, continuationToken: paused.continuationToken }))
      .rejects.toMatchObject({ code: "invalid_or_expired_continuation" });
  });

  it("stops dispatching when the overall call budget is almost exhausted", async () => {
    vi.useFakeTimers();
    const { reader, get, implementation } = fixture(3);
    get.mockImplementationOnce(async (...args) => {
      await vi.advanceTimersByTimeAsync(13000);
      return implementation(...args);
    });
    const page = await reader.read(actor, { policyId });
    expect(page).toMatchObject({ status: "in_progress", phase: "members", rows: [] });
    expect(page.continuationToken).toBeDefined();
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized aggregate rows explicitly without dropping the user or fabricating balances", async () => {
    const { reader, get, implementation, ids } = fixture(1);
    get.mockImplementation(async (...args) => args[1] === userServiceBalancePageUrl(ids[0]!)
      ? result({ value: [{ serviceId: "cowork", returnedText: "x".repeat(128 * 1024) }] })
      : implementation(...args));
    const { rows, last } = await collect(reader);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      balanceStatus: "failed", balanceError: { code: "aggregation_row_too_large" }, serviceBalancePages: [],
    });
    expect(last.status).toBe("partial");
  });

  it("splits large valid rows into bounded responses without rereading the next row", async () => {
    const { reader, get, implementation } = fixture(8);
    get.mockImplementation(async (...args) => args[2] === "CopilotCostManagement-UserData.Read.All"
      ? result({ value: [{ serviceId: "cowork", returnedText: "x".repeat(110 * 1024) }] })
      : implementation(...args));
    const { pages, rows } = await collect(reader);
    expect(rows).toHaveLength(8);
    expect(pages.every((page) => payloadLength(page) <= 256 * 1024)).toBe(true);
    expect(get.mock.calls.filter((call) => call[2] === "CopilotCostManagement-UserData.Read.All")).toHaveLength(8);
  });

  it("rejects workflows beyond group/user limits instead of claiming completeness", async () => {
    const { reader, get } = fixture();
    get.mockResolvedValueOnce(result({ value: Array.from({ length: 101 }, (_, index) => ({ id: userId(index + 1) })) }));
    await expect(reader.read(actor, { policyId })).rejects.toMatchObject({ code: "aggregation_limit" });
    const next = fixture();
    next.get.mockResolvedValueOnce(result({ value: [{ id: firstGroup }] }));
    next.get.mockResolvedValueOnce(result({ value: Array.from({ length: 1001 }, (_, index) => ({ id: userId(index + 1) })) }));
    await expect(next.reader.read(actor, { policyId })).rejects.toMatchObject({ code: "aggregation_limit" });
  });

  it("bounds concurrent workflow storage and releases it on expiry", async () => {
    vi.useFakeTimers();
    const { reader, get } = fixture(53);
    for (let index = 0; index < 20; index++) await reader.read(actor, { policyId });
    const calls = get.mock.calls.length;
    await expect(reader.read(actor, { policyId })).rejects.toMatchObject({ code: "aggregation_capacity", status: 429 });
    expect(get.mock.calls).toHaveLength(calls);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect((await reader.read(actor, { policyId })).status).toBe("in_progress");
  });

  it("reserves response space for accumulated group errors while returning large valid rows", async () => {
    const ids = Array.from({ length: 3 }, (_, index) => userId(index + 1));
    const groups = Array.from({ length: 100 }, (_, index) => userId(index + 100));
    const get = vi.fn<GraphClient["get"]>(async (_caller, uri, scope) => {
      if (scope === "CopilotCostManagement-Assignment.Read.All") return result({ value: groups.map((id) => ({ id })) });
      if (uri === groupUsersPageUrl(groups[0]!, true)) {
        return result({ value: ids.map((id) => ({ id, displayName: "Name", userPrincipalName: "UPN" })) });
      }
      if (scope === "GroupMember.ReadBasic.All") throw new ServiceError("Denied", "x".repeat(1000), 403);
      return result({ value: [{ serviceId: "cowork", data: "x".repeat(10 * 1024) }] });
    });
    const { rows, pages, last } = await collect(new PolicyUserBalanceReader({ get }));
    expect(rows).toHaveLength(3);
    expect(last).toMatchObject({ status: "partial", rosterComplete: false });
    expect(last.errors).toHaveLength(99);
    expect(pages.every((page) => payloadLength(page) <= 256 * 1024)).toBe(true);
  });

  it("enforces the buffered-state limit during large conflicting membership reads", async () => {
    const groups = Array.from({ length: 100 }, (_, index) => userId(index + 100));
    const get = vi.fn<GraphClient["get"]>(async (_caller, uri, scope) => {
      if (scope === "CopilotCostManagement-Assignment.Read.All") return result({ value: groups.map((id) => ({ id })) });
      return result({ value: Array.from({ length: 20 }, (_, index) => ({
        id: userId(index + 1), displayName: uri.slice(0, 80) + "x".repeat(900),
        userPrincipalName: uri.slice(0, 80) + "y".repeat(900),
      })) });
    });
    const reader = new PolicyUserBalanceReader({ get });
    async function exceedState() {
      let continuationToken: string | undefined;
      for (let index = 0; index < 30; index++) {
        const page = await reader.read(actor, { policyId, continuationToken });
        expect(page.status).not.toBe("complete");
        continuationToken = page.continuationToken;
      }
      throw new Error("The buffered-state limit was not enforced.");
    }
    await expect(exceedState()).rejects.toMatchObject({ code: "aggregation_limit" });
    expect(get.mock.calls.length).toBeLessThan(101);
  });

  it("does not dispatch beyond the exact 1,000 collection-page limit", async () => {
    let fetchedPages = 0;
    const get = vi.fn<GraphClient["get"]>(async () => {
      fetchedPages++;
      return result({
        value: [], "@odata.nextLink": `${policyAssignedGroupsPageUrl(policyId)}?$skiptoken=${fetchedPages}`,
      });
    });
    const reader = new PolicyUserBalanceReader({ get });
    async function exceedPages() {
      let continuationToken: string | undefined;
      for (let index = 0; index < 130; index++) {
        const page = await reader.read(actor, { policyId, continuationToken });
        expect(page.status).not.toBe("complete");
        continuationToken = page.continuationToken;
      }
      throw new Error("The collection-page limit was not enforced.");
    }
    await expect(exceedPages()).rejects.toMatchObject({ code: "aggregation_limit" });
    expect(get).toHaveBeenCalledTimes(1000);
  });

  it("does not hide unexpected implementation errors as partial success", async () => {
    const { reader, get } = fixture();
    get.mockRejectedValueOnce(new Error("unexpected offline implementation failure"));
    await expect(reader.read(actor, { policyId })).rejects.toThrow("unexpected offline implementation failure");
  });

  it("applies an aggregate deadline to the real Graph client without changing the ordinary call budget", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_uri, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("offline abort")), { once: true });
    }));
    const graph = new GraphClient({ ...config, graphTimeoutMs: 1000 }, async () => "offline-token", fetcher);
    const start = Date.now();
    await expect(graph.get(actor, userBasicProfileUrl(actor.objectId), "User.ReadBasic.All", undefined, start + 50))
      .rejects.toMatchObject({ code: "graph_timeout", status: 504 });
    expect(Date.now() - start).toBeLessThan(500);
    const calls = fetcher.mock.calls.length;
    await expect(graph.get(actor, userBasicProfileUrl(actor.objectId), "User.ReadBasic.All", undefined, Date.now() - 1))
      .rejects.toMatchObject({ code: "graph_timeout" });
    expect(fetcher.mock.calls).toHaveLength(calls);
  });
});
