import { fastify, type FastifyInstance } from "fastify";
import { describeNetwork } from "@settleback/domain";
import type { ServerConfig } from "./config.ts";

export function buildApp(config: ServerConfig): FastifyInstance {
  const app = fastify({ logger: { level: config.logLevel } });
  const network = describeNetwork(config.environment, config.simulatedProfile);

  // Every response, including errors, states whether it comes from a simulation and which network profile.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-settleback-mode", network.mode);
    reply.header("x-settleback-network", network.profile);
    return payload;
  });

  app.get("/api/health", async () => ({
    service: "settleback",
    environment: network.environment,
    mode: network.mode,
    networkProfile: network.profile,
    networkLabel: network.label,
    paymentChainId: network.paymentChainId,
    registryChainId: network.registryChainId,
    paymentWrites: config.paymentWritesEnabled ? "enabled" : "disabled",
  }));

  return app;
}
