import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { Config } from "../config.js";
import { ServiceError } from "../errors.js";

export interface Actor {
  tenantId: string;
  objectId: string;
  clientId: string;
  scopes: ReadonlySet<string>;
  assertion: string;
}

export type Authenticate = (authorization: string | undefined) => Promise<Actor>;

export function createAuthenticator(
  config: Config,
  keys: JWTVerifyGetKey = createRemoteJWKSet(
    new URL(`https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`),
  ),
): Authenticate {
  return async (authorization) => {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
    const token = match?.[1];
    if (!token) {
      throw new ServiceError("unauthorized", "A delegated MCP access token is required.", 401);
    }
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
        audience: config.apiClientId,
        algorithms: ["RS256"],
        requiredClaims: ["exp", "iat", "nbf", "oid", "tid", "azp", "scp"],
      }));
    } catch {
      throw new ServiceError("invalid_token", "The MCP access token is invalid or expired.", 401);
    }
    if (
      payload.ver !== "2.0" ||
      payload.tid !== config.tenantId ||
      typeof payload.oid !== "string" ||
      typeof payload.azp !== "string" ||
      typeof payload.scp !== "string" ||
      payload.idtyp === "app"
    ) {
      throw new ServiceError("invalid_token", "A delegated user access token is required.", 401);
    }
    if (!config.allowedClientIds.includes(payload.azp)) {
      throw new ServiceError("client_not_allowed", "This OAuth client is not authorized.", 403);
    }
    const scopes = new Set(payload.scp.split(" ").filter(Boolean));
    if (!scopes.has("Mcp.Read")) {
      throw new ServiceError("insufficient_scope", "Mcp.Read delegated access is required.", 403);
    }
    return {
      tenantId: payload.tid,
      objectId: payload.oid,
      clientId: payload.azp,
      scopes,
      assertion: token,
    };
  };
}
