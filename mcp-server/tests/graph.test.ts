import { describe, expect, it, vi } from "vitest";
import { GraphClient, graphBaseUrl, policyPageUrl, userServiceBalancePageUrl } from "../src/graph/client.js";
import { RequestQueue } from "../src/graph/request-queue.js";
import { actor, config } from "./helpers.js";

describe("Graph adapter", () => {
  it("preserves missing balance fields and the returned remainingQuantity", async () => {
    const data = { billingMethodBalances: [{ remainingQuantity: 99, consumedQuantity: 10 }] };
    const token = vi.fn(async () => "opaque-graph-token");
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(data, { headers: { "request-id": "graph-id" } }));
    const result = await new GraphClient(config, token, fetcher)
      .get(actor, `${graphBaseUrl}/getTenantCreditBalance()`, "CopilotCostManagement.Read.All");
    expect(result.data).toEqual(data);
    expect(result.requestId).toBe("graph-id");
    expect(token).toHaveBeenCalledWith(actor, ["https://graph.microsoft.com/CopilotCostManagement.Read.All"],
      expect.any(AbortSignal));
    expect(fetcher).toHaveBeenCalledWith(`${graphBaseUrl}/getTenantCreditBalance()`, expect.objectContaining({
      method: "GET", redirect: "error",
    }));
  });
  it("returns Graph error status, code and retry delay without customer content", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      error: { code: "TooManyRequests", message: "sensitive-customer-text" },
    }, { status: 429, headers: { "retry-after": "120" } }));
    const client = new GraphClient(config, async () => "token", fetcher);
    await expect(client.get(actor, `${graphBaseUrl}/spendingPolicies`, "scope"))
      .rejects.toMatchObject({ code: "TooManyRequests", status: 429, retryAfterSeconds: 120 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(client.get(actor, `${graphBaseUrl}/spendingPolicies`, "scope"))
      .rejects.toMatchObject({ code: "queue_timeout" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("fails explicitly on invalid JSON", async () => {
    const client = new GraphClient(config, async () => "token",
      vi.fn<typeof fetch>(async () => new Response("<html>")));
    await expect(client.get(actor, `${graphBaseUrl}/spendingPolicies`, "scope"))
      .rejects.toMatchObject({ code: "invalid_graph_response" });
  });
  it("rejects oversized responses rather than truncating them", async () => {
    const client = new GraphClient(config, async () => "token",
      vi.fn<typeof fetch>(async () => new Response("a".repeat(1024 * 1024 + 1))));
    await expect(client.get(actor, `${graphBaseUrl}/spendingPolicies`, "scope"))
      .rejects.toMatchObject({ code: "response_too_large" });
  });
  it("aborts slow authentication and never dispatches Graph afterwards", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const token = vi.fn(async (_actor, _scopes, signal: AbortSignal) => {
      await new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "token";
    });
    const client = new GraphClient({ ...config, graphTimeoutMs: 25 }, token, fetcher);
    await expect(client.get(actor, `${graphBaseUrl}/spendingPolicies`, "scope"))
      .rejects.toMatchObject({ code: "graph_timeout", status: 504 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(token.mock.calls[0]?.[2].aborted).toBe(true);
  });
});

describe("policy paging", () => {
  it("preserves continuation URL bytes unchanged", () => {
    const link = `${graphBaseUrl}/spendingPolicies?$skiptoken=A%2fb%2B%3D`;
    expect(policyPageUrl(link)).toBe(link);
    expect(policyPageUrl()).toBe(`${graphBaseUrl}/spendingPolicies`);
  });
  it.each([
    "https://attacker.test/steal",
    "http://graph.microsoft.com/beta/copilot/costManagement/spendingPolicies",
    "https://user:pass@graph.microsoft.com/beta/copilot/costManagement/spendingPolicies",
    "https://graph.microsoft.com/v1.0/users",
    `${graphBaseUrl}/spendingPolicies?$top=5`,
    `${graphBaseUrl}/spendingPolicies#fragment`,
  ])("rejects unsafe or unsupported continuation URL %s", (link) => {
    expect(() => policyPageUrl(link)).toThrow();
  });
});

describe("user service balance paging", () => {
  const path = `${graphBaseUrl}/userBalances/${actor.objectId}/serviceBalances`;
  it("constructs the evidenced user GUID route and preserves continuation bytes", () => {
    expect(userServiceBalancePageUrl(actor.objectId)).toBe(path);
    const link = `${path}?$skiptoken=A%2fb%2B%3D`;
    expect(userServiceBalancePageUrl(actor.objectId, link)).toBe(link);
    expect(userServiceBalancePageUrl(actor.objectId.toUpperCase(), link)).toBe(link);
    const lowerCaseLink = link.replace("costManagement", "costmanagement");
    expect(userServiceBalancePageUrl(actor.objectId, lowerCaseLink)).toBe(lowerCaseLink);
  });
  it.each(["name@example.test", "me", "../users", "not-a-guid"])("rejects invalid user identifier %s", (userId) => {
    expect(() => userServiceBalancePageUrl(userId)).toThrow();
  });
  it.each([
    "https://attacker.test/steal",
    `http://graph.microsoft.com/beta/copilot/costManagement/userBalances/${actor.objectId}/serviceBalances`,
    `https://name:password@graph.microsoft.com/beta/copilot/costManagement/userBalances/${actor.objectId}/serviceBalances`,
    `https://graph.microsoft.com:444/beta/copilot/costManagement/userBalances/${actor.objectId}/serviceBalances`,
    `${graphBaseUrl}/spendingPolicies`,
    `${graphBaseUrl}/userBalances/bb26bfc5-2c56-4553-bd75-aa9946340b14/serviceBalances`,
    `${path}/cowork`,
    `${path}#fragment`,
  ])("rejects cross-user, cross-resource or unsafe continuation %s", (link) => {
    expect(() => userServiceBalancePageUrl(actor.objectId, link)).toThrow();
  });
});

describe("sequential queue", () => {
  it("never executes operations in parallel", async () => {
    const queue = new RequestQueue(0, 10);
    let active = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 4 }, () => queue.run(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    }, Date.now() + 1000)));
    expect(maximum).toBe(1);
  });
  it("does not deadlock after an operation fails", async () => {
    const queue = new RequestQueue(0, 10);
    await expect(queue.run(async () => { throw new Error("failure"); }, Date.now() + 1000)).rejects.toThrow();
    expect(await queue.run(async () => "ok", Date.now() + 1000)).toBe("ok");
  });
  it("never dispatches a waiting operation after its deadline", async () => {
    const queue = new RequestQueue(0, 10);
    let finish: (() => void) | undefined;
    const first = queue.run(() => new Promise<void>((resolve) => { finish = resolve; }), Date.now() + 1000);
    const expired = vi.fn(async () => "expired");
    await expect(queue.run(expired, Date.now() + 20))
      .rejects.toMatchObject({ code: "queue_timeout" });
    finish?.();
    await first;
    expect(await queue.run(async () => "ok", Date.now() + 1000)).toBe("ok");
    expect(expired).not.toHaveBeenCalled();
  });
  it("retains serialization when an active caller times out", async () => {
    const queue = new RequestQueue(0, 10);
    let finish: (() => void) | undefined;
    await expect(queue.run(() => new Promise<void>((resolve) => { finish = resolve; }), Date.now() + 20))
      .rejects.toMatchObject({ code: "graph_timeout" });
    const next = vi.fn(async () => "ok");
    const waiting = queue.run(next, Date.now() + 1000);
    expect(next).not.toHaveBeenCalled();
    finish?.();
    expect(await waiting).toBe("ok");
  });
});
