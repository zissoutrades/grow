// Mock proxy for the Grow UI (U2). Implements the PROTOCOL §2 server surface
// with canned behavior: no API key, no network, no workspace access. It serves
// the real static client from src/ui/ so the whole flow — start, scripted
// session, widgets, child actions, close, after-status — can be exercised
// offline.
//
//   bun run scripts/mock-proxy.ts
//   open http://localhost:8788
import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.PORT ?? 8788);
const UI_DIR = resolve(fileURLToPath(new URL("../src/ui/", import.meta.url)));
const PLAYBACK_RATE = 24000;
const TONE_CHUNK = 2400; // 100 ms

type AfterStatus = "running" | "done" | "error";
type FinalizeReason = "child_tap" | "parent_console" | "timeout" | "silence";

interface WsData {
  readonly sessionId: string;
}

interface MockSession {
  readonly id: string;
  ws: ServerWebSocket<WsData> | null;
  readonly timers: Set<ReturnType<typeof setTimeout>>;
  toneTimer: ReturnType<typeof setInterval> | null;
  interruptTimer: ReturnType<typeof setTimeout> | null;
  afterStatus: AfterStatus;
  written: string[];
  closed: boolean;
  reacted: boolean;
}

const sessions = new Map<string, MockSession>();
let lastSessionId: string | null = null;
let sessionCounter = 0;

const server = Bun.serve<WsData>({
  port: PORT,
  async fetch(request, bunServer) {
    const url = new URL(request.url);

    if (url.pathname === "/live") {
      const requested = url.searchParams.get("sessionId") ?? lastSessionId;
      const session = requested === null ? undefined : sessions.get(requested);
      if (session === undefined) {
        return json({ error: "unknown session; POST /api/start first" }, 404);
      }
      const upgraded = bunServer.upgrade(request, { data: { sessionId: session.id } });
      return upgraded ? undefined : json({ error: "websocket upgrade failed" }, 400);
    }

    if (url.pathname === "/api/start" && request.method === "POST") {
      return handleStart(request);
    }
    if (url.pathname === "/api/close" && request.method === "POST") {
      return handleClose(request);
    }
    if (url.pathname.startsWith("/api/session/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/session/".length));
      const session = sessions.get(id);
      if (session === undefined) {
        return json({ error: `unknown session: ${id}` }, 404);
      }
      return json({ afterStatus: session.afterStatus, written: session.written });
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return json({ error: "not found" }, 404);
    }

    return serveStatic(url.pathname);
  },
  websocket: {
    open(ws) {
      const session = sessions.get(ws.data.sessionId);
      if (session === undefined) {
        ws.close(1011, "unknown session");
        return;
      }
      session.ws = ws;
      console.log(`[mock] client connected: ${session.id}`);
      startScript(session);
    },
    message(ws, message) {
      const session = sessions.get(ws.data.sessionId);
      if (session === undefined) {
        return;
      }
      if (typeof message !== "string") {
        return; // child audio is accepted and ignored
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(message);
      } catch {
        console.warn("[mock] ignored malformed client message");
        return;
      }
      if (!isRecord(parsed)) {
        return;
      }
      if (parsed.type === "close") {
        closeSession(session, "child_tap");
        return;
      }
      if (parsed.type === "child_action") {
        const kind = typeof parsed.kind === "string" ? parsed.kind : "unknown";
        console.log(`[mock] child_action ${kind}: ${JSON.stringify(parsed.value)}`);
        schedule(session, 300, () => reactToAnswer(session));
      }
    },
    close(ws) {
      const session = sessions.get(ws.data.sessionId);
      if (session === undefined) {
        return;
      }
      session.ws = null;
      if (!session.closed) {
        clearSessionTimers(session);
        console.log(`[mock] client disconnected: ${session.id}`);
      }
    },
  },
});

console.log(`Grow mock proxy listening on http://localhost:${server.port}`);
console.log("Open the URL, enter any folder path, allow the microphone.");
console.log("Audio you hear is a generated test tone; close the session to see session_saved + after.");

