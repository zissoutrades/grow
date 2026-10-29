import { existsSync, statSync } from "node:fs";
import type { Server, ServerWebSocket } from "bun";
import { resolve } from "node:path";
import {
  activeSessionFrom,
  applyPreset,
  consoleChat,
  consoleState,
  ConsoleError,
  readConsoleConfig,
  readConsoleFiles,
  writeConsoleConfig,
} from "./console";
import { Session, type ClientSink, type FinalizeReason } from "./session";
import { uiAsset } from "./static";
import type { ChildActionKind } from "./tools";

const PORT = Number(process.env.PORT ?? 8787);

interface WsData {
  readonly sessionId: string;
}

const sessions = new Map<string, Session>();
let lastSessionId: string | null = null;
/** Workspace of the most recent session; console routes fall back to it. */
let lastWorkspacePath: string | null = null;

class WsSink implements ClientSink {
  private readonly ws: ServerWebSocket<WsData>;

  constructor(ws: ServerWebSocket<WsData>) {
    this.ws = ws;
  }

  sendJson(payload: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  sendBinary(bytes: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(bytes);
    }
  }
}

/**
 * Build the proxy server without starting it, so tests can bind an ephemeral
 * port; `import.meta.main` at the bottom starts it for `bun run` and the exe.
 */
export function createServer(port: number = PORT): Server {
  return Bun.serve<WsData>({
    port,
    fetch(request, bunServer) {
      const url = new URL(request.url);

      if (url.pathname === "/live") {
        const requested = url.searchParams.get("sessionId") ?? lastSessionId;
        if (requested === null || !sessions.has(requested)) {
          return json({ error: "unknown session; POST /api/start first" }, 404);
        }
        const upgraded = bunServer.upgrade(request, { data: { sessionId: requested } });
        return upgraded ? undefined : json({ error: "websocket upgrade failed" }, 400);
      }

      if (url.pathname === "/api/start" && request.method === "POST") {
        return handleStart(request);
      }
      if (url.pathname === "/api/close" && request.method === "POST") {
        return handleClose(request);
      }
      if (url.pathname.startsWith("/api/session/") && request.method === "GET") {
        return handleSessionStatus(url.pathname);
      }
      if (url.pathname.startsWith("/api/console/")) {
        return handleConsole(request, url);
      }
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        return json({ error: "not found" }, 404);
      }

      // Static UI (PROTOCOL §1/§10): `/` is the child session, `/console` the
      // parent console, everything else is one of the embedded UI assets.
      if (url.pathname === "/") {
        return serveUi("index.html");
      }
      if (url.pathname === "/console" || url.pathname === "/console/") {
        return serveUi("console.html");
      }
      if (url.pathname.startsWith("/console/")) {
        return serveUi(url.pathname.slice("/console/".length));
      }
      return serveUi(url.pathname.slice(1));
    },
    websocket: {
      open(ws) {
        const session = sessions.get(ws.data.sessionId);
        session?.attachClient(new WsSink(ws));
      },
      message(ws, message) {
        const session = sessions.get(ws.data.sessionId);
        if (session === undefined) {
          return;
        }
        if (typeof message === "string") {
          handleWsText(session, message);
          return;
        }
        session.handleClientAudio(new Uint8Array(message));
      },
      close(ws) {
        const session = sessions.get(ws.data.sessionId);
        session?.detachClient();
      },
    },
  });
}

async function handleStart(request: Request): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return json(
      { error: "GEMINI_API_KEY is not set; export it before starting the proxy" },
      500,
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }
  if (!isRecord(body) || typeof body.workspacePath !== "string" || body.workspacePath.length === 0) {
    return json({ error: "workspacePath is required" }, 400);
  }

  const workspacePath = resolve(body.workspacePath);
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    return json({ error: `workspace folder not found: ${workspacePath}` }, 400);
  }

  const session = new Session({ workspacePath, apiKey });
  try {
    const started = await session.start();
    sessions.set(started.sessionId, session);
    lastSessionId = started.sessionId;
    lastWorkspacePath = workspacePath;
    return json({ sessionId: started.sessionId, files: started.files });
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
}

async function handleClose(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }
  if (!isRecord(body) || typeof body.sessionId !== "string") {
    return json({ error: "sessionId is required" }, 400);
  }
  if (body.reason !== "child_tap" && body.reason !== "parent_console") {
    return json({ error: "reason must be child_tap or parent_console" }, 400);
  }
  const session = sessions.get(body.sessionId);
  if (session === undefined) {
    return json({ error: `unknown session: ${body.sessionId}` }, 404);
  }
  try {
    const folder = await session.finalize(body.reason as FinalizeReason);
    return json({ sessionFolder: folder });
  } catch (error) {
    return json({ error: errorMessage(error) }, 500);
  }
}

function handleSessionStatus(pathname: string): Response {
  const sessionId = decodeURIComponent(pathname.slice("/api/session/".length));
  const session = sessions.get(sessionId);
  if (session === undefined) {
    return json({ error: `unknown session: ${sessionId}` }, 404);
  }
  const status = session.getStatus();
  return json({
    afterStatus: status.afterStatus,
    written: status.written,
    reason: status.reason,
  });
}

