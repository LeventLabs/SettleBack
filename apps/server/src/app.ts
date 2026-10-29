import type { DatabaseSync } from "node:sqlite";
import { fastify, type FastifyInstance } from "fastify";
import { describeNetwork, type PolicyTerms } from "@settleback/domain";
import type { RegistryGateway } from "@settleback/adapters";
import { SessionAuthority } from "./auth/sessions.ts";
import type { ServerConfig } from "./config.ts";
import { registerAuthRoutes } from "./http/auth-routes.ts";
import { registerCaseRoutes } from "./http/case-routes.ts";
import { registerPurchaseRoutes } from "./http/purchase-routes.ts";
import type { DemoPurchases } from "./demo/purchases.ts";
import { handleError } from "./http/errors.ts";
import { RequestGuard } from "./http/guard.ts";
import type { AssessmentProvider } from "./recovery/provider.ts";
import type { RepaymentPayments } from "./recovery/repayment.ts";
import type { ResultLookup } from "./recovery/retrieval.ts";

export interface AppDependencies {
  db: DatabaseSync;
  registry?: RegistryGateway | undefined;
  /** Service terms by policy ID; a case under a policy without terms cannot be assessed or prepared. */
  terms?: ReadonlyMap<string, PolicyTerms> | undefined;
  /** The job service and artifact store; without them nothing is assessed against them or delivered. */
  lookup?: ResultLookup | undefined;
  provider?: AssessmentProvider | undefined;
  /** The rail and signer repayments are paid with; used only when payment writes are enabled. */
  payments?: RepaymentPayments | undefined;
  /** Jobs bought through the workspace in the local demo; used only when payment writes are enabled. */
  purchases?: DemoPurchases | undefined;
  clock?: () => Date;
  /** Authenticates sign-in challenges; a fresh random key per process unless given. */
  signInKey?: Buffer;
}

export function buildApp(config: ServerConfig, dependencies: AppDependencies): FastifyInstance {
  const app = fastify({
    logger: { level: config.logLevel },
    // No implicit HEAD twins: the result route releases a reserved retrieval and must run only as the GET it is.
    exposeHeadRoutes: false,
    // Fastify's defaults drop unknown properties and coerce types; a request must match its schema as sent.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  // Only JSON bodies: a cross-site form can send text/plain without a preflight.
  app.removeContentTypeParser("text/plain");

  const network = describeNetwork(config.environment, config.simulatedProfile);
  const clock = dependencies.clock ?? (() => new Date());
  const chains = [...new Set([network.paymentChainId, network.registryChainId, ...(config.registry === undefined ? [] : [config.registry.chainId])])];
  const authority = new SessionAuthority(
    dependencies.db,
    { environment: config.environment, webOrigin: config.auth.webOrigin, chains, operators: config.auth.operators, networkLabel: network.label },
    clock,
    dependencies.signInKey,
  );
  const guard = new RequestGuard(authority, config.auth.webOrigin);

  app.addHook("onRequest", async (request) => guard.checkOrigin(request));

  // Every response, including errors, states whether it comes from a simulation and which network profile.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-settleback-mode", network.mode);
    reply.header("x-settleback-network", network.profile);
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.setErrorHandler(handleError);
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "No such route." } }));

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

  registerAuthRoutes(app, authority, guard);
  registerCaseRoutes(app, {
    db: dependencies.db,
    guard,
    clock,
    registry: dependencies.registry,
    terms: dependencies.terms ?? new Map(),
    lookup: dependencies.lookup,
    provider: dependencies.provider,
    assessmentTimeoutMs: config.assessment.timeoutMs,
    // Payment writes stay off unless the configuration enables them, whatever rail is connected.
    payments: config.paymentWritesEnabled ? dependencies.payments : undefined,
  });
  if (config.paymentWritesEnabled && dependencies.purchases !== undefined) {
    registerPurchaseRoutes(app, { db: dependencies.db, guard, clock, purchases: dependencies.purchases });
  }

  return app;
}
