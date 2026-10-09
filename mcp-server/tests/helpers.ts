import type { Config } from "../src/config.js";
import type { Actor } from "../src/auth/validate-token.js";

export const tenantId = "8052aab8-6989-451f-91b2-faa77f298324";
export const apiId = "58bf0d30-ae9e-47ce-bf3b-2e9f294865f0";
export const clientId = "b351df5e-45b7-455f-9e80-4c8b68bce327";

// These identifiers are used only with generated local keys and mocked network calls.
export const config: Config = {
  port: 8080,
  tenantId,
  apiClientId: apiId,
  allowedClientIds: [clientId],
  publicUrl: "https://mcp.example.test/mcp",
  oboAuthMode: "certificate",
  signingKeyId: "https://mcp-test.vault.azure.net/keys/obo-key/abc123",
  certificateThumbprint: "a".repeat(40),
  production: false,
  graphTimeoutMs: 1000,
  graphMinIntervalMs: 0,
  graphMaxQueue: 10,
};

export const actor: Actor = {
  tenantId,
  objectId: "a729424d-9cab-4662-bd50-42875192474d",
  clientId,
  scopes: new Set(["Mcp.Read"]),
  assertion: "mocked-access-token",
};
