/**
 * TUI Ctrl-C test - directly invoke serveFlow and send SIGINT
 */
import { startProxyServer } from "../src/server.ts";
import { loadConfig } from "../src/config/config.ts";
import type { AppConfig } from "../src/types.ts";

const config: AppConfig = loadConfig() ?? {
  bind: "127.0.0.1", port: 8771, logLevel: "silent",
  providers: [{ id: "test", type: "openai", baseUrl: "http://localhost:9999", apiKey: "k" }],
  models: [{ name: "gpt-5", provider: "test", modelId: "gpt-5" }],
};

const server = await startProxyServer(config, { port: 8771 });
console.log("listening");

// Block forever with proper signal handling
const { promise, resolve } = Promise.withResolvers<void>();
let stopping = false;
const onSignal = (sig: NodeJS.Signals) => {
  if (stopping) return;
  stopping = true;
  console.log(`\nreceived ${sig}, stopping…`);
  resolve();
};
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
await promise;
console.log("stopped");
await server.stop();
console.log("server stopped");
process.exit(0);
