import { loadConfig } from "./config.js";
import { createAuthenticator } from "./auth/validate-token.js";
import { createGraphTokenProvider } from "./auth/graph-obo.js";
import { GraphClient } from "./graph/client.js";
import { createReadServer } from "./tools/reads.js";
import { createApp } from "./server.js";

const config = loadConfig();
const graph = new GraphClient(config, createGraphTokenProvider(config));
const log = (record: Record<string, string | number>) => {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...record }));
};
const app = createApp(config, {
  authenticate: createAuthenticator(config),
  createServer: (actor) => createReadServer(actor, graph),
  log,
});
const httpServer = app.listen(config.port, "0.0.0.0", () => {
  log({ event: "server_started", port: config.port });
});
httpServer.requestTimeout = 30000;
httpServer.headersTimeout = 10000;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    log({ event: "server_stopping", signal });
    httpServer.close(() => { process.exit(0); });
    setTimeout(() => {
      log({ event: "shutdown_timeout" });
      httpServer.closeAllConnections();
      process.exit(1);
    }, 25000).unref();
  });
}
