import { beforeEach, describe, expect, it, vi } from "vitest";
import { ManagedIdentityCredential, DefaultAzureCredential } from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";
import type { Configuration, OnBehalfOfRequest } from "@azure/msal-node";
import type { Config } from "../src/config.js";
import { createClientAssertionProvider, federationScope } from "../src/auth/client-assertion.js";
import { createGraphTokenProvider } from "../src/auth/graph-obo.js";
import { actor, config, clientId } from "./helpers.js";

const mocks = vi.hoisted(() => {
  const configurations: Configuration[] = [];
  return {
    configurations,
    getToken: vi.fn<ManagedIdentityCredential["getToken"]>(),
    sign: vi.fn(async () => ({ result: new Uint8Array([1, 2, 3]) })),
    obo: vi.fn<(request: OnBehalfOfRequest) => Promise<{ accessToken: string } | null>>(),
    clientCredentials: vi.fn(),
  };
});

vi.mock("@azure/identity", () => ({
  ManagedIdentityCredential: vi.fn(function () { return { getToken: mocks.getToken }; }),
  DefaultAzureCredential: vi.fn(function () { return {}; }),
}));
vi.mock("@azure/keyvault-keys", () => ({
  CryptographyClient: vi.fn(function () { return { sign: mocks.sign }; }),
}));
vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: vi.fn(function (configuration: Configuration) {
    mocks.configurations.push(configuration);
    return {
      acquireTokenOnBehalfOf: async (request: OnBehalfOfRequest) => {
        const assertion = configuration.auth.clientAssertion;
        if (typeof assertion !== "function") throw new Error("Missing client assertion callback.");
        await assertion({ clientId: configuration.auth.clientId });
        return mocks.obo(request);
      },
      acquireTokenByClientCredential: mocks.clientCredentials,
    };
  }),
}));

const federatedConfig: Config = {
  ...config, oboAuthMode: "managed-identity", managedIdentityClientId: clientId, production: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configurations.length = 0;
  mocks.getToken.mockReset().mockResolvedValue({
    token: "mocked-exchange-assertion", expiresOnTimestamp: Date.now() + 300000,
  });
  mocks.obo.mockReset().mockResolvedValue({ accessToken: "mocked-delegated-graph-token" });
});

