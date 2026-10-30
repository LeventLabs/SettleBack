import { McpOutcomeUnknownError, McpRemoteError, McpUnavailableError, type McpHttpClient, type McpTool, type McpToolResult } from "../mcp/http-client.ts";
import { RailRejectedError, RailTimeoutError, RailUnavailableError } from "../rail.ts";
import type { CartContents } from "./cart-mandate.ts";

// The tools of HSP Agentic Payment (QA), from the HSP Agentic Payment setup guide. HSP holds the
// merchant credentials and signs the cart; the payer signs the EIP-712 authorization HSP prepares,
// and the gateway broadcasts the transfer.

export const HSP_AGENTIC_TOOLS = [
  "get_chain_config",
  "create_order",
  "get_order",
  "prepare_payment",
  "finalize_payment",
  "estimate_fee",
  "submit_payment",
  "query_payment",
] as const;

export type HspAgenticTool = (typeof HSP_AGENTIC_TOOLS)[number];

// A lost answer from these changes nothing on the server, so it is only unavailability.
const READ_ONLY: ReadonlySet<HspAgenticTool> = new Set(["get_chain_config", "get_order", "estimate_fee", "query_payment"]);

/** A tool ran and reported an error. `code` is the gateway's error code when the tool returned one. */
export class HspToolError extends RailRejectedError {
  readonly tool: HspAgenticTool;

  constructor(tool: HspAgenticTool, code: string, message: string) {
    super(code, `${tool}: ${message}`);
    this.name = "HspToolError";
    this.tool = tool;
  }
}

/** The live tool list or a tool's input schema differs from what this client was written for. */
export class HspSchemaError extends RailRejectedError {
  constructor(message: string) {
    super("HSP_SCHEMA_MISMATCH", message);
    this.name = "HspSchemaError";
  }
}

/** Gateway code 30043, or an expired quote: prepare again and sign the new authorization; never resubmit the old one. */
export function isQuoteExpired(error: unknown): boolean {
  return error instanceof HspToolError && (error.code === "30043" || /\b30043\b/.test(error.message));
}

export interface HspOrder {
  flowId: string;
  paymentRequestId: string;
  paymentUrl: string | null;
}

interface Argument {
  /** Accepted parameter names; the live schema must name exactly one of them. */
  names: readonly string[];
  value: unknown;
}

/**
 * Calls the HSP Agentic Payment tools. Parameter names and types are read from the live input
 * schemas, among the names the guide documents, and a schema that requires anything else is
 * refused rather than guessed. Results are returned as parsed JSON for the caller to check; nothing
 * here decides that a payment happened.
 */
export class HspAgenticClient {
  private readonly mcp: McpHttpClient;
  private tools: Map<string, McpTool> | undefined;

  constructor(mcp: McpHttpClient) {
    this.mcp = mcp;
  }

  /** Lists the server's tools and checks that all eight are present. */
  async verifyTools(): Promise<McpTool[]> {
    let listed: McpTool[];
    try {
      listed = await this.mcp.listTools();
    } catch (error) {
      throw mapError("get_chain_config", error, "tools/list");
    }
    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    const missing = HSP_AGENTIC_TOOLS.filter((name) => !byName.has(name));
    if (missing.length > 0) throw new HspSchemaError(`HSP Agentic Payment is missing tools: ${missing.join(", ")}.`);
    this.tools = byName;
    return HSP_AGENTIC_TOOLS.map((name) => byName.get(name) as McpTool);
  }

  async chainConfig(): Promise<unknown> {
    return this.call("get_chain_config", []);
  }

  async createOrder(input: { merchantName: string; payTo: string; contents: CartContents }): Promise<HspOrder> {
    return this.call(
      "create_order",
      [
        { names: ["merchant_name"], value: input.merchantName },
        { names: ["pay_to"], value: input.payTo },
        // The cart without merchant_authorization: HSP signs it for the team.
        { names: ["cart_mandate"], value: { contents: input.contents } },
      ],
      (payload) => {
        const order = nested(record(payload, "create_order result"), "flow_id");
        return {
          flowId: text(order.flow_id, "create_order flow_id"),
          paymentRequestId: text(order.payment_request_id, "create_order payment_request_id"),
          paymentUrl: typeof order.payment_url === "string" && order.payment_url !== "" ? order.payment_url : null,
        };
      },
    );
  }

  async getOrder(flowId: string): Promise<unknown> {
    return this.call("get_order", [{ names: ["flow_id"], value: flowId }]);
  }

  async preparePayment(input: { flowId: string; payer: string; protocol: "eip3009" }): Promise<unknown> {
    return this.call("prepare_payment", [
      { names: ["flow_id"], value: input.flowId },
      { names: ["payer", "payer_address", "from"], value: input.payer },
      { names: ["protocol", "payment_protocol"], value: input.protocol },
    ]);
  }

  /** Returns `payment_mandate_json` exactly as received, for `submitPayment`. */
  async finalizePayment(input: { signature: string; paymentPayload: unknown; paymentMandateContents: unknown; cartHash: string }): Promise<unknown> {
    return this.call(
      "finalize_payment",
      [
        { names: ["signature"], value: input.signature },
        { names: ["payment_payload"], value: input.paymentPayload },
        { names: ["payment_mandate_contents"], value: input.paymentMandateContents },
        { names: ["cart_hash"], value: input.cartHash },
      ],
      (payload) => {
        const mandate = nested(record(payload, "finalize_payment result"), "payment_mandate_json").payment_mandate_json;
        if (mandate === undefined || mandate === null || mandate === "") throw new McpOutcomeUnknownError("finalize_payment returned no payment_mandate_json");
        return mandate;
      },
    );
  }

