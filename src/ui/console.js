// Grow parent console client. Talks only to the local proxy (PROTOCOL §10).
// Module shape: no exports; this page is the entry point loaded by
// console.html and wires itself to the DOM on import.
//
//   POST /api/console/chat    {message}              -> {reply, actions}
//   GET  /api/console/config                         -> {tutor, curriculum, permissions, presets}
//   GET  /api/console/files                          -> {diary, report, lesson}
//   POST /api/console/config  {path, content}        -> {diff}
//   GET  /api/console/state                          -> {activeSession, workspace}
//   POST /api/console/preset  {name}                 -> {diff, applied}
//   POST /api/close           {sessionId, reason}    -> {sessionFolder}
//
// The optional `workspace` query/body field is a console-page addition so the
// parent can open a folder before any child session exists; the proxy also
// falls back to the last session folder or GROW_WORKSPACE.

import { applyDocument, loadLocale, t } from "./locale.js";

const WORKSPACE_STORAGE_KEY = "grow.consoleWorkspace";
const RECENTS_URL = "/api/workspaces/recent";
const STATE_POLL_MS = 2000;

const CONFIG_PATHS = {
  tutor: "config/tutor.md",
  curriculum: "config/curriculum.md",
};

function must(id) {
  const element = document.getElementById(id);
  if (element === null) {
    throw new Error(`missing element #${id}`);
  }
  return element;
}

const els = {
  status: must("status"),
  workspaceInput: must("workspace-input"),
  workspaceOpen: must("workspace-open"),
  recentRow: must("recent-row"),
  recentSelect: must("recent-select"),
  closeSession: must("close-session-button"),
  chatLog: must("chat-log"),
  chatForm: must("chat-form"),
  chatInput: must("chat-input"),
  chatSend: must("chat-send"),
  configTabs: must("config-tabs"),
  configEditor: must("config-editor"),
  configSave: must("config-save"),
  configHint: must("config-hint"),
  presetList: must("preset-list"),
  sideTabs: must("side-tabs"),
  sideDiff: must("side-diff"),
  sideMd: must("side-md"),
};

const state = {
  config: { tutor: null, curriculum: null, permissions: null, presets: [] },
  files: { diary: null, report: null, lesson: null },
  configFile: "tutor",
  configDirty: false,
  sideView: "diff",
  activeSession: null,
  busy: false,
};

// --- Proxy calls -----------------------------------------------------------

function workspace() {
  return els.workspaceInput.value.trim();
}

function rememberWorkspace() {
  const value = workspace();
  if (value.length > 0) {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, value);
  } else {
    localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  }
}

