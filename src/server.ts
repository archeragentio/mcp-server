import { serve } from "@hono/node-server";
import { createGateway } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const runtime = await createGateway({ config });
const server = serve({ fetch: runtime.app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  runtime.logger.info({ address: info.address, port: info.port }, "Archer Protocol Gateway listening");
});

async function shutdown(signal: string): Promise<void> {
  runtime.logger.info({ signal }, "gateway shutting down");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve(); });
  });
  await runtime.state.close();
}

process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