async function handleStart(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "request body must be JSON" }, 400);
  }
  if (!isRecord(body) || typeof body.workspacePath !== "string" || body.workspacePath.trim().length === 0) {
    return json({ error: "workspacePath is required" }, 400);
  }

  sessionCounter += 1;
  const id = `mock-${Date.now().toString(36)}-${sessionCounter}`;
  const session: MockSession = {
    id,
    ws: null,
    timers: new Set(),
    toneTimer: null,
    interruptTimer: null,
    afterStatus: "running",
    written: [],
    closed: false,
    reacted: false,
  };
  sessions.set(id, session);
  lastSessionId = id;
  console.log(`[mock] session started: ${id}`);

  return json({
    sessionId: id,
    files: [
      { path: "config/tutor.md", bytes: 1024 },
      { path: "config/curriculum.md", bytes: 860 },
      { path: "plans/lesson-2026-10-30.md", bytes: 1420 },
      { path: "memory/child.md", bytes: 380 },
    ],
  });
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
  if (body.reason !== undefined && body.reason !== "child_tap" && body.reason !== "parent_console") {
    return json({ error: "reason must be child_tap or parent_console" }, 400);
  }
  const session = sessions.get(body.sessionId);
  if (session === undefined) {
    return json({ error: `unknown session: ${body.sessionId}` }, 404);
  }
  const reason = body.reason === "parent_console" ? "parent_console" : "child_tap";
  closeSession(session, reason);
  return json({ sessionFolder: `sessions/${session.id}` });
}

function closeSession(session: MockSession, reason: FinalizeReason): void {
  if (session.closed) {
    return;
  }
  session.closed = true;
  clearSessionTimers(session);

  sendJson(session, { type: "session_saved", reason, sessionId: session.id });
  session.afterStatus = "running";
  session.written = [];
  sendJson(session, { type: "after", status: "running", written: [] });
  console.log(`[mock] session saved: ${session.id} (${reason})`);

  setTimeout(() => {
    session.afterStatus = "done";
    session.written = ["diary", "report", "plan"];
    sendJson(session, { type: "after", status: "done", written: session.written });
    console.log(`[mock] after done: ${session.id}`);
  }, 1200);
}

// --- Canned session script ------------------------------------------------

function startScript(session: MockSession): void {
  schedule(session, 200, () => {
    sendJson(session, { type: "beat", beatId: "recall", outcome: "ok" });
  });
  schedule(session, 350, () => {
    sendJson(session, { type: "transcript", role: "tutor", text: "Привет", partial: true });
  });
  schedule(session, 700, () => {
    sendJson(session, {
      type: "transcript",
      role: "tutor",
      text: "Привет! Сегодня считаем до десяти.",
      partial: false,
    });
  });
  schedule(session, 1000, () => {
    sendJson(session, { type: "canvas", tool: "show_ten_frame", args: { filled: 3 } });
  });
  schedule(session, 1200, () => {
    sendJson(session, { type: "canvas", tool: "show_text", args: { text: "Сколько клеток занято?" } });
  });
  schedule(session, 1400, () => {
    streamTone(session, 2, () => {
      sendJson(session, { type: "turn", event: "turn_complete" });
    });
  });
  schedule(session, 3600, () => {
    sendJson(session, { type: "transcript", role: "child", text: "три", partial: true });
  });
  schedule(session, 3900, () => {
    sendJson(session, { type: "transcript", role: "child", text: "три клетки", partial: false });
  });
  schedule(session, 4100, () => {
    sendJson(session, { type: "beat", beatId: "present", outcome: "ok" });
  });
  schedule(session, 4300, () => {
    sendJson(session, {
      type: "canvas",
      tool: "show_choice_cards",
      args: {
        cards: [
          { id: "6", label: "6" },
          { id: "7", label: "7" },
          { id: "8", label: "8" },
        ],
      },
    });
  });
  // If the child does not tap a card, the mock answers on their behalf.
  schedule(session, 6000, () => reactToAnswer(session));
  schedule(session, 7400, () => {
    streamTone(session, 3, undefined, 400);
  });
  schedule(session, 8600, () => {
    sendJson(session, { type: "transcript", role: "tutor", text: "Молодец", partial: true });
  });
  schedule(session, 8900, () => {
    sendJson(session, {
      type: "transcript",
      role: "tutor",
      text: "Молодец! Мы сделали семь.",
      partial: false,
    });
  });
  schedule(session, 9000, () => {
    sendJson(session, { type: "canvas", tool: "fill_frame", args: { index: 3 } });
  });
  schedule(session, 9400, () => {
    sendJson(session, { type: "beat", beatId: "consolidate", outcome: "ok" });
  });
  schedule(session, 10000, () => {
    sendJson(session, { type: "canvas", tool: "show_text", args: { text: "До встречи!" } });
  });
  schedule(session, 10400, () => {
    sendJson(session, {
      type: "transcript",
      role: "tutor",
      text: "До встречи! Ты отлично поработал.",
      partial: false,
    });
  });
  schedule(session, 10800, () => {
    sendJson(session, { type: "transcript", role: "child", text: "пока", partial: false });
  });
  // Safety net so an abandoned tab still shows the ending flow.
  schedule(session, 45000, () => closeSession(session, "timeout"));
}

