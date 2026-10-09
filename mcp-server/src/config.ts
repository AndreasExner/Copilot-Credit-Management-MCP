import { z } from "zod";

const httpsUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.hash;
}, "An HTTPS URL without credentials or fragment is required.");

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  ENTRA_TENANT_ID: z.string().uuid(),
  MCP_API_CLIENT_ID: z.string().uuid(),
  MCP_ALLOWED_CLIENT_IDS: z.string().min(1),
  MCP_PUBLIC_URL: httpsUrl,
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  GRAPH_TIMEOUT_MS: z.coerce.number().int().min(100).max(25000).default(18000),
  GRAPH_MIN_INTERVAL_MS: z.coerce.number().int().min(0).max(10000).default(1000),
  GRAPH_MAX_QUEUE: z.coerce.number().int().min(1).max(100).default(10),
}).and(z.discriminatedUnion("OBO_AUTH_MODE", [
  z.object({
    OBO_AUTH_MODE: z.literal("certificate"),
    OBO_KEY_ID: httpsUrl.refine((value) => {
      const url = new URL(value);
      return url.hostname.endsWith(".vault.azure.net") &&
        /^\/keys\/[A-Za-z0-9-]+\/[A-Za-z0-9]+$/.test(url.pathname);
    }, "A versioned Azure Key Vault signing key URL is required."),
    OBO_CERTIFICATE_THUMBPRINT: z.string().regex(/^[a-fA-F0-9]{40}$/),
    AZURE_CLIENT_ID: z.string().uuid().optional(),
  }),
  z.object({
    OBO_AUTH_MODE: z.literal("managed-identity"),
    AZURE_CLIENT_ID: z.string().uuid(),
    OBO_KEY_ID: z.undefined(),
    OBO_CERTIFICATE_THUMBPRINT: z.undefined(),
  }),
]));

interface CommonConfig {
  port: number;
  tenantId: string;
  apiClientId: string;
  allowedClientIds: string[];
  publicUrl: string;
  production: boolean;
  graphTimeoutMs: number;
  graphMinIntervalMs: number;
  graphMaxQueue: number;
}

export type Config = CommonConfig & (
  {
    oboAuthMode: "certificate";
    signingKeyId: string;
    certificateThumbprint: string;
    managedIdentityClientId?: string;
  } | {
    oboAuthMode: "managed-identity";
    managedIdentityClientId: string;
  }
);

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const parsed = environmentSchema.safeParse({
    ...environment,
    OBO_AUTH_MODE: environment.OBO_AUTH_MODE ?? "certificate",
  });
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
    throw new Error(`Invalid server configuration: ${fields.join(", ")}`);
  }
  const values = parsed.data;
  const clients = values.MCP_ALLOWED_CLIENT_IDS.split(",").map((item) => item.trim());
  if (!z.array(z.string().uuid()).min(1).safeParse(clients).success) {
    throw new Error("MCP_ALLOWED_CLIENT_IDS must contain comma-separated application IDs.");
  }
  if (new URL(values.MCP_PUBLIC_URL).pathname !== "/mcp") {
    throw new Error("MCP_PUBLIC_URL must point to /mcp.");
  }
  return {
    port: values.PORT,
    tenantId: values.ENTRA_TENANT_ID,
    apiClientId: values.MCP_API_CLIENT_ID,
    allowedClientIds: clients,
    publicUrl: values.MCP_PUBLIC_URL,
    ...(values.OBO_AUTH_MODE === "managed-identity" ? {
      oboAuthMode: values.OBO_AUTH_MODE,
      managedIdentityClientId: values.AZURE_CLIENT_ID,
    } : {
      oboAuthMode: values.OBO_AUTH_MODE,
      signingKeyId: values.OBO_KEY_ID,
      certificateThumbprint: values.OBO_CERTIFICATE_THUMBPRINT,
      ...(values.AZURE_CLIENT_ID ? { managedIdentityClientId: values.AZURE_CLIENT_ID } : {}),
    }),
    production: values.NODE_ENV === "production",
    graphTimeoutMs: values.GRAPH_TIMEOUT_MS,
    graphMinIntervalMs: values.GRAPH_MIN_INTERVAL_MS,
    graphMaxQueue: values.GRAPH_MAX_QUEUE,
  };
}