  async submitPayment(paymentMandateJson: unknown): Promise<unknown> {
    return this.call("submit_payment", [{ names: ["payment_mandate_json"], value: paymentMandateJson }]);
  }

  async queryPayment(input: { paymentRequestId: string; merchantName: string }): Promise<unknown> {
    return this.call("query_payment", [
      { names: ["payment_request_id"], value: input.paymentRequestId },
      { names: ["expected_merchant_name"], value: input.merchantName },
    ]);
  }

  /** A result that cannot be read leaves a write's outcome unknown, like a lost one. */
  private async call<T = unknown>(tool: HspAgenticTool, args: readonly Argument[], parse: (payload: unknown) => T = (payload) => payload as T): Promise<T> {
    const shaped = shapeArguments(tool, await this.schemaOf(tool), args);
    try {
      return parse(payloadOf(tool, await this.mcp.callTool(tool, shaped)));
    } catch (error) {
      throw mapError(tool, error);
    }
  }

  private async schemaOf(tool: HspAgenticTool): Promise<Record<string, unknown>> {
    if (this.tools === undefined) await this.verifyTools();
    const found = this.tools?.get(tool);
    if (found === undefined) throw new HspSchemaError(`HSP Agentic Payment has no ${tool} tool.`);
    return found.inputSchema;
  }
}

/**
 * Names each argument as the live schema does and gives it the schema's type: an object passed
 * where the schema wants a string is sent as its JSON text, unchanged in content.
 */
export function shapeArguments(tool: string, schema: Record<string, unknown>, args: readonly Argument[]): Record<string, unknown> {
  const properties = typeof schema.properties === "object" && schema.properties !== null ? (schema.properties as Record<string, { type?: unknown }>) : {};
  const shaped: Record<string, unknown> = {};
  for (const arg of args) {
    const present = arg.names.filter((name) => Object.hasOwn(properties, name));
    if (present.length === 0) throw new HspSchemaError(`${tool} has no parameter named ${arg.names.join(" or ")}.`);
    if (present.length > 1) throw new HspSchemaError(`${tool} has several parameters that could mean the same input: ${present.join(", ")}.`);
    const name = present[0] as string;
    const type = properties[name]?.type;
    shaped[name] = type === "string" && typeof arg.value !== "string" ? JSON.stringify(arg.value) : arg.value;
  }
  const required = Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : [];
  const missing = required.filter((name) => !Object.hasOwn(shaped, name));
  if (missing.length > 0) throw new HspSchemaError(`${tool} requires ${missing.join(", ")}, which this client does not supply.`);
  return shaped;
}

/** The JSON a tool returned: its structured content, or its single text block parsed as JSON. */
export function payloadOf(tool: HspAgenticTool, result: McpToolResult): unknown {
  const texts = result.content.flatMap((block) =>
    typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string" ? [(block as { text: string }).text] : [],
  );
  if (result.isError) {
    const message = texts.join("\n").trim() || "the tool reported an error without a message";
    throw new HspToolError(tool, errorCode(message, result.structuredContent), message);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (texts.length !== 1) throw new McpOutcomeUnknownError(`${tool} returned ${texts.length} text blocks and no structured content`);
  try {
    return JSON.parse(texts[0] as string);
  } catch {
    throw new McpOutcomeUnknownError(`${tool} returned text that is not JSON`);
  }
}

function errorCode(message: string, structured: Record<string, unknown> | undefined): string {
  const fromObject = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null) return undefined;
    const code = (value as { code?: unknown; error_code?: unknown }).code ?? (value as { error_code?: unknown }).error_code;
    return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
  };
  const structuredCode = fromObject(structured);
  if (structuredCode !== undefined) return structuredCode;
  try {
    return fromObject(JSON.parse(message)) ?? "HSP_TOOL_ERROR";
  } catch {
    return "HSP_TOOL_ERROR";
  }
}

function mapError(tool: HspAgenticTool, error: unknown, label: string = tool): Error {
  if (error instanceof McpUnavailableError) return new RailUnavailableError(`HSP ${label} (${error.message})`);
  if (error instanceof McpOutcomeUnknownError) return READ_ONLY.has(tool) ? new RailUnavailableError(`HSP ${label} (${error.message})`) : new RailTimeoutError(`HSP ${label} (${error.message})`);
  if (error instanceof McpRemoteError) return new RailRejectedError(`MCP_${error.code}`, error.message);
  return error instanceof Error ? error : new Error(String(error));
}

/** The object holding `key`: the result itself, or one object nested directly inside it. */
export function nested(result: Record<string, unknown>, key: string): Record<string, unknown> {
  if (Object.hasOwn(result, key)) return result;
  const holders = Object.values(result).filter((value): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, key));
  if (holders.length === 1) return holders[0] as Record<string, unknown>;
  throw new McpOutcomeUnknownError(`the result has no single "${key}" (top-level keys: ${Object.keys(result).join(", ") || "none"})`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new McpOutcomeUnknownError(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new McpOutcomeUnknownError(`${label} is missing`);
  return value;
}
