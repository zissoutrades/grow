// Grow session client. Wires the proxy client, microphone capture, tutor
// playback, canvas widgets and the three screens together. All protocol
// shapes follow PROTOCOL.md §2 (agent harness repo, private).
import { createProxyClient } from "./proxy-client.js";
import { createCanvasView } from "./canvas.js";
import {
  applyCanvasEvent,
  applyTranscript,
  clearChoiceSelection,
  formatClock,
  initialCanvasState,
  initialTranscriptState,
  int16ToFloat32,
  selectChoice,
  tapTenFrame,
} from "./core.js";

const WORKLET_URL = new URL("./worklets.js", import.meta.url).href;
const WORKSPACE_STORAGE_KEY = "grow.workspacePath";
const RECENTS_URL = "/api/workspaces/recent";
const AFTER_POLL_MS = 1500;
const AFTER_POLL_LIMIT = 40;
/**
 * If the proxy never confirms a close, re-enable the button so the parent can
 * retry (finalize is idempotent). This guards every "disabled while closing"
 * state against ending up permanently grey.
 */
const CLOSE_REENABLE_MS = 20_000;
/** Empty playback buffer this long after turn_complete = audio really ended. */
const PLAYBACK_IDLE_DEBOUNCE_MS = 300;

const BEAT_LABELS = {
  recall: "вспоминаем",
  present: "объясняем",
  attempt: "пробуем",
  diagnose: "разбираемся",
  repair: "исправляем",
  extend: "расширяем",
  consolidate: "закрепляем",
  reflect: "подводим итог",
  close: "прощаемся",
};

const OUTCOME_LABELS = {
  ok: "ок",
  struggle: "трудно",
  skip: "пропуск",
};

function must(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`missing element #${id}`);
  }
  return element;
}

const screens = {
  landing: must("screen-landing"),
  session: must("screen-session"),
  closed: must("screen-closed"),
};

const statusEl = must("status");
const sessionMeta = must("session-meta");
const clockEl = must("clock");
const beatEl = must("beat");
const workspaceInput = must("workspace-path");
const recentRow = must("recent-row");
const recentSelect = must("recent-select");
const startButton = must("start-button");
const closeButton = must("close-button");
const transcriptEl = must("transcript");
const afterStatusEl = must("after-status");
const newSessionButton = must("new-session-button");
const exitButton = must("exit-button");

const canvasView = createCanvasView({
  tenframeWidget: must("widget-tenframe"),
  tenframeGrid: must("tenframe-grid"),
  tenframeCaption: must("tenframe-caption"),
  numberlineWidget: must("widget-numberline"),
  numberline: must("numberline"),
  choicesWidget: must("widget-choices"),
  choicesGrid: must("choices-grid"),
  textsEl: must("text-blocks"),
  emptyEl: must("canvas-empty"),
  onTenFrameTap: handleTenFrameTap,
  onChoiceTap: handleChoiceTap,
});

const state = {
  client: null,
  audio: null,
  sessionId: null,
  startedAt: 0,
  clockTimer: null,
  pollTimer: null,
  pollAttempts: 0,
  canvas: initialCanvasState(),
  transcript: initialTranscriptState(),
  beat: null,
  closing: false,
  closeGuardTimer: null,
  saved: false,
  afterFinal: false,
  turnCompleteSeen: false,
  playbackDrained: false,
  playbackIdleTimer: null,
};

// --- Screens and status ---------------------------------------------------

function showScreen(name) {
  for (const [key, element] of Object.entries(screens)) {
    element.hidden = key !== name;
  }
  sessionMeta.hidden = name !== "session";
}

function setStatus(text, tone = "info") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function setAfterStatus(text, isError = false) {
  afterStatusEl.textContent = text;
  afterStatusEl.classList.toggle("error", isError);
}

function setClock(text) {
  clockEl.textContent = text;
}

// --- Close button state ---------------------------------------------------

