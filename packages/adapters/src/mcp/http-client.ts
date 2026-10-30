// A client for MCP servers over the Streamable HTTP transport, as the specification
// (revision 2025-11-25) describes it: each JSON-RPC message is one POST, the server answers a
// request with either one JSON object or an SSE stream, and a session ID assigned at
// initialization is sent with every later request. Only what a tool-calling client needs is
// implemented: no resumable streams and no server-initiated features beyond answering ping.

/** Protocol revisions this client can speak, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** The request was not delivered or was refused before processing; nothing happened on the server. */
export class McpUnavailableError extends Error {
  readonly httpStatus: number | null;

  constructor(message: string, httpStatus: number | null = null) {
    super(message);
    this.name = "McpUnavailableError";
    this.httpStatus = httpStatus;
  }
}

/** The request may have been processed; the answer was lost or unreadable. */
export class McpOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpOutcomeUnknownError";
  }
}

/** The server processed the request and refused it with a JSON-RPC error. */
export class McpRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = "McpRemoteError";
    this.code = code;
    this.data = data;
  }
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: unknown[];
  structuredContent: Record<string, unknown> | undefined;
  isError: boolean;
}

export interface McpHttpClientOptions {
  url: string;
  clientInfo: { name: string; version: string };
  /** Bound on each HTTP exchange, including reading a streamed response. */
  timeoutMs: number;
  /** Extra headers on every request, for example a relay's access token. Never logged. */
  headers?: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
}

interface Session {
  id: string | undefined;
  version: string;
}

type JsonRpcMessage = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };

