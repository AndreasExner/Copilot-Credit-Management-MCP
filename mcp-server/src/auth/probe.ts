import { AuthError } from "@azure/msal-node";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { loadConfig } from "../config.js";
import { safeError } from "../errors.js";
import { createClientAssertionProvider } from "./client-assertion.js";
import { createConfidentialApplication } from "./graph-obo.js";

// Deployment-only credential proof against this MCP API, never Graph or a user read.
const signal = AbortSignal.timeout(25000);
try {
  const config = loadConfig();
  if (config.oboAuthMode !== "managed-identity") {
    throw new Error("This probe requires managed-identity federation.");
  }
  const application = createConfidentialApplication(
    config, signal, createClientAssertionProvider(config),
  );
  const result = await application.acquireTokenByClientCredential({
    scopes: [`api://${config.apiClientId}/.default`],
    skipCache: true,
  });
  signal.throwIfAborted();
  if (!result?.accessToken) throw new Error("No application token was returned.");
  const keys = createRemoteJWKSet(new URL(
    `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`,
  ), { timeoutDuration: 5000 });
  const { payload } = await jwtVerify(result.accessToken, keys, {
    issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
    audience: config.apiClientId,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "nbf", "tid", "azp"],
  });
  if (payload.tid !== config.tenantId || payload.azp !== config.apiClientId ||
      payload.scp !== undefined) {
    throw new Error("The credential probe returned unexpected application claims.");
  }
  const response = await fetch(config.publicUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${result.accessToken}` },
    signal,
    redirect: "error",
  });
  await response.body?.cancel();
  if (response.status !== 401 && response.status !== 403) {
    throw new Error("The MCP endpoint did not reject the application-only probe token.");
  }
  console.log(JSON.stringify({
    event: "federated_application_credential_verified",
    appOnlyMcpRejectionStatus: response.status,
    delegatedGraphVerified: false,
  }));
} catch (error) {
  const code = error instanceof AuthError && /^[a-z0-9_]+$/i.test(error.errorCode)
    ? error.errorCode : safeError(error).code;
  console.error(JSON.stringify({ event: "federated_credential_probe_failed", code }));
  process.exitCode = 1;
}
