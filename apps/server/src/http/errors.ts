import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { BaseError } from "viem";
import {
  RailRejectedError,
  RailTimeoutError,
  RailUnavailableError,
  RegistryConfigurationError,
  RegistryOutcomeUnknownError,
  RegistryRevertError,
} from "@settleback/adapters";
import { StoreError } from "../db/errors.ts";

/** HTTP status for each stable error code a route may return. A code missing here is an internal error. */
const STATUS: Readonly<Record<string, number>> = {
  INVALID_REQUEST: 400,
  CHAIN_NOT_ALLOWED: 400,
  WALLET_REQUIRED: 400,
  AUTH_REQUIRED: 401,
  CHALLENGE_INVALID: 401,
  CHALLENGE_EXPIRED: 401,
  CHALLENGE_USED: 401,
  SIGNATURE_INVALID: 401,
  WALLET_CHANGED: 401,
  CROSS_ORIGIN_FORBIDDEN: 403,
  ROLE_FORBIDDEN: 403,
  NOT_FOUND: 404,
  OPERATION_NOT_FOUND: 404,
  CASE_NOT_FOUND: 404,
  ACTION_NOT_FOUND: 404,
  ATTEMPT_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  CASE_NOT_READY: 409,
  ASSESSMENT_IN_PROGRESS: 409,
  ACTION_EXISTS: 409,
  NOT_ELIGIBLE: 409,
  ORIGINAL_REFERENCE_MISSING: 409,
  REVISION_CONFLICT: 409,
  REGISTRY_TERMS_MISMATCH: 409,
  REGISTRY_OUTCOME_MISMATCH: 409,
  WRONG_ACTION_STATE: 409,
  NOT_EXECUTABLE: 409,
  ARTIFACT_MISMATCH: 409,
  ACK_DIGEST_MISMATCH: 409,
  CART_REJECTED: 409,
  MANDATE_SIGNATURE_INVALID: 409,
  CART_MISMATCH: 409,
  PERMIT_CONSUMED: 409,
  ATTEMPT_NOT_EXECUTABLE: 409,
  ATTEMPT_NOT_QUOTABLE: 409,
  PROOF_ALREADY_ALLOCATED: 409,
  REGISTRY_REQUIRED: 503,
  WRONG_REGISTRY: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  MANDATE_FORMAT_UNAVAILABLE: 503,
  // Stored records that fail their own digests: refused loudly, never served.
  ACTION_INTEGRITY: 500,
  EVIDENCE_INTEGRITY: 500,
};

export interface ErrorBody {
  error: { code: string; message: string };
}

/**
 * Coded errors keep their code and message. Registry and chain failures become stable codes
 * without transport details, which can include an RPC URL. Request errors found by the framework
 * are reported as such; anything else is logged and returned as INTERNAL_ERROR without details.
 */
export function handleError(error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply): ErrorBody {
  if (error instanceof StoreError) {
    const status = STATUS[error.code];
    if (status !== undefined) {
      if (status >= 500) request.log.error(error, "request refused");
      reply.code(status);
      return { error: { code: error.code, message: error.message } };
    }
  }
  if (error instanceof RegistryRevertError) {
    reply.code(409);
    return { error: { code: "REGISTRY_REFUSED", message: `The registry refused the transaction (${error.reason}).` } };
  }
  if (error instanceof RegistryOutcomeUnknownError) {
    request.log.warn(error, "registry outcome unknown");
    reply.code(503);
    return { error: { code: "REGISTRY_OUTCOME_UNKNOWN", message: `Registry transaction ${error.txHash} was sent but not yet confirmed; retry to read its outcome.` } };
  }
  if (error instanceof RailRejectedError) {
    reply.code(409);
    return { error: { code: "PAYMENT_REJECTED", message: `The payment gateway refused the request (${error.code}).` } };
  }
  if (error instanceof RailUnavailableError || error instanceof RailTimeoutError) {
    request.log.warn(error, "payment gateway unavailable");
    reply.code(503);
    return { error: { code: "DEPENDENCY_UNAVAILABLE", message: "The payment gateway could not be reached; retry the request." } };
  }
  if (error instanceof RegistryConfigurationError || error instanceof BaseError) {
    request.log.error(error, "registry unavailable");
    reply.code(503);
    return { error: { code: "DEPENDENCY_UNAVAILABLE", message: "The registry could not be reached; retry the request." } };
  }
  const frameworkError = error as FastifyError;
  if (frameworkError.validation !== undefined) {
    reply.code(400);
    return { error: { code: "INVALID_REQUEST", message: error.message } };
  }
  const status = frameworkError.statusCode;
  if (status !== undefined && status >= 400 && status < 500) {
    reply.code(status);
    const code = status === 413 ? "PAYLOAD_TOO_LARGE" : status === 415 ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_REQUEST";
    return { error: { code, message: error.message } };
  }
  request.log.error(error, "request failed");
  reply.code(500);
  return { error: { code: "INTERNAL_ERROR", message: "The request failed; it has been logged." } };
}
