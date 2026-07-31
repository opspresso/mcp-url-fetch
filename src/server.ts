/**
 * An MCP server that turns a URL into something a model can use: a picture as
 * bytes, a document as text.
 *
 * It exists because a URL is not its contents. An agent that reads an address
 * out of some other tool — a Slack avatar, a search result, a link in a ticket —
 * cannot do anything with it: the bytes are never in hand, so there is nothing
 * to look at, edit, or read. This closes that gap, and only that gap.
 *
 * The protocol is implemented directly rather than through an SDK. The surface
 * is four methods, and the one dependency that mattered here — an SDK whose
 * schema generation changed under a server written against an older release —
 * is exactly what broke the off-the-shelf alternative.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { authorizes, describeAuth } from "./auth.js";
import { asUntrustedContent, ContentError, fetchDocument, fetchImage } from "./fetchContent.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const PROTOCOL_VERSION = "2025-06-18";
const PORT = Number(process.env.PORT ?? 3000);
/** Shared secret callers must present. Unset means no authentication — see `auth.ts`. */
const API_KEY = process.env.MCP_API_KEY;
const MAX_BODY_BYTES = 64 * 1024;

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const URL_PROPERTY = {
  url: { type: "string", description: "Absolute http(s) URL." },
} as const;

const TOOLS = [
  {
    name: "fetch_image",
    description:
      "Download an image from an https URL and return its bytes, so the image can be looked at, " +
      "edited, or handed to an image model. Use this when another tool gave you a picture's " +
      "address rather than the picture. Returns the image itself, not a description of it. " +
      "For a document at a URL, use fetch_document instead.",
    inputSchema: { type: "object", properties: URL_PROPERTY, required: ["url"] },
  },
  {
    name: "fetch_document",
    description:
      "Download a document or web page from an https URL and return its text. Handles plain " +
      "text, Markdown, CSV, JSON, XML, HTML (converted to readable text) and PDF (text " +
      "extracted). Use this to read something you only have a link to — a report, a spec, a " +
      "data file, an article. Returns the contents, not a summary. For an image, use " +
      "fetch_image instead.",
    inputSchema: { type: "object", properties: URL_PROPERTY, required: ["url"] },
  },
] as const;

function authorized(request: IncomingMessage): boolean {
  return authorizes(API_KEY, request.headers.authorization);
}

function toolError(text: string): unknown {
  return { content: [{ type: "text", text }], isError: true };
}

async function callTool(name: unknown, args: { url?: unknown }): Promise<unknown> {
  if (typeof args.url !== "string" || !args.url) {
    return toolError("Error: `url` is required.");
  }
  try {
    if (name === "fetch_image") {
      // The image block is the whole point: a base64 string in a text block is
      // just text, and a client cannot turn it back into a picture.
      return { content: [{ type: "image", ...(await fetchImage(args.url)) }] };
    }
    const { text, note } = await fetchDocument(args.url);
    // Text, never a binary resource: a consumer handed a non-image blob decodes
    // it as UTF-8, and arbitrary bytes decode to replacement characters rather
    // than to an error. Extraction has to happen here or not at all.
    return { content: [{ type: "text", text: asUntrustedContent(args.url, text, note) }] };
  } catch (error) {
    // A failed fetch is the model's problem to react to, not the run's, so it
    // comes back as a tool error rather than a protocol one.
    const reason = error instanceof ContentError ? error.message : describe(error);
    const what = name === "fetch_image" ? "image" : "document";
    // The model is told; without this the operator is not, and "everything to
    // that host started failing on Tuesday" has no evidence behind it anywhere.
    console.warn(`${String(name)} failed: ${originOf(args.url)} — ${reason}`);
    return toolError(`Error: could not fetch the ${what} — ${reason}`);
  }
}

/**
 * The origin, and nothing else. The URL is one the model read out of some other
 * tool's output, and those carry their capability in the URL itself — a signed
 * query string, or a secret path segment as a Slack webhook does. A log line is
 * the last place either should come to rest, and the question this line is here
 * to answer — "everything to that host started failing on Tuesday" — is asked
 * about the host.
 */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "(unparseable url)";
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" || error.name === "AbortError"
      ? "the request timed out"
      : error.message;
  }
  return String(error);
}

async function handle(message: JsonRpcRequest): Promise<unknown> {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    case "tools/list":
      return { tools: TOOLS };
    // Not gated behind a capability: ping is part of the base protocol and the
    // receiver must answer it. A client using it as a keepalive reads an error
    // here as a dead connection.
    case "ping":
      return {};
    case "tools/call": {
      const name = message.params?.name;
      if (!TOOLS.some((tool) => tool.name === name)) {
        throw new Error(`unknown tool: ${String(name)}`);
      }
      return callTool(name, (message.params?.arguments ?? {}) as { url?: unknown });
    }
    default:
      throw new Error(`unsupported method: ${message.method}`);
  }
}

/** Distinguished from a parse failure so the caller is not sent to debug its JSON. */
class BodyTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new BodyTooLarge(`request body is over the ${MAX_BODY_BYTES} byte limit`);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json" });
  response.end(text);
}

const server = createServer((request, response) => {
  void (async () => {
    // On the path alone: a probe or a proxy is free to append a query string,
    // and matching the whole target turned `/health?x=1` into a 404.
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    if (path === "/health") {
      send(response, 200, { status: "ok" });
      return;
    }
    if (!path.startsWith("/mcp")) {
      send(response, 404, { error: "not found" });
      return;
    }
    if (!authorized(request)) {
      send(response, 401, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "missing or invalid bearer token" },
      });
      return;
    }
    if (request.method === "DELETE") {
      // Session teardown: this server is stateless, so there is nothing to release.
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST") {
      send(response, 405, { error: "method not allowed" });
      return;
    }
    let body: string;
    try {
      body = await readBody(request);
    } catch (error) {
      const tooLarge = error instanceof BodyTooLarge;
      send(response, tooLarge ? 413 : 400, {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32600,
          message: tooLarge ? error.message : "could not read the request body",
        },
      });
      return;
    }
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(body) as JsonRpcRequest;
    } catch {
      send(response, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "parse error" },
      });
      return;
    }
    // A notification carries no id and expects no reply.
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    try {
      send(response, 200, { jsonrpc: "2.0", id: message.id, result: await handle(message) });
    } catch (error) {
      send(response, 200, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: (error as Error).message },
      });
    }
  })();
});

server.listen(PORT, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on :${PORT} (POST /mcp)`);
  // Always, not only when open: an operator reading logs to find out which mode
  // an instance is in should not have to infer it from a line that is missing.
  const notice = describeAuth(API_KEY);
  if (API_KEY) {
    console.log(notice);
  } else {
    console.warn(notice);
  }
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