// Connection failures in which no byte of the request reached the server.
const NOT_DELIVERED = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export class McpHttpClient {
  private readonly options: McpHttpClientOptions;
  private readonly fetch: typeof fetch;
  private session: Session | undefined;
  private connecting: Promise<Session> | undefined;
  private nextId = 1;

  constructor(options: McpHttpClientOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error(`An MCP endpoint must use HTTPS (plain HTTP only on loopback), got "${url.origin}".`);
    }
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /** The protocol revision the server agreed to, once connected. */
  get protocolVersion(): string | undefined {
    return this.session?.version;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    // A server that keeps returning cursors is not trusted to end the list on its own.
    for (let page = 0; page < 20; page++) {
      const result = record(await this.request("tools/list", cursor === undefined ? {} : { cursor }), "tools/list result");
      if (!Array.isArray(result.tools)) throw new McpOutcomeUnknownError("tools/list returned no tools array");
      for (const entry of result.tools) {
        const tool = record(entry, "tool");
        if (typeof tool.name !== "string") throw new McpOutcomeUnknownError("tools/list returned a tool without a name");
        tools.push({
          name: tool.name,
          description: typeof tool.description === "string" ? tool.description : "",
          inputSchema: tool.inputSchema === undefined ? {} : record(tool.inputSchema, `${tool.name}.inputSchema`),
        });
      }
      if (typeof result.nextCursor !== "string" || result.nextCursor === "") return tools;
      cursor = result.nextCursor;
    }
    throw new McpOutcomeUnknownError("tools/list did not end after 20 pages");
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = record(await this.request("tools/call", { name, arguments: args }), `${name} result`);
    if (!Array.isArray(result.content)) throw new McpOutcomeUnknownError(`${name} returned no content array`);
    const structured = result.structuredContent;
    return {
      content: result.content,
      structuredContent: typeof structured === "object" && structured !== null && !Array.isArray(structured) ? (structured as Record<string, unknown>) : undefined,
      isError: result.isError === true,
    };
  }

  /**
   * Sends one request in the current session. A 404 for a session ID means the server ended the
   * session without processing the request, so a new session is started and the request is sent
   * once more; any other failure is reported as it is.
   */
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const session = await this.connect();
    try {
      return await this.exchange(method, params, session);
    } catch (error) {
      if (!(error instanceof SessionExpiredError)) throw error;
      if (this.session === session) this.session = undefined;
      return this.exchange(method, params, await this.connect());
    }
  }

  private async connect(): Promise<Session> {
    if (this.session !== undefined) return this.session;
    this.connecting ??= this.initialize().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async initialize(): Promise<Session> {
    const pending: Session = { id: undefined, version: MCP_PROTOCOL_VERSIONS[0] };
    const result = record(
      await this.exchange("initialize", { protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: this.options.clientInfo }, pending, (id) => {
        pending.id = id;
      }),
      "initialize result",
    );
    const version = result.protocolVersion;
    if (typeof version !== "string" || !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
      throw new McpUnavailableError(`The MCP server wants protocol version ${String(version)}, which this client does not support.`);
    }
    const session: Session = { id: pending.id, version };
    const response = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);
    await response.body?.cancel();
    if (response.status !== 202 && response.status !== 200) throw new McpUnavailableError(`The MCP server refused the initialized notification (HTTP ${response.status}).`, response.status);
    this.session = session;
    return session;
  }

  private async exchange(method: string, params: Record<string, unknown>, session: Session, onSessionId?: (id: string) => void): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: "2.0", id, method, params }, method === "initialize" ? { ...session, id: undefined } : session);
    if (response.status === 404 && session.id !== undefined && method !== "initialize") {
      await response.body?.cancel();
      throw new SessionExpiredError();
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const status = response.status;
      const detail = jsonRpcErrorIn(body);
      // 5xx may come from a proxy after the server acted, so a write's outcome is unknown.
      if (status >= 500) throw new McpOutcomeUnknownError(`${method}: HTTP ${status}${detail === undefined ? "" : ` (${detail})`}`);
      if (status === 401 || status === 403) throw new McpUnavailableError(`${method}: HTTP ${status}; this client's address or credentials are not allowed${detail === undefined ? "" : ` (${detail})`}`, status);
      throw new McpUnavailableError(`${method}: HTTP ${status}${detail === undefined ? "" : ` (${detail})`}`, status);
    }
    const sessionId = response.headers.get("mcp-session-id");
    if (method === "initialize" && sessionId !== null) {
      if (!/^[\x21-\x7e]+$/.test(sessionId)) throw new McpUnavailableError("The MCP server assigned a session ID with characters outside visible ASCII.");
      onSessionId?.(sessionId);
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    const message =
      type === "text/event-stream" ? await this.fromStream(response, id, session) : type === "application/json" ? parseMessage(await this.readText(response, method)) : undefined;
    if (message === undefined) throw new McpOutcomeUnknownError(`${method}: unexpected response type "${type ?? ""}"`);
    if (message.id !== id) throw new McpOutcomeUnknownError(`${method}: the response answers a different request`);
    if (message.error !== undefined) throw new McpRemoteError(message.error.code, `${method}: ${message.error.message}`, message.error.data);
    if (!("result" in message)) throw new McpOutcomeUnknownError(`${method}: the response has neither a result nor an error`);
    return message.result;
  }

  private async post(message: JsonRpcMessage, session: Session): Promise<Response> {
    const headers: Record<string, string> = {
      ...this.options.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (message.method !== "initialize") headers["mcp-protocol-version"] = session.version;
    if (session.id !== undefined) headers["mcp-session-id"] = session.id;
    try {
      return await this.fetch(this.options.url, { method: "POST", headers, body: JSON.stringify(message), signal: AbortSignal.timeout(this.options.timeoutMs) });
    } catch (error) {
      const method = message.method ?? "response";
      if (notDelivered(error)) throw new McpUnavailableError(`${method}: the MCP server could not be reached (${describe(error)})`);
      throw new McpOutcomeUnknownError(`${method}: the connection failed after the request may have been sent (${describe(error)})`);
    }
  }

  private async readText(response: Response, method: string): Promise<string> {
    try {
      return await response.text();
    } catch (error) {
      throw new McpOutcomeUnknownError(`${method}: the response was cut off (${describe(error)})`);
    }
  }

  /**
   * Reads SSE events until the response to `id` arrives. A ping from the server is answered; other
   * server requests are declined, and notifications are ignored. A stream that ends first, or
   * stops within the timeout, leaves the outcome unknown.
   */
  private async fromStream(response: Response, id: number, session: Session): Promise<JsonRpcMessage> {
    const body = response.body;
    if (body === null) throw new McpOutcomeUnknownError("the event stream has no body");
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let data: string[] = [];
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw new McpOutcomeUnknownError(`the event stream failed before the response (${describe(error)})`);
        }
        if (chunk.done) throw new McpOutcomeUnknownError("the event stream ended before the response");
        buffer += chunk.value;
        let newline: number;
        while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + (buffer.startsWith("\r\n", newline) ? 2 : 1));
          if (line !== "") {
            if (line.startsWith("data:")) data.push(line.slice(line.startsWith("data: ") ? 6 : 5));
            continue;
          }
          const payload = data.join("\n");
          data = [];
          if (payload === "") continue;
          const message = parseMessage(payload);
          if (message.method !== undefined) {
            if (message.id !== undefined && message.id !== null) await this.answer(message, session);
            continue;
          }
          if (message.id === id) return message;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }

  private async answer(request: JsonRpcMessage, session: Session): Promise<void> {
    const reply: JsonRpcMessage =
      request.method === "ping"
        ? { jsonrpc: "2.0", id: request.id ?? null, result: {} }
        : { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32601, message: `${String(request.method)} is not supported by this client` } };
    const response = await this.post(reply, session).catch(() => undefined);
    await response?.body?.cancel();
  }
}

class SessionExpiredError extends Error {
  constructor() {
    super("the MCP session has ended");
    this.name = "SessionExpiredError";
  }
}

function parseMessage(text: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpOutcomeUnknownError("the response is not JSON");
  }
  const message = record(parsed, "JSON-RPC message");
  if (message.jsonrpc !== "2.0") throw new McpOutcomeUnknownError("the response is not JSON-RPC 2.0");
  if (message.error !== undefined) {
    const error = record(message.error, "JSON-RPC error");
    if (typeof error.code !== "number" || typeof error.message !== "string") throw new McpOutcomeUnknownError("the JSON-RPC error is malformed");
  }
  return message as JsonRpcMessage;
}

function jsonRpcErrorIn(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    return typeof parsed.error?.message === "string" ? `${String(parsed.error.code)}: ${parsed.error.message}` : undefined;
  } catch {
    return undefined;
  }
}

function notDelivered(error: unknown): boolean {
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return typeof cause?.code === "string" && NOT_DELIVERED.has(cause.code);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new McpOutcomeUnknownError(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause as { code?: unknown } | undefined;
  return typeof cause?.code === "string" ? `${error.name}: ${cause.code}` : `${error.name}: ${error.message}`;
}