const CONSOLE_WORKSPACE_ERROR =
  "workspace is not set: pass workspace, start a session, or set GROW_WORKSPACE";

/** Parent-console routes (PROTOCOL §10) plus `/console` static serving. */
async function handleConsole(request: Request, url: URL): Promise<Response> {
  const pathname = url.pathname;
  try {
    if (pathname === "/api/console/state" && request.method === "GET") {
      return json(consoleState(activeSessionId(), resolveConsoleWorkspace(url, null)));
    }
    if (pathname === "/api/console/config" && request.method === "GET") {
      const workspacePath = requireConsoleWorkspace(url, null);
      return json(readConsoleConfig(workspacePath));
    }
    if (pathname === "/api/console/files" && request.method === "GET") {
      const workspacePath = requireConsoleWorkspace(url, null);
      return json(readConsoleFiles(workspacePath));
    }
    if (pathname === "/api/console/chat" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        typeof body.message !== "string" ||
        body.message.trim().length === 0
      ) {
        return json({ error: "message is required" }, 400);
      }
      const workspacePath = requireConsoleWorkspace(url, body);
      const result = await consoleChat(body.message, { workspacePath });
      return json(result);
    }
    if (pathname === "/api/console/config" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        typeof body.path !== "string" ||
        typeof body.content !== "string"
      ) {
        return json({ error: "path and content are required" }, 400);
      }
      const workspacePath = requireConsoleWorkspace(url, body);
      return json(writeConsoleConfig(workspacePath, body.path, body.content));
    }
    if (pathname === "/api/console/preset" && request.method === "POST") {
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.name !== "string" || body.name.length === 0) {
        return json({ error: "name is required" }, 400);
      }
      const workspacePath = requireConsoleWorkspace(url, body);
      return json(applyPreset(workspacePath, body.name));
    }
    return json({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof ConsoleError) {
      return json({ error: error.message }, 400);
    }
    return json({ error: errorMessage(error) }, 502);
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ConsoleError("request body must be JSON");
  }
}

function requireConsoleWorkspace(url: URL, body: unknown): string {
  const workspacePath = resolveConsoleWorkspace(url, body);
  if (workspacePath === null) {
    throw new ConsoleError(CONSOLE_WORKSPACE_ERROR);
  }
  return workspacePath;
}

/**
 * Console workspace resolution order: request body/query, then the most recent
 * session's folder, then `GROW_WORKSPACE` / `WORKSPACE_PATH` from the env.
 * PROTOCOL §10 routes carry no workspace parameter, so this keeps them pinned
 * while still letting the console page work before the first child session.
 */
function resolveConsoleWorkspace(url: URL, body: unknown): string | null {
  let raw: string | null = null;
  if (isRecord(body) && typeof body.workspace === "string" && body.workspace.trim().length > 0) {
    raw = body.workspace.trim();
  }
  const query = url.searchParams.get("workspace");
  if (raw === null && query !== null && query.trim().length > 0) {
    raw = query.trim();
  }
  if (raw === null) {
    raw = lastWorkspacePath;
  }
  if (raw === null) {
    const env = process.env.GROW_WORKSPACE ?? process.env.WORKSPACE_PATH;
    if (env !== undefined && env.trim().length > 0) {
      raw = env.trim();
    }
  }
  if (raw === null) {
    return null;
  }
  const workspacePath = resolve(raw);
  if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
    throw new ConsoleError(`workspace folder not found: ${workspacePath}`);
  }
  return workspacePath;
}

function activeSessionId(): string | null {
  return activeSessionFrom(
    Array.from(sessions, ([sessionId, session]) => ({
      sessionId,
      state: session.snapshot().state,
    })),
  );
}

function handleWsText(session: Session, raw: string): void {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    session.notifyClientError("malformed client message (expected JSON)");
    return;
  }
  if (!isRecord(message)) {
    session.notifyClientError("malformed client message (expected an object)");
    return;
  }
  if (message.type === "close") {
    void session.finalize("child_tap");
    return;
  }
  if (message.type === "tutor_playback_idle") {
    // The client's playback queue drained: the real end of tutor audio
    // (PROTOCOL §2). Used to arm the start-failsafe/farewell grace.
    session.handleTutorPlaybackIdle();
    return;
  }
  if (message.type === "child_action") {
    if (!isChildActionKind(message.kind)) {
      session.notifyClientError("child_action.kind must be choice, tenframe, or numberline");
      return;
    }
    session.handleChildAction({ kind: message.kind, value: message.value });
    return;
  }
  session.notifyClientError(`unknown message type: ${String(message.type)}`);
}

function isChildActionKind(value: unknown): value is ChildActionKind {
  return value === "choice" || value === "tenframe" || value === "numberline";
}

function serveUi(relativePath: string): Response {
  const asset = uiAsset(relativePath);
  if (asset === null) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(asset.body, {
    headers: { "content-type": asset.contentType },
  });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const server = createServer();
  console.log(`Grow proxy listening on http://localhost:${server.port}/`);
}