/**
 * Prefill the workspace field from the proxy's recent list (PROTOCOL §2) and
 * reveal the picker once there are at least two. Optional polish: a failure
 * leaves the existing localStorage value untouched.
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
    els.workspaceInput.value = paths[0];
    els.recentSelect.textContent = "";
    for (const path of paths) {
      const option = document.createElement("option");
      option.value = path;
      option.textContent = path;
      els.recentSelect.appendChild(option);
    }
    els.recentRow.hidden = paths.length < 2;
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

async function api(path, options = {}) {
  const url = new URL(path, location.origin);
  const currentWorkspace = workspace();
  if (currentWorkspace.length > 0) {
    url.searchParams.set("workspace", currentWorkspace);
  }

  const init = { method: options.method ?? "GET", headers: {} };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify({
      ...options.body,
      workspace: currentWorkspace.length > 0 ? currentWorkspace : undefined,
    });
  }

  const response = await fetch(url, init);
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error bodies are reported via the HTTP status below.
  }
  if (!response.ok) {
    const message =
      typeof payload.error === "string" ? payload.error : t("console.error", { status: response.status });
    throw new Error(message);
  }
  return payload;
}

function setStatus(text, tone = "info") {
  els.status.textContent = text;
  els.status.dataset.tone = tone;
}

function ensureWorkspace() {
  if (workspace().length === 0) {
    setStatus(t("console.workspaceRequired"), "error");
    els.workspaceInput.focus();
    return false;
  }
  return true;
}

// --- Chat ------------------------------------------------------------------

function appendChat(role, text, actions = []) {
  const empty = els.chatLog.querySelector(".chat-empty");
  if (empty !== null) {
    empty.remove();
  }

  const message = document.createElement("div");
  message.className = `chat-message ${role}`;

  const label = document.createElement("span");
  label.className = "chat-label";
  label.textContent = role === "user" ? t("console.roleParent") : t("console.roleManager");
  message.appendChild(label);
  message.appendChild(document.createTextNode(text));

  if (actions.length > 0) {
    const tools = document.createElement("span");
    tools.className = "chat-actions";
    tools.textContent = t("console.tools", {
      list: actions.map((action) => action.tool).join(", "),
    });
    message.appendChild(tools);
  }

  els.chatLog.appendChild(message);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

function setBusy(busy) {
  state.busy = busy;
  els.chatSend.disabled = busy;
  els.chatSend.textContent = busy ? t("console.thinking") : t("console.send");
}

async function sendChat(event) {
  event.preventDefault();
  const message = els.chatInput.value.trim();
  if (message.length === 0 || state.busy || !ensureWorkspace()) {
    return;
  }

  appendChat("user", message);
  els.chatInput.value = "";
  setBusy(true);
  setStatus(t("console.thinkingStatus"));

  try {
    const result = await api("/api/console/chat", { method: "POST", body: { message } });
    const actions = Array.isArray(result.actions) ? result.actions : [];
    appendChat("manager", String(result.reply ?? t("console.done")), actions);

    const changed = actions.find(
      (action) =>
        action.result !== null &&
        typeof action.result === "object" &&
        typeof action.result.diff === "string" &&
        action.result.diff.length > 0,
    );
    if (changed !== undefined) {
      showDiff(changed.result.diff);
      // The manager wrote a config file; show the server version, not a stale
      // unsaved editor buffer.
      state.configDirty = false;
    }
    await refreshConfig();
    await refreshFiles();
    setStatus(t("console.done"), "ok");
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    setStatus(t("console.errorPrefix", { message: messageText }), "error");
    appendChat("manager", t("console.chatFailed", { message: messageText }));
  } finally {
    setBusy(false);
    els.chatInput.focus();
  }
}

// --- Config viewer / editor -------------------------------------------------

function selectConfig(file) {
  state.configFile = file;
  state.configDirty = false;
  for (const tab of els.configTabs.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.file === file);
  }

  const readOnly = file === "permissions";
  els.configEditor.value = state.config[file] ?? "";
  els.configEditor.readOnly = readOnly;
  els.configSave.disabled = readOnly;
  els.configHint.textContent = readOnly ? t("console.readOnly") : "";
}

async function refreshConfig() {
  const config = await api("/api/console/config");
  state.config = {
    tutor: typeof config.tutor === "string" ? config.tutor : null,
    curriculum: typeof config.curriculum === "string" ? config.curriculum : null,
    permissions: typeof config.permissions === "string" ? config.permissions : null,
    presets: Array.isArray(config.presets) ? config.presets.map(String) : [],
  };
  if (!state.configDirty) {
    selectConfig(state.configFile);
  }
  renderPresets();
}

async function saveConfig() {
  const path = CONFIG_PATHS[state.configFile];
  if (path === undefined || state.busy) {
    return;
  }
  setStatus(t("console.savingConfig"));
  try {
    const result = await api("/api/console/config", {
      method: "POST",
      body: { path, content: els.configEditor.value },
    });
    state.config[state.configFile] = els.configEditor.value;
    state.configDirty = false;
    showDiff(typeof result.diff === "string" ? result.diff : "");
    setStatus(t("console.savedConfig"), "ok");
  } catch (error) {
    setStatus(
      t("console.saveFailed", {
        message: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  }
}

function renderPresets() {
  els.presetList.textContent = "";
  if (state.config.presets.length === 0) {
    const empty = document.createElement("p");
    empty.className = "preset-empty";
    empty.textContent = t("console.noPresets");
    els.presetList.appendChild(empty);
    return;
  }

  for (const name of state.config.presets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-button";
    button.textContent = name.replace(/\.md$/i, "");
    button.title = name;
    button.addEventListener("click", () => void applyPreset(name));
    els.presetList.appendChild(button);
  }
}

async function applyPreset(name) {
  if (!ensureWorkspace() || state.busy) {
    return;
  }
  setStatus(t("console.applyingPreset", { name: name.replace(/\.md$/i, "") }));
  try {
    const result = await api("/api/console/preset", { method: "POST", body: { name } });
    showDiff(typeof result.diff === "string" ? result.diff : "");
    state.configDirty = false;
    await refreshConfig();
    setStatus(t("console.presetApplied", { name: name.replace(/\.md$/i, "") }), "ok");
  } catch (error) {
    setStatus(
      t("console.presetFailed", {
        message: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  }
}

// --- Side panel -------------------------------------------------------------

function classifyDiffLine(line) {
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "meta";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "context";
}

function showDiff(diff) {
  selectSide("diff");
  els.sideDiff.textContent = "";

  if (typeof diff !== "string" || diff.length === 0) {
    const empty = document.createElement("p");
    empty.className = "side-empty";
    empty.textContent = t("console.noChangesInline");
    els.sideDiff.appendChild(empty);
    return;
  }

  const pre = document.createElement("pre");
  for (const line of diff.replace(/\n$/, "").split("\n")) {
    const row = document.createElement("div");
    row.className = `diff-line ${classifyDiffLine(line)}`;
    row.textContent = line;
    pre.appendChild(row);
  }
  els.sideDiff.appendChild(pre);
}

async function refreshFiles() {
  const files = await api("/api/console/files");
  state.files = {
    diary: entryOrNull(files.diary),
    report: entryOrNull(files.report),
    lesson: entryOrNull(files.lesson),
  };
  if (state.sideView !== "diff") {
    renderSideFile(state.sideView);
  }
}

function entryOrNull(value) {
  if (value === null || typeof value !== "object") {
    return null;
  }
  if (typeof value.path !== "string" || typeof value.content !== "string") {
    return null;
  }
  return { path: value.path, content: value.content };
}

function selectSide(view) {
  state.sideView = view;
  for (const tab of els.sideTabs.querySelectorAll(".tab")) {
    tab.classList.toggle("active", tab.dataset.view === view);
  }
  const isDiff = view === "diff";
  els.sideDiff.hidden = !isDiff;
  els.sideMd.hidden = isDiff;
  if (!isDiff) {
    renderSideFile(view);
  }
}

function renderSideFile(view) {
  const entry = state.files[view];
  els.sideMd.textContent = "";

  if (entry === null) {
    const empty = document.createElement("p");
    empty.className = "side-empty";
    empty.textContent = t("console.fileNotFound");
    els.sideMd.appendChild(empty);
    return;
  }

  const path = document.createElement("p");
  path.className = "side-empty";
  path.textContent = entry.path;
  els.sideMd.appendChild(path);
  els.sideMd.insertAdjacentHTML("beforeend", renderMarkdown(entry.content));
}

// Minimal, escaping-first markdown renderer: headings, lists, bold, italic,
// inline code, paragraphs. Enough for diary/report/plan previews; no library.
function renderMarkdown(markdown) {
  const lines = escapeHtml(markdown).split("\n");
  const html = [];
  let list = null;

  const closeList = () => {
    if (list !== null) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading !== null) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      if (list !== "ul") {
        closeList();
        html.push("<ul>");
        list = "ul";
      }
      html.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered !== null) {
      if (list !== "ol") {
        closeList();
        html.push("<ol>");
        list = "ol";
      }
      html.push(`<li>${inlineMarkdown(numbered[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  return html.join("");
}

function inlineMarkdown(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// --- State and live session -------------------------------------------------

async function refreshState() {
  const result = await api("/api/console/state");
  state.activeSession =
    typeof result.activeSession === "string" ? result.activeSession : null;
  els.closeSession.hidden = state.activeSession === null;
  if (workspace().length === 0 && typeof result.workspace === "string" && result.workspace.length > 0) {
    els.workspaceInput.value = result.workspace;
    rememberWorkspace();
  }
}

async function pollState() {
  try {
    await refreshState();
  } catch {
    // A transient poll failure must not spam the status line.
  }
}

async function closeSession() {
  const sessionId = state.activeSession;
  if (sessionId === null) {
    return;
  }
  const confirmed = window.confirm(t("console.closeConfirm", { id: sessionId }));
  if (!confirmed) {
    return;
  }

  els.closeSession.disabled = true;
  setStatus(t("console.ending"));
  try {
    const result = await api("/api/close", {
      method: "POST",
      body: { sessionId, reason: "parent_console" },
    });
    setStatus(t("console.ended", { folder: String(result.sessionFolder ?? sessionId) }), "ok");
    await refreshState();
    await refreshFiles();
  } catch (error) {
    setStatus(
      t("console.endFailed", {
        message: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  } finally {
    els.closeSession.disabled = false;
  }
}

// --- Wiring -----------------------------------------------------------------

async function refreshAll() {
  if (!ensureWorkspace()) {
    return;
  }
  setStatus(t("console.reading"));
  try {
    await refreshState();
    await refreshConfig();
    await refreshFiles();
    setStatus(t("console.opened"), "ok");
  } catch (error) {
    setStatus(
      t("console.errorPrefix", {
        message: error instanceof Error ? error.message : String(error),
      }),
      "error",
    );
  }
}

function openWorkspace() {
  rememberWorkspace();
  void refreshAll();
}

els.workspaceInput.value = localStorage.getItem(WORKSPACE_STORAGE_KEY) ?? "";
els.recentSelect.addEventListener("change", () => {
  if (els.recentSelect.value.length > 0) {
    els.workspaceInput.value = els.recentSelect.value;
  }
});
els.workspaceOpen.addEventListener("click", openWorkspace);
els.workspaceInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    openWorkspace();
  }
});
els.chatForm.addEventListener("submit", (event) => void sendChat(event));
els.configEditor.addEventListener("input", () => {
  state.configDirty = true;
});
els.configSave.addEventListener("click", () => void saveConfig());
els.configTabs.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const file = target.dataset.file;
  if (file !== undefined) {
    selectConfig(file);
  }
});
els.sideTabs.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const view = target.dataset.view;
  if (view !== undefined) {
    selectSide(view);
  }
});
els.closeSession.addEventListener("click", () => void closeSession());

selectConfig("tutor");
void (async () => {
  await loadLocale();
  applyDocument();
  selectConfig(state.configFile);
  await loadRecents();
  try {
    await refreshState();
  } catch {
    // No workspace yet: the status line below asks for one.
  }
  if (workspace().length > 0) {
    await refreshAll();
  } else {
    setStatus(t("console.openPrompt"), "info");
  }
  setInterval(() => void pollState(), STATE_POLL_MS);
})();
