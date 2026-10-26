import { fastify, type FastifyInstance } from "fastify";
import { networkLabel } from "@settleback/domain";
import type { ServerConfig } from "./config.ts";

export function buildApp(config: ServerConfig): FastifyInstance {
  const app = fastify({ logger: { level: config.logLevel } });

  app.get("/api/health", async () => ({
    service: "settleback",
    environment: config.environment,
    networkLabel: networkLabel(config.environment),
    paymentWrites: config.paymentWritesEnabled ? "enabled" : "disabled",
  }));

  return app;
}
