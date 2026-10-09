import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from "jose";
import { createAuthenticator } from "../src/auth/validate-token.js";
import { loadConfig } from "../src/config.js";
import { config, tenantId, apiId, clientId, actor } from "./helpers.js";

describe("delegated MCP JWT authentication", () => {
  let key: CryptoKey;
  let keys: JWTVerifyGetKey;
  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    key = pair.privateKey;
    const publicKey = await exportJWK(pair.publicKey);
    keys = createLocalJWKSet({ keys: [{ ...publicKey, kid: "local-test", alg: "RS256" }] });
  });
  const token = async (overrides: Record<string, unknown> = {}) => new SignJWT({
    tid: tenantId, oid: actor.objectId, azp: clientId, scp: "Mcp.Read",
    ver: "2.0", ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "local-test" })
    .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
    .setAudience(apiId).setIssuedAt().setNotBefore("0 seconds")
    .setExpirationTime("5 minutes").sign(key);

  it("accepts a valid delegated user token", async () => {
    const value = await token();
    const result = await createAuthenticator(config, keys)(`Bearer ${value}`);
    expect(result.objectId).toBe(actor.objectId);
    expect(result.scopes.has("Mcp.Read")).toBe(true);
  });
  it("rejects anonymous calls", async () => {
    await expect(createAuthenticator(config, keys)(undefined)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { tid: "another-tenant" },
    { azp: "another-client" },
    { scp: "" },
    { idtyp: "app" },
    { ver: "1.0" },
    { oid: null },
  ])("rejects invalid delegated claims %j", async (claims) => {
    await expect(createAuthenticator(config, keys)(`Bearer ${await token(claims)}`)).rejects.toThrow();
  });
  it("rejects a token intended for Graph", async () => {
    const value = await new SignJWT({
      tid: tenantId, oid: actor.objectId, azp: clientId, scp: "Mcp.Read", ver: "2.0",
    }).setProtectedHeader({ alg: "RS256", kid: "local-test" })
      .setIssuer(`https://login.microsoftonline.com/${tenantId}/v2.0`)
      .setAudience("00000003-0000-0000-c000-000000000000")
      .setIssuedAt().setNotBefore("0 seconds").setExpirationTime("5 minutes").sign(key);
    await expect(createAuthenticator(config, keys)(`Bearer ${value}`)).rejects.toMatchObject({ status: 401 });
  });
  it("rejects ID tokens without delegated scopes", async () => {
    await expect(createAuthenticator(config, keys)(`Bearer ${await token({ scp: undefined })}`)).rejects.toThrow();
  });
});

describe("configuration validation", () => {
  const environment = {
    ENTRA_TENANT_ID: tenantId,
    MCP_API_CLIENT_ID: apiId,
    MCP_ALLOWED_CLIENT_IDS: clientId,
    MCP_PUBLIC_URL: config.publicUrl,
  };
  it("accepts explicit federation without dummy certificate values", () => {
    const result = loadConfig({
      ...environment, OBO_AUTH_MODE: "managed-identity", AZURE_CLIENT_ID: clientId,
    });
    expect(result).toMatchObject({ oboAuthMode: "managed-identity", managedIdentityClientId: clientId });
    expect(result).not.toHaveProperty("signingKeyId");
    expect(result).not.toHaveProperty("certificateThumbprint");
  });
  it("requires an explicit user-assigned identity for federation", () => {
    expect(() => loadConfig({ ...environment, OBO_AUTH_MODE: "managed-identity" }))
      .toThrow(/AZURE_CLIENT_ID/);
  });
  it.each(["OBO_KEY_ID", "OBO_CERTIFICATE_THUMBPRINT"])("rejects mixed credentials: %s", (name) => {
    expect(() => loadConfig({
      ...environment, OBO_AUTH_MODE: "managed-identity", AZURE_CLIENT_ID: clientId, [name]: "",
    })).toThrow(new RegExp(name));
  });
  it("preserves the legacy certificate configuration default", () => {
    expect(loadConfig({
      ...environment,
      OBO_KEY_ID: "https://mcp-test.vault.azure.net/keys/obo-key/abc123",
      OBO_CERTIFICATE_THUMBPRINT: "a".repeat(40),
    })).toMatchObject({ oboAuthMode: "certificate" });
  });
  it.each([undefined, "unsupported"])("does not silently default to federation: %s", (mode) => {
    expect(() => loadConfig({ ...environment, OBO_AUTH_MODE: mode, AZURE_CLIENT_ID: clientId }))
      .toThrow(/Invalid server configuration/);
  });
  it("does not leak invalid environment values in errors", () => {
    expect(() => loadConfig({ MCP_API_CLIENT_ID: "secret-value" }))
      .toThrow(/Invalid server configuration/);
    try {
      loadConfig({ MCP_API_CLIENT_ID: "secret-value" });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
    }
  });
});
