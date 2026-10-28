import { fastify, type FastifyInstance } from "fastify";
import { describeNetwork } from "@settleback/domain";
import type { RegistryGateway } from "@settleback/adapters";
import type { ServerConfig } from "./config.ts";

export interface AppDependencies {
  registry?: RegistryGateway | undefined;
}

export function buildApp(config: ServerConfig, dependencies: AppDependencies = {}): FastifyInstance {
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
    registry:
      dependencies.registry === undefined
        ? { status: "not configured", integratedRepayment: "unavailable" }
        : {
            status: "connected",
            chainId: dependencies.registry.chainId,
            address: dependencies.registry.address,
            provenance: dependencies.registry.provenance,
          },
  }));

  return app;
}