describe("federated application assertions", () => {
  it.each([true, false])("uses only the selected identity, including production=%s", async (production) => {
    const signal = new AbortController().signal;
    const assertion = await createClientAssertionProvider({ ...federatedConfig, production })(signal);
    expect(assertion).toBe("mocked-exchange-assertion");
    expect(ManagedIdentityCredential).toHaveBeenCalledWith({ clientId });
    expect(mocks.getToken).toHaveBeenCalledWith(federationScope, { abortSignal: signal });
    expect(DefaultAzureCredential).not.toHaveBeenCalled();
    expect(CryptographyClient).not.toHaveBeenCalled();
  });
  it("does not acquire an assertion after cancellation", async () => {
    const signal = AbortSignal.abort();
    await expect(createClientAssertionProvider(federatedConfig)(signal)).rejects.toThrow();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
  it("does not accept a late assertion after cancellation", async () => {
    const controller = new AbortController();
    mocks.getToken.mockImplementationOnce(async () => {
      controller.abort();
      return { token: "late-assertion", expiresOnTimestamp: Date.now() + 300000 };
    });
    await expect(createClientAssertionProvider(federatedConfig)(controller.signal)).rejects.toThrow();
  });
  it("rejects an empty exchange token", async () => {
    mocks.getToken.mockResolvedValueOnce({ token: "", expiresOnTimestamp: 0 });
    await expect(createClientAssertionProvider(federatedConfig)(new AbortController().signal))
      .rejects.toMatchObject({ code: "obo_client_assertion_unavailable", status: 502 });
  });
});

describe("delegated OBO with federated backend credentials", () => {
  const scopes = ["https://graph.microsoft.com/CopilotCostManagement.Read.All"];
  it("keeps caller assertions/scopes separate and a fresh MSAL cache per request", async () => {
    const provider = createGraphTokenProvider(federatedConfig);
    const signal = new AbortController().signal;
    const other = { ...actor, objectId: clientId, assertion: "another-mocked-user-assertion" };
    await expect(provider(actor, scopes, signal)).resolves.toBe("mocked-delegated-graph-token");
    await provider(other, scopes, signal);
    expect(mocks.obo.mock.calls.map(([request]) => request)).toEqual([
      { oboAssertion: actor.assertion, scopes, skipCache: true },
      { oboAssertion: other.assertion, scopes, skipCache: true },
    ]);
    expect(mocks.configurations).toHaveLength(2);
    expect(mocks.configurations[0]).not.toBe(mocks.configurations[1]);
    expect(mocks.configurations[0]?.auth).toMatchObject({
      clientId: config.apiClientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
    });
    expect(mocks.clientCredentials).not.toHaveBeenCalled();
  });
  it("rejects another tenant before acquiring any assertion or downstream token", async () => {
    await expect(createGraphTokenProvider(federatedConfig)(
      { ...actor, tenantId: "another-tenant" }, scopes, new AbortController().signal,
    )).rejects.toMatchObject({ code: "tenant_not_allowed" });
    expect(mocks.configurations).toHaveLength(0);
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
  it("does not fall back to a certificate, Azure CLI or app-only Graph on MI failure", async () => {
    mocks.getToken.mockRejectedValueOnce(new Error("sensitive-upstream-error"));
    const result = createGraphTokenProvider(federatedConfig)(actor, scopes, new AbortController().signal);
    await expect(result).rejects.toMatchObject({
      code: "graph_consent_or_authentication_required", status: 403,
    });
    await expect(result).rejects.not.toThrow("sensitive-upstream-error");
    expect(DefaultAzureCredential).not.toHaveBeenCalled();
    expect(CryptographyClient).not.toHaveBeenCalled();
    expect(mocks.clientCredentials).not.toHaveBeenCalled();
    expect(mocks.obo).not.toHaveBeenCalled();
  });
  it("maps cancelled credential acquisition to the shared authentication timeout", async () => {
    const controller = new AbortController();
    mocks.getToken.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("cancelled");
    });
    await expect(createGraphTokenProvider(federatedConfig)(actor, scopes, controller.signal))
      .rejects.toMatchObject({ code: "graph_timeout", status: 504 });
    expect(mocks.getToken).toHaveBeenCalledWith(federationScope, { abortSignal: controller.signal });
  });
  it("rejects missing delegated Graph tokens", async () => {
    mocks.obo.mockResolvedValueOnce(null);
    await expect(createGraphTokenProvider(federatedConfig)(actor, scopes, new AbortController().signal))
      .rejects.toMatchObject({ code: "graph_token_unavailable", status: 502 });
  });
  it("does not return a Graph token acquired after the deadline", async () => {
    const controller = new AbortController();
    mocks.obo.mockImplementationOnce(async () => {
      controller.abort();
      return { accessToken: "late-graph-token" };
    });
    await expect(createGraphTokenProvider(federatedConfig)(actor, scopes, controller.signal))
      .rejects.toMatchObject({ code: "graph_timeout", status: 504 });
  });
});

describe("explicit certificate-mode compatibility", () => {
  it("retains the signed certificate assertion and cancellation-aware signing", async () => {
    const signal = new AbortController().signal;
    const assertion = await createClientAssertionProvider(config)(signal);
    const [header, payload] = assertion.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toMatchObject({
      alg: "RS256", x5t: Buffer.from("a".repeat(40), "hex").toString("base64url"),
    });
    expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
      aud: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
      iss: config.apiClientId, sub: config.apiClientId,
    });
    expect(CryptographyClient).toHaveBeenCalled();
    expect(mocks.sign).toHaveBeenCalledWith("RS256", expect.any(Uint8Array), { abortSignal: signal });
    expect(mocks.getToken).not.toHaveBeenCalled();
  });
});
