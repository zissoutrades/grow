// Thin browser client for the PROTOCOL §2 proxy surface. Holds no keys and
// touches no files: everything goes through the local proxy.
//
// HTTP:  POST /api/start {workspacePath} -> {sessionId, files}
//        POST /api/close {sessionId, reason} -> {sessionFolder}
//        GET  /api/session/:id -> {afterStatus, written}
// WS:    /live?sessionId=<id> — JSON events up, bare binary PCM both ways.

import { t } from "./locale.js";

export class ProxyClientError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = "ProxyClientError";
    this.status = status;
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    // Error bodies are not always JSON; the caller reports the HTTP status.
    return {};
  }
}

function websocketUrl(baseUrl, sessionId) {
  const base = baseUrl.length > 0
    ? baseUrl
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${base}/live?sessionId=${encodeURIComponent(sessionId)}`;
}

/**
 * Create a proxy client. Handlers are all optional:
 *   onEvent(message)   parsed JSON event from the proxy
 *   onAudio(bytes)     Uint8Array of 24 kHz Int16 LE tutor audio
 *   onOpen()           WebSocket open
 *   onClose(event)     WebSocket closed
 *   onError(message)   transport/protocol error surfaced to the UI
 */
export function createProxyClient(handlers = {}, options = {}) {
  const httpBase = options.httpBaseUrl ?? "";
  const wsBase = options.wsBaseUrl ?? (options.httpBaseUrl ?? "");

  let socket = null;
  let sessionId = null;

  async function start(workspacePath) {
    const response = await fetch(`${httpBase}/api/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspacePath }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new ProxyClientError(
        typeof payload.error === "string" ? payload.error : t("proxy.startFailed", { status: response.status }),
        response.status,
      );
    }
    if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0) {
      throw new ProxyClientError(t("proxy.noSessionId"));
    }
    sessionId = payload.sessionId;
    return {
      sessionId: payload.sessionId,
      files: Array.isArray(payload.files) ? payload.files : [],
    };
  }

  function connect(id = sessionId) {
    if (id === null) {
      throw new ProxyClientError(t("proxy.noSessionConnect"));
    }
    disconnect();
    sessionId = id;
    const current = new WebSocket(websocketUrl(wsBase, id));
    socket = current;
    current.binaryType = "arraybuffer";

    current.addEventListener("open", () => {
      if (socket === current) {
        handlers.onOpen?.();
      }
    });
    current.addEventListener("message", (event) => {
      if (socket !== current) {
        return;
      }
      if (typeof event.data === "string") {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          handlers.onError?.(t("proxy.badJson"));
          return;
        }
        handlers.onEvent?.(message);
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        handlers.onAudio?.(new Uint8Array(event.data));
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.arrayBuffer().then((buffer) => handlers.onAudio?.(new Uint8Array(buffer)));
        return;
      }
      handlers.onError?.(t("proxy.unknownMessage"));
    });
    current.addEventListener("close", (event) => {
      if (socket !== current) {
        return;
      }
      socket = null;
      handlers.onClose?.(event);
    });
    current.addEventListener("error", () => {
      if (socket === current) {
        handlers.onError?.(t("proxy.unreachable"));
      }
    });
  }

  function isOpen() {
    return socket !== null && socket.readyState === WebSocket.OPEN;
  }

  /** Send one bare 16 kHz Int16 mono frame (3200 bytes for 100 ms). */
  function sendAudio(bytes) {
    if (isOpen()) {
      socket.send(bytes);
    }
  }

  function sendChildAction(kind, value) {
    if (isOpen()) {
      socket.send(JSON.stringify({ type: "child_action", kind, value }));
    }
  }

  /** Send {"type":"close"}; returns false when the socket is not open. */
  function requestClose() {
    if (!isOpen()) {
      return false;
    }
    try {
      socket.send(JSON.stringify({ type: "close" }));
      return true;
    } catch {
      // The socket closed between the readyState check and send().
      return false;
    }
  }

  /**
   * Send {"type":"tutor_playback_idle"} (PROTOCOL §2). Returns false when the
   * socket is not open; the proxy falls back to turn_complete timing.
   */
  function sendPlaybackIdle() {
    if (!isOpen()) {
      return false;
    }
    try {
      socket.send(JSON.stringify({ type: "tutor_playback_idle" }));
      return true;
    } catch {
      return false;
    }
  }

  async function closeHttp(reason = "child_tap") {
    if (sessionId === null) {
      throw new ProxyClientError(t("proxy.noSessionClose"));
    }
    const response = await fetch(`${httpBase}/api/close`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, reason }),
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new ProxyClientError(
        typeof payload.error === "string" ? payload.error : t("proxy.closeFailed", { status: response.status }),
        response.status,
      );
    }
    return { sessionFolder: typeof payload.sessionFolder === "string" ? payload.sessionFolder : "" };
  }

  async function getSessionStatus(id = sessionId) {
    if (id === null) {
      throw new ProxyClientError(t("proxy.noSession"));
    }
    const response = await fetch(`${httpBase}/api/session/${encodeURIComponent(id)}`);
    const payload = await readJson(response);
    if (!response.ok) {
      throw new ProxyClientError(
        typeof payload.error === "string" ? payload.error : t("proxy.statusFailed", { status: response.status }),
        response.status,
      );
    }
    return {
      afterStatus:
        payload.afterStatus === "done" ||
        payload.afterStatus === "error" ||
        payload.afterStatus === "skipped"
          ? payload.afterStatus
          : "running",
      written: Array.isArray(payload.written) ? payload.written.map(String) : [],
      reason: typeof payload.reason === "string" ? payload.reason : null,
    };
  }

  function disconnect() {
    if (socket !== null) {
      const closing = socket;
      socket = null;
      try {
        closing.close();
      } catch {
        // Already closing — nothing to do.
      }
    }
  }

  return {
    start,
    connect,
    sendAudio,
    sendChildAction,
    requestClose,
    sendPlaybackIdle,
    closeHttp,
    getSessionStatus,
    disconnect,
    isOpen,
    get sessionId() {
      return sessionId;
    },
  };
}