function setCloseEnabled(enabled) {
  closeButton.disabled = !enabled;
}

function clearCloseGuard() {
  if (state.closeGuardTimer !== null) {
    clearTimeout(state.closeGuardTimer);
    state.closeGuardTimer = null;
  }
}

/** A close request is in flight: disable until saved, but never forever. */
function armCloseGuard() {
  clearCloseGuard();
  state.closeGuardTimer = setTimeout(() => {
    state.closeGuardTimer = null;
    if (state.saved || state.afterFinal) {
      return;
    }
    state.closing = false;
    setCloseEnabled(true);
    setStatus("Завершение затянулось. Попробуйте ещё раз.", "error");
  }, CLOSE_REENABLE_MS);
}

function renderBeat() {
  if (state.beat === null) {
    beatEl.textContent = "этап: —";
    return;
  }
  const beatLabel = BEAT_LABELS[state.beat.beatId] ?? state.beat.beatId;
  const outcomeLabel = OUTCOME_LABELS[state.beat.outcome] ?? state.beat.outcome;
  beatEl.textContent = `этап: ${beatLabel} · ${outcomeLabel}`;
}

function renderTranscript() {
  transcriptEl.textContent = "";
  const fragment = document.createDocumentFragment();

  for (const line of state.transcript.lines) {
    fragment.appendChild(transcriptLine(line.role, line.text, false));
  }
  for (const role of ["tutor", "child"]) {
    const partial = state.transcript.partial[role];
    if (partial.length > 0) {
      fragment.appendChild(transcriptLine(role, partial, true));
    }
  }

  if (fragment.childNodes.length === 0) {
    const placeholder = document.createElement("p");
    placeholder.className = "transcript-empty";
    placeholder.textContent = "Пока тихо…";
    fragment.appendChild(placeholder);
  }

  transcriptEl.appendChild(fragment);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function transcriptLine(role, text, partial) {
  const line = document.createElement("p");
  line.className = `transcript-line ${role}${partial ? " partial" : ""}`;

  const label = document.createElement("span");
  label.className = "transcript-label";
  label.textContent = role === "child" ? "Ребёнок" : "Тьютор";

  const body = document.createElement("span");
  body.className = "transcript-text";
  body.textContent = text;

  line.appendChild(label);
  line.appendChild(body);
  return line;
}

function startClock() {
  stopClock();
  updateClock();
  state.clockTimer = setInterval(updateClock, 500);
}

function updateClock() {
  setClock(formatClock(Date.now() - state.startedAt));
}

function stopClock() {
  if (state.clockTimer !== null) {
    clearInterval(state.clockTimer);
    state.clockTimer = null;
  }
}

// --- Audio ----------------------------------------------------------------

async function openAudio() {
  if (typeof AudioContext === "undefined") {
    throw new Error("браузер не поддерживает Web Audio");
  }

  const captureCtx = new AudioContext({ latencyHint: "interactive" });
  const playbackCtx = new AudioContext({ latencyHint: "interactive" });
  const resumed = Promise.all([captureCtx.resume(), playbackCtx.resume()]);

  try {
    if (captureCtx.audioWorklet === undefined || playbackCtx.audioWorklet === undefined) {
      throw new Error("браузер не поддерживает AudioWorklet");
    }

    await Promise.all([
      captureCtx.audioWorklet.addModule(WORKLET_URL),
      playbackCtx.audioWorklet.addModule(WORKLET_URL),
    ]);

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    await resumed;

    const source = captureCtx.createMediaStreamSource(stream);
    const captureNode = new AudioWorkletNode(captureCtx, "grow-capture");
    const mute = captureCtx.createGain();
    mute.gain.value = 0;
    source.connect(captureNode);
    captureNode.connect(mute);
    mute.connect(captureCtx.destination);

    const playerNode = new AudioWorkletNode(playbackCtx, "grow-player");
    playerNode.connect(playbackCtx.destination);

    const audio = {
      captureCtx,
      playbackCtx,
      stream,
      source,
      captureNode,
      mute,
      playerNode,
      captureStopped: false,
    };

    captureNode.port.onmessage = (event) => {
      if (state.closing || state.audio !== audio) {
        return;
      }
      const frame = event.data;
      if (frame instanceof ArrayBuffer) {
        state.client?.sendAudio(new Uint8Array(frame));
      }
    };

    playerNode.port.onmessage = (event) => {
      if (state.audio !== audio) {
        return;
      }
      handlePlayerMessage(event.data);
    };

    return audio;
  } catch (error) {
    void captureCtx.close().catch((closeError) => {
      console.warn("could not close the capture context after a setup failure", closeError);
    });
    void playbackCtx.close().catch((closeError) => {
      console.warn("could not close the playback context after a setup failure", closeError);
    });
    throw error;
  }
}

function stopCapture() {
  const audio = state.audio;
  if (audio === null || audio.captureStopped) {
    return;
  }
  audio.captureStopped = true;
  for (const track of audio.stream.getTracks()) {
    track.stop();
  }
  for (const node of [audio.source, audio.captureNode, audio.mute]) {
    try {
      node.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

function closeAudio() {
  stopCapture();
  cancelPlaybackIdle();
  const audio = state.audio;
  state.audio = null;
  if (audio === null) {
    return;
  }
  void audio.captureCtx.close().catch((error) => {
    console.warn("could not close the capture context", error);
  });
  void audio.playbackCtx.close().catch((error) => {
    console.warn("could not close the playback context", error);
  });
}

function flushPlayback() {
  state.audio?.playerNode.port.postMessage({ type: "flush" });
}

function playTutorAudio(bytes) {
  const audio = state.audio;
  if (audio === null) {
    return;
  }
  const evenBytes = bytes.byteLength - (bytes.byteLength % 2);
  if (evenBytes === 0) {
    return;
  }
  // New audio starts a new tutor turn: the queue is no longer drained and the
  // previous turn's turn_complete is stale.
  state.turnCompleteSeen = false;
  state.playbackDrained = false;
  cancelPlaybackIdle();
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, evenBytes / 2);
  const samples = int16ToFloat32(pcm);
  audio.playerNode.port.postMessage({ type: "pcm", samples }, [samples.buffer]);
}

// --- Tutor playback end (PROTOCOL §2 tutor_playback_idle) -----------------

function handlePlayerMessage(data) {
  if (data === null || typeof data !== "object") {
    return;
  }
  if (data.type === "drained") {
    state.playbackDrained = true;
    schedulePlaybackIdle();
  }
}

/**
 * The proxy needs the real end of the tutor's audio, not just turn_complete:
 * only report idle once the proxy's turn_complete arrived AND the player's
 * buffer has stayed empty for the debounce window. `turn_complete` alone is
 * not enough because audio is still queued locally when it arrives.
 */
function schedulePlaybackIdle() {
  if (!state.turnCompleteSeen || !state.playbackDrained) {
    return;
  }
  cancelPlaybackIdle();
  state.playbackIdleTimer = setTimeout(() => {
    state.playbackIdleTimer = null;
    if (!state.turnCompleteSeen || !state.playbackDrained || state.closing) {
      return;
    }
    state.turnCompleteSeen = false;
    state.playbackDrained = false;
    state.client?.sendPlaybackIdle();
  }, PLAYBACK_IDLE_DEBOUNCE_MS);
}

function cancelPlaybackIdle() {
  if (state.playbackIdleTimer !== null) {
    clearTimeout(state.playbackIdleTimer);
    state.playbackIdleTimer = null;
  }
}

function resetPlaybackIdle() {
  cancelPlaybackIdle();
  state.turnCompleteSeen = false;
  state.playbackDrained = false;
}

// --- Canvas taps ----------------------------------------------------------

function handleTenFrameTap(index) {
  if (state.canvas.tenframe === null || state.canvas.tenframe.cells[index]) {
    return;
  }
  state.canvas = tapTenFrame(state.canvas, index);
  canvasView.render(state.canvas);
  state.client?.sendChildAction("tenframe", { index });
}

function handleChoiceTap(card) {
  state.canvas = selectChoice(state.canvas, card.id);
  canvasView.render(state.canvas);
  state.client?.sendChildAction("choice", { id: card.id, label: card.label });
}

// --- Proxy events ---------------------------------------------------------

function handleEvent(message) {
  if (message === null || typeof message !== "object") {
    return;
  }
  switch (message.type) {
    case "transcript":
      state.transcript = applyTranscript(state.transcript, message);
      renderTranscript();
      break;
    case "canvas":
      state.canvas = applyCanvasEvent(state.canvas, message);
      canvasView.render(state.canvas);
      break;
    case "beat":
      state.beat = { beatId: String(message.beatId), outcome: String(message.outcome) };
      // `advance_beat` is a question boundary: the old card highlight no
      // longer answers the current question.
      state.canvas = clearChoiceSelection(state.canvas);
      canvasView.render(state.canvas);
      renderBeat();
      break;
    case "turn":
      if (message.event === "interrupted") {
        flushPlayback();
        resetPlaybackIdle();
      } else if (message.event === "turn_complete") {
        state.turnCompleteSeen = true;
        schedulePlaybackIdle();
      }
      break;
    case "session_saved":
      handleSessionSaved(message);
      break;
    case "after":
      handleAfter(message);
      break;
    case "error":
      setStatus(`Ошибка прокси: ${String(message.message ?? "неизвестная")}`, "error");
      break;
    default:
      // `inject` is sent by U1 but is not part of PROTOCOL §2; ignore it.
      break;
  }
}

function handleSessionSaved(message) {
  if (state.saved) {
    return;
  }
  state.saved = true;
  state.closing = true;
  clearCloseGuard();
  resetPlaybackIdle();
  const failed = message.reason === "no_child_response";
  stopClock();
  stopCapture();
  closeAudio();
  setCloseEnabled(false);
  showScreen("closed");
  newSessionButton.disabled = !state.afterFinal;
  if (!state.afterFinal) {
    setAfterStatus("после сессии: идёт обработка…");
    startAfterPolling();
  }
  if (failed) {
    setStatus(
      "Занятие не состоялось: ребёнок не ответил. Перезапустите, когда будете готовы.",
      "error",
    );
  } else {
    setStatus("Сессия сохранена.", "ok");
  }
  console.info(`session saved: ${String(message.sessionId ?? state.sessionId ?? "")}`);
}

function handleAfter(message) {
  const status =
    message.status === "done" ||
    message.status === "error" ||
    message.status === "skipped"
      ? message.status
      : "running";
  const written = Array.isArray(message.written) ? message.written.map(String) : [];

  if (status === "running") {
    state.afterFinal = false;
    setAfterStatus("после сессии: идёт обработка…");
    newSessionButton.disabled = true;
    return;
  }

  state.afterFinal = true;
  stopAfterPolling();
  if (status === "skipped") {
    setAfterStatus("после сессии: пропущено — занятие не состоялось", true);
    newSessionButton.disabled = false;
    return;
  }
  if (status === "done") {
    const suffix = written.length > 0 ? ` (${written.join(", ")})` : "";
    setAfterStatus(`после сессии: готово${suffix}`);
    newSessionButton.disabled = false;
  } else {
    setAfterStatus("после сессии: ошибка", true);
    newSessionButton.disabled = false;
  }
}

// --- After-loop polling ---------------------------------------------------

function startAfterPolling() {
  stopAfterPolling();
  state.pollAttempts = 0;
  state.pollTimer = setInterval(() => {
    void pollAfter();
  }, AFTER_POLL_MS);
}

function stopAfterPolling() {
  if (state.pollTimer !== null) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollAfter() {
  if (state.afterFinal || state.client === null || state.sessionId === null) {
    stopAfterPolling();
    return;
  }
  state.pollAttempts += 1;
  try {
    const result = await state.client.getSessionStatus(state.sessionId);
    if (
      !state.saved &&
      (result.afterStatus === "done" ||
        result.afterStatus === "error" ||
        result.afterStatus === "skipped")
    ) {
      handleSessionSaved({
        reason: result.reason ?? "child_tap",
        sessionId: state.sessionId,
      });
    }
    handleAfter({ status: result.afterStatus, written: result.written });
  } catch (error) {
    console.warn("after-status poll failed", error);
  }

  if (!state.afterFinal && state.pollAttempts >= AFTER_POLL_LIMIT) {
    stopAfterPolling();
    if (!state.saved) {
      returnToLanding("Не удалось подтвердить сохранение сессии.", "error");
    }
  }
}

// --- Recent workspaces (PROTOCOL §2) --------------------------------------

/**
 * Prefill the workspace field from the proxy's recent list (most recent first)
 * and reveal the picker once there are at least two. The route is optional
 * polish: a failure leaves the landing form exactly as it was.
 */
async function loadRecents() {
  try {
    const response = await fetch(RECENTS_URL);
    if (!response.ok) {
      return;
    }
    const payload = await response.json();
    const paths = recentPaths(payload);
    if (paths.length === 0) {
      return;
    }
    workspaceInput.value = paths[0];
    recentSelect.textContent = "";
    for (const path of paths) {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      recentSelect.appendChild(option);
    }
    recentRow.hidden = paths.length < 2;
  } catch (error) {
    console.warn("could not load recent workspaces", error);
  }
}

function recentPaths(payload) {
  if (payload === null || typeof payload !== "object" || !Array.isArray(payload.recents)) {
    return [];
  }
  return payload.recents
    .filter((recent) => recent !== null && typeof recent === "object")
    .map((recent) => recent.path)
    .filter((path) => typeof path === "string" && path.length > 0);
}

// --- Session lifecycle ----------------------------------------------------

function resetSessionUi() {
  state.canvas = initialCanvasState();
  state.transcript = initialTranscriptState();
  state.beat = null;
  state.closing = false;
  state.saved = false;
  state.afterFinal = false;
  state.pollAttempts = 0;
  resetPlaybackIdle();
  canvasView.render(state.canvas);
  renderTranscript();
  renderBeat();
  setClock("00:00");
  setAfterStatus("после сессии: —");
  newSessionButton.disabled = true;
  // A previous session disabled this on save; a live session must always be
  // closeable from the child UI (U14.2).
  clearCloseGuard();
  setCloseEnabled(true);
}

async function startSession() {
  if (startButton.disabled) {
    return;
  }
  const workspacePath = workspaceInput.value.trim();
  if (workspacePath.length === 0) {
    setStatus("Укажите путь к папке занятия.", "error");
    return;
  }

  localStorage.setItem(WORKSPACE_STORAGE_KEY, workspacePath);
  startButton.disabled = true;
  setStatus("Разрешаем микрофон…");

  resetSessionUi();
  state.sessionId = null;
  let audioError = null;
  state.client = createProxyClient({
    onEvent: handleEvent,
    onAudio: playTutorAudio,
    onOpen: () => {
      setStatus(audioError ?? "Занятие идёт", audioError === null ? "ok" : "error");
      // The client is attached: a live session must be closeable even if a
      // previous session's save left the button disabled.
      if (!state.saved && !state.closing) {
        setCloseEnabled(true);
      }
    },
    onClose: handleSocketClose,
    onError: (message) => setStatus(message, "error"),
  });

  // A missing microphone or AudioWorklet must not stop the session: the canvas
  // and transcripts still work, and the status line carries the warning.
  try {
    state.audio = await openAudio();
  } catch (error) {
    audioError = describeAudioError(error);
    console.warn("audio unavailable; continuing without capture", error);
  }

  try {
    setStatus("Готовим занятие…");

    const started = await state.client.start(workspacePath);
    state.sessionId = started.sessionId;
    state.client.connect(started.sessionId);

    showScreen("session");
    setCloseEnabled(true);
    state.startedAt = Date.now();
    startClock();
    setStatus(audioError ?? "Подключаемся…", audioError === null ? "info" : "error");
  } catch (error) {
    await abandonStart(error);
  }
}

async function abandonStart(error) {
  const message = describeStartError(error);
  if (state.sessionId !== null && state.client !== null) {
    try {
      await state.client.closeHttp("child_tap");
    } catch (closeError) {
      console.warn("could not close the unstarted session", closeError);
    }
  }
  state.client?.disconnect();
  state.client = null;
  state.sessionId = null;
  closeAudio();
  showScreen("landing");
  startButton.disabled = false;
  setStatus(message, "error");
}

function describeAudioError(error) {
  if (error instanceof Error) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Нет доступа к микрофону. Занятие идёт без звука.";
    }
    if (error.name === "NotFoundError") {
      return "Микрофон не найден. Занятие идёт без звука.";
    }
    return `Аудио недоступно: ${error.message}`;
  }
  return `Аудио недоступно: ${String(error)}`;
}

function describeStartError(error) {
  if (error instanceof Error) {
    return `Ошибка запуска: ${error.message}`;
  }
  return `Ошибка запуска: ${String(error)}`;
}

async function closeSession() {
  if (state.closing || state.sessionId === null || state.client === null) {
    return;
  }
  state.closing = true;
  setCloseEnabled(false);
  armCloseGuard();
  stopCapture();
  setStatus("Завершаем занятие…");

  // The child's close button sends the bare WS message (PROTOCOL §2). If the
  // socket is gone, fall back to the equivalent HTTP route.
  if (state.client.requestClose()) {
    return;
  }

  try {
    await state.client.closeHttp("child_tap");
    handleSessionSaved({ reason: "child_tap", sessionId: state.sessionId });
  } catch (error) {
    clearCloseGuard();
    state.closing = false;
    setCloseEnabled(true);
    setStatus(
      `Не удалось завершить занятие: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

function handleSocketClose() {
  if (state.saved) {
    return;
  }
  if (state.closing) {
    // The close may already be finalizing server-side; the guard re-enables
    // the button if the confirmation never arrives.
    setStatus("Соединение закрыто. Проверяем сохранение…");
    startAfterPolling();
    return;
  }
  // With the socket gone, POST /api/close is the fallback path: keep the
  // button usable.
  clearCloseGuard();
  setCloseEnabled(true);
  setStatus("Соединение с прокси закрыто.", "error");
  stopCapture();
  closeAudio();
}

function returnToLanding(message = "Готово.", tone = "info") {
  state.client?.disconnect();
  state.client = null;
  state.sessionId = null;
  stopClock();
  stopAfterPolling();
  closeAudio();
  resetSessionUi();
  showScreen("landing");
  startButton.disabled = false;
  setStatus(message, tone);
}

// --- Wiring ---------------------------------------------------------------

workspaceInput.value = localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
recentSelect.addEventListener("change", () => {
  if (recentSelect.value.length > 0) {
    workspaceInput.value = recentSelect.value;
  }
});
void loadRecents();
startButton.addEventListener("click", () => void startSession());
workspaceInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    void startSession();
  }
});
closeButton.addEventListener("click", () => void closeSession());
newSessionButton.addEventListener("click", () => {
  if (newSessionButton.disabled) {
    return;
  }
  returnToLanding("Готово к новому занятию.");
});
exitButton.addEventListener("click", () => returnToLanding("Готово."));

resetSessionUi();
showScreen("landing");
setStatus("Готово.");
