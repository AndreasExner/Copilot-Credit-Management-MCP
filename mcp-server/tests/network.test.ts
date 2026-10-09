import { describe, expect, it, vi } from "vitest";
import { createAuthenticationNetwork } from "../src/auth/network.js";

describe("authentication network deadline", () => {
  it("passes the same abort signal to token POST and discovery GET", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ value: "mock" }, { headers: { "request-id": "id" } }));
    const network = createAuthenticationNetwork(controller.signal, fetcher);
    const result = await network.sendGetRequestAsync<{ value: string }>(
      "https://login.microsoftonline.com/common/discovery/instance",
    );
    expect(result.body.value).toBe("mock");
    expect(result.status).toBe(200);
    await network.sendPostRequestAsync("https://login.microsoftonline.com/tenant/oauth2/v2.0/token", {
      body: "assertion=mock", headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(fetcher.mock.calls.every((call) => call[1]?.signal === controller.signal)).toBe(true);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST", body: "assertion=mock", redirect: "error" });
  });
  it("rejects cancellation before any network request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn<typeof fetch>();
    await expect(createAuthenticationNetwork(controller.signal, fetcher)
      .sendPostRequestAsync("https://login.microsoftonline.com/tenant/oauth2/v2.0/token"))
      .rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects an untrusted discovery destination", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createAuthenticationNetwork(new AbortController().signal, fetcher)
      .sendGetRequestAsync("https://attacker.test/token"))
      .rejects.toMatchObject({ code: "invalid_authority" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
