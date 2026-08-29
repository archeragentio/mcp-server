import { serve } from "@hono/node-server";
import { generateKeyPair } from "jose";
import { createGateway } from "./app.js";
import { fixtureConfig } from "./config.js";
import { fixtureResellersJson } from "./fixture-constants.js";
import { createProviderFixture } from "./provider/fixture-server.js";

const { privateKey, publicKey } = await generateKeyPair("EdDSA");
const provider = createProviderFixture(publicKey);
const providerServer = serve({ fetch: provider.app.fetch, hostname: "127.0.0.1", port: 3101 });
const config = fixtureConfig({
  NODE_ENV: "development",
  HOST: "127.0.0.1",
  PORT: 3100,
  PUBLIC_ORIGIN: "http://127.0.0.1:3100",
  ARCHER_PROVIDER_BASE_URL: "http://127.0.0.1:3101/api/provider/v1",
  TRUSTED_RESELLERS_JSON: fixtureResellersJson(),
});
const gateway = await createGateway({ config, providerKey: privateKey });
const gatewayServer = serve({ fetch: gateway.app.fetch, hostname: config.HOST, port: config.PORT });
gateway.logger.info({ gateway: config.PUBLIC_ORIGIN, provider: config.ARCHER_PROVIDER_BASE_URL }, "fixture gateway ready");

async function shutdown(signal: string): Promise<void> {
  gateway.logger.info({ signal }, "fixture gateway shutting down");
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      gatewayServer.close((error) => { if (error) reject(error); else resolve(); });
    }),
    new Promise<void>((resolve, reject) => {
      providerServer.close((error) => { if (error) reject(error); else resolve(); });
    }),
  ]);
  await gateway.state.close();
}
process.once("SIGINT", () => { void shutdown("SIGINT"); });
process.once("SIGTERM", () => { void shutdown("SIGTERM"); });
