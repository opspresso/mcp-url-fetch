/**
 * An MCP server with one tool: fetch an image URL and hand back its bytes.
 *
 * It exists because a URL is not an image. An agent that reads a picture's
 * address out of some other tool — a Slack avatar, a search result — cannot do
 * anything with it: the bytes are never in hand, so there is nothing to edit or
 * pass to an image model. This closes that gap, and only that gap.
 *
 * The protocol is implemented directly rather than through an SDK. The surface
 * is four methods, and the one dependency that mattered here — an SDK whose
 * schema generation changed under a server written against an older release —
 * is exactly what broke the off-the-shelf alternative.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fetchPublicUrl } from "./publicFetch.js";


const PROTOCOL_VERSION = "2025-06-18";
const PORT = Number(process.env.PORT ?? 3000);
/** Shared secret every caller must present. Unset means the server refuses to start. */
const API_KEY = process.env.MCP_API_KEY;
/** Matches what Agent Studio accepts from a user, so nothing arrives it cannot use. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 64 * 1024;

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOL = {
  name: "fetch_image",
  description:
    "Download an image from an https URL and return its bytes, so the image can be looked at, " +
    "edited, or handed to an image model. Use this when another tool gave you a picture's " +
    "address rather than the picture. Returns the image itself, not a description of it.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL of the image." },
    },
    required: ["url"],
  },
} as const;

/** Constant-time compare so a wrong key cannot be found one character at a time. */
function keyMatches(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(API_KEY ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorized(request: IncomingMessage): boolean {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  return token.length > 0 && keyMatches(token);
}

async function fetchImage(url: string): Promise<{ data: string; mimeType: string }> {
  const response = await fetchPublicUrl(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { Accept: [...SUPPORTED_IMAGE_TYPES].join(", ") },
  });
  if (!response.ok) {
    throw new Error(`the server answered ${response.status}`);
  }
  const mimeType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!SUPPORTED_IMAGE_TYPES.has(mimeType)) {
    throw new Error(`unsupported content type: ${mimeType || "none"}`);
  }
  // Declared length first, then the real one: a lying header must not decide
  // how much is read into memory.
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
    throw new Error(`image is ${declared} bytes, over the ${MAX_IMAGE_BYTES} limit`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image is ${bytes.byteLength} bytes, over the ${MAX_IMAGE_BYTES} limit`);
  }
  return { data: Buffer.from(bytes).toString("base64"), mimeType };
}

async function handle(message: JsonRpcRequest): Promise<unknown> {
  switch (message.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcp-image-fetch", version: "1.0.0" },
      };
    case "tools/list":
      return { tools: [TOOL] };
    case "tools/call": {
      const name = message.params?.name;
      if (name !== TOOL.name) {
        throw new Error(`unknown tool: ${String(name)}`);
      }
      const args = (message.params?.arguments ?? {}) as { url?: unknown };
      if (typeof args.url !== "string" || !args.url) {
        return { content: [{ type: "text", text: "Error: `url` is required." }], isError: true };
      }
      try {
        const image = await fetchImage(args.url);
        // The image block is the whole point: a base64 string in a text block
        // is just text, and a client cannot turn it back into a picture.
        return { content: [{ type: "image", ...image }] };
      } catch (error) {
        // A failed fetch is the model's problem to react to, not the run's, so
        // it comes back as a tool error rather than a protocol one.
        const reason = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: could not fetch the image — ${reason}` }], isError: true };
      }
    }
    default:
      throw new Error(`unsupported method: ${message.method}`);
  }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body too large");
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
    if (request.url === "/health") {
      send(response, 200, { status: "ok" });
      return;
    }
    if (!request.url?.startsWith("/mcp")) {
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
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(await readBody(request)) as JsonRpcRequest;
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

if (!API_KEY) {
  console.error("MCP_API_KEY is not set. This server fetches arbitrary URLs; it will not run open.");
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`mcp-image-fetch listening on :${PORT} (POST /mcp)`);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
