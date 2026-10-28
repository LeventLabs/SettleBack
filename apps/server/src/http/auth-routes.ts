import type { FastifyInstance } from "fastify";
import type { Session, SessionAuthority } from "../auth/sessions.ts";
import type { RequestGuard } from "./guard.ts";

const ADDRESS_PATTERN = "^0x[0-9a-fA-F]{40}$";

export function registerAuthRoutes(app: FastifyInstance, authority: SessionAuthority, guard: RequestGuard): void {
  app.post(
    "/api/auth/challenge",
    {
      bodyLimit: 1024,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["address", "chainId"],
          properties: { address: { type: "string", pattern: ADDRESS_PATTERN }, chainId: { type: "integer", minimum: 1, maximum: 4294967295 } },
        },
      },
    },
    async (request) => authority.issue(request.body as { address: string; chainId: number }),
  );

  app.post(
    "/api/auth/verify",
    {
      bodyLimit: 4096,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["challenge", "signature"],
          properties: { challenge: { type: "string", maxLength: 1024 }, signature: { type: "string", pattern: "^0x[0-9a-fA-F]{130}$" } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { challenge: string; signature: string };
      const { token, session } = await authority.verify({ ...body, replacing: guard.token(request) });
      guard.setSession(reply, token);
      return sessionView(session);
    },
  );

  app.get("/api/auth/session", async (request) => sessionView(guard.session(request, { wallet: false })));

  // Always clears the cookie, so a browser can sign out even when its session has already ended.
  app.post("/api/auth/logout", async (request, reply) => {
    const token = guard.token(request);
    if (token !== undefined) authority.revoke(token, "LOGOUT");
    guard.clearSession(reply);
    return reply.code(204).send();
  });
}

function sessionView(session: Session): { address: string; chainId: number; roles: readonly string[]; expiresAt: string } {
  return { address: session.address, chainId: session.chainId, roles: session.roles, expiresAt: session.expiresAt };
}
