import { ConfidentialClientApplication } from "@azure/msal-node";
import type { Config } from "../config.js";
import type { Actor } from "./validate-token.js";
import { ServiceError } from "../errors.js";
import { createAuthenticationNetwork } from "./network.js";
import { createClientAssertionProvider, type GetClientAssertion } from "./client-assertion.js";

export type GetGraphToken = (actor: Actor, scopes: string[], signal: AbortSignal) => Promise<string>;

export function createConfidentialApplication(
  config: Config, signal: AbortSignal, clientAssertion: GetClientAssertion,
): ConfidentialClientApplication {
  return new ConfidentialClientApplication({
    auth: {
      clientId: config.apiClientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientAssertion: () => clientAssertion(signal),
    },
    system: {
      networkClient: createAuthenticationNetwork(signal),
      loggerOptions: {
        piiLoggingEnabled: false,
        loggerCallback: () => {},
      },
    },
  });
}

export function createGraphTokenProvider(config: Config): GetGraphToken {
  const clientAssertion = createClientAssertionProvider(config);

  return async (actor, scopes, signal) => {
    if (actor.tenantId !== config.tenantId) {
      throw new ServiceError("tenant_not_allowed", "The caller belongs to another tenant.", 403);
    }
    // Each request has its own MSAL cache; no user can inherit another caller's tokens.
    try {
      signal.throwIfAborted();
      const application = createConfidentialApplication(config, signal, clientAssertion);
      const result = await application.acquireTokenOnBehalfOf({
        oboAssertion: actor.assertion,
        scopes,
        skipCache: true,
      });
      signal.throwIfAborted();
      if (!result?.accessToken) {
        throw new ServiceError("graph_token_unavailable", "No delegated Graph token was returned.", 502);
      }
      return result.accessToken;
    } catch (error) {
      if (signal.aborted) {
        throw new ServiceError("graph_timeout", "Graph authentication exceeded the request time budget.", 504);
      }
      if (error instanceof ServiceError) throw error;
      throw new ServiceError(
        "graph_consent_or_authentication_required",
        "Graph delegated authentication failed. Check consent, role activation and Conditional Access; reconnect if required.",
        403,
      );
    }
  };
}