function reactToAnswer(session: MockSession): void {
  if (session.closed || session.reacted) {
    return;
  }
  session.reacted = true;
  sendJson(session, { type: "transcript", role: "tutor", text: "Хорошо, проверим вместе.", partial: true });
  schedule(session, 250, () => {
    sendJson(session, {
      type: "transcript",
      role: "tutor",
      text: "Хорошо, проверим вместе.",
      partial: false,
    });
  });
  sendJson(session, { type: "beat", beatId: "attempt", outcome: "ok" });
  sendJson(session, {
    type: "canvas",
    tool: "show_number_line",
    args: { min: 0, max: 10, marker: 7 },
  });
}

// --- Audio ----------------------------------------------------------------

function streamTone(
  session: MockSession,
  seconds: number,
  onDone?: () => void,
  interruptAfterMs?: number,
): void {
  stopTone(session);
  const pcm = makeTone(Math.round(seconds * PLAYBACK_RATE));
  let offset = 0;

  session.toneTimer = setInterval(() => {
    if (session.closed || session.ws === null) {
      stopTone(session);
      return;
    }
    const end = Math.min(offset + TONE_CHUNK, pcm.length);
    session.ws.send(new Uint8Array(pcm.buffer, offset * 2, (end - offset) * 2));
    offset = end;
    if (offset >= pcm.length) {
      stopTone(session);
      onDone?.();
    }
  }, 100);

  if (interruptAfterMs !== undefined) {
    session.interruptTimer = setTimeout(() => {
      session.interruptTimer = null;
      stopTone(session);
      sendJson(session, { type: "turn", event: "interrupted" });
      console.log(`[mock] interrupted mid-turn: ${session.id}`);
    }, interruptAfterMs);
  }
}

function makeTone(sampleCount: number): Int16Array {
  const pcm = new Int16Array(sampleCount);
  const twoPi = Math.PI * 2;
  const attack = PLAYBACK_RATE * 0.03;
  const release = PLAYBACK_RATE * 0.08;
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index / PLAYBACK_RATE;
    const envelope = Math.min(1, index / attack, (sampleCount - index) / release);
    const value =
      Math.sin(twoPi * 392 * time) * 0.16 + Math.sin(twoPi * 523.25 * time) * 0.08;
    pcm[index] = Math.round(value * Math.max(0, envelope) * 0x7fff);
  }
  return pcm;
}

// --- Helpers --------------------------------------------------------------

function schedule(session: MockSession, delayMs: number, callback: () => void): void {
  const handle = setTimeout(() => {
    session.timers.delete(handle);
    if (!session.closed) {
      callback();
    }
  }, delayMs);
  session.timers.add(handle);
}

function stopTone(session: MockSession): void {
  if (session.toneTimer !== null) {
    clearInterval(session.toneTimer);
    session.toneTimer = null;
  }
  if (session.interruptTimer !== null) {
    clearTimeout(session.interruptTimer);
    session.interruptTimer = null;
  }
}

function clearSessionTimers(session: MockSession): void {
  for (const handle of session.timers) {
    clearTimeout(handle);
  }
  session.timers.clear();
  stopTone(session);
}

function sendJson(session: MockSession, payload: unknown): void {
  const ws = session.ws;
  if (ws !== null && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function serveStatic(pathname: string): Response {
  let relative: string;
  try {
    relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  } catch {
    return notFound();
  }
  if (relative.length === 0) {
    relative = "index.html";
  }
  if (relative.endsWith("/")) {
    relative = `${relative}index.html`;
  }

  const absolute = resolve(UI_DIR, relative);
  if (absolute !== UI_DIR && !absolute.startsWith(`${UI_DIR}${sep}`)) {
    return notFound();
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    return notFound();
  }

  const contentType = CONTENT_TYPES[extname(absolute).toLowerCase()] ?? "application/octet-stream";
  return new Response(Bun.file(absolute), { headers: { "content-type": contentType } });
}

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
