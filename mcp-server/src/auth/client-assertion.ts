import { createHash, randomUUID } from "node:crypto";
import { CryptographyClient } from "@azure/keyvault-keys";
import { DefaultAzureCredential, ManagedIdentityCredential } from "@azure/identity";
import type { Config } from "../config.js";
import { ServiceError } from "../errors.js";

export const federationScope = "api://AzureADTokenExchange/.default";
export type GetClientAssertion = (signal: AbortSignal) => Promise<string>;

export function createClientAssertionProvider(config: Config): GetClientAssertion {
  if (config.oboAuthMode === "managed-identity") {
    const credential = new ManagedIdentityCredential({ clientId: config.managedIdentityClientId });
    return async (signal) => {
      signal.throwIfAborted();
      const result = await credential.getToken(federationScope, { abortSignal: signal });
      signal.throwIfAborted();
      if (!result?.token) {
        throw new ServiceError(
          "obo_client_assertion_unavailable", "No managed-identity client assertion was returned.", 502,
        );
      }
      return result.token;
    };
  }

  const credential = config.production
    ? new ManagedIdentityCredential(
      config.managedIdentityClientId ? { clientId: config.managedIdentityClientId } : {},
    )
    : new DefaultAzureCredential();
  const crypto = new CryptographyClient(config.signingKeyId, credential);
  const authority = `https://login.microsoftonline.com/${config.tenantId}`;
  return async (signal) => {
    signal.throwIfAborted();
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({
      alg: "RS256",
      typ: "JWT",
      x5t: Buffer.from(config.certificateThumbprint, "hex").toString("base64url"),
    })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      aud: `${authority}/oauth2/v2.0/token`,
      iss: config.apiClientId,
      sub: config.apiClientId,
      jti: randomUUID(),
      nbf: now - 5,
      exp: now + 300,
    })).toString("base64url");
    const message = `${header}.${payload}`;
    const signed = await crypto.sign("RS256", createHash("sha256").update(message).digest(), {
      abortSignal: signal,
    });
    signal.throwIfAborted();
    return `${message}.${Buffer.from(signed.result).toString("base64url")}`;
  };
}
