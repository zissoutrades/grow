// UI locale dictionary and boot-time switch (handoff 2026-11-01).
//
// The proxy is one static file server, so the browser cannot read
// `GROW_LOCALE`. On boot each page asks `GET /api/locale`, then rewrites the
// marked DOM text and exposes `t()` for dynamic strings. Russian is the
// default and the exact current copy; English is the demo locale.
//
// Markup keys (no layout or class changes):
//   data-i18n              -> textContent
//   data-i18n-placeholder  -> placeholder
//   data-i18n-aria-label   -> aria-label

export const LOCALE_URL = "/api/locale";

const RU = {
  "title.app": "Grow — занятие",
  "title.console": "Grow — консоль родителя",

  "beat.recall": "вспоминаем",
  "beat.present": "объясняем",
  "beat.attempt": "пробуем",
  "beat.diagnose": "разбираемся",
  "beat.repair": "исправляем",
  "beat.extend": "расширяем",
  "beat.consolidate": "закрепляем",
  "beat.reflect": "подводим итог",
  "beat.close": "прощаемся",
  "beat.line": "этап: {label} · {outcome}",
  "beat.none": "этап: —",
  "outcome.ok": "ок",
  "outcome.struggle": "трудно",
  "outcome.skip": "пропуск",

  "transcript.empty": "Пока тихо…",
  "transcript.child": "Ребёнок",
  "transcript.tutor": "Тьютор",
  "transcript.title": "Разговор",

  "canvas.empty": "холст пуст",
  "canvas.tenframe": "Рамка из десяти",
  "canvas.numberline": "Числовая прямая",
  "canvas.choices": "Выбери ответ",
  "canvas.filled": "заполнено: {filled} из 10",
  "canvas.cell": "клетка {index}",
  "canvas.cellFilled": "клетка {index}, заполнена",
  "canvas.numberlineRange": "числовая прямая от {min} до {max}",
  "canvas.numberlineMarker": "числовая прямая от {min} до {max}, отметка {marker}",

  "topbar.console": "Консоль родителя",
  "landing.title": "Занятие с тьютором",
  "landing.lede":
    "Укажите папку занятия. Тьютор прочитает конфиг, память и план урока из этих файлов.",
  "landing.workspace": "Папка занятия",
  "landing.recent": "Недавние:",
  "landing.recentAria": "Недавние папки",
  "landing.start": "Начать занятие",
  "landing.hint":
    "Микрофон включится сразу. Всё остальное — голосом и нажатиями на холсте.",
  "session.close": "Завершить занятие",
  "closed.title": "сессия сохранена",
  "closed.new": "Новое занятие",
  "closed.exit": "выйти",

  "after.idle": "после сессии: —",
  "after.processing": "после сессии: идёт обработка…",
  "after.skipped": "после сессии: пропущено — занятие не состоялось",
  "after.done": "после сессии: готово{details}",
  "after.error": "после сессии: ошибка",

  "status.ready": "Готово.",
  "status.done": "Готово.",
  "status.loading": "Загрузка…",
  "status.proxyError": "Ошибка прокси: {message}",
  "status.proxyUnknown": "неизвестная",
  "status.sessionFailed":
    "Занятие не состоялось: ребёнок не ответил. Перезапустите, когда будете готовы.",
  "status.saved": "Сессия сохранена.",
  "status.confirmFailed": "Не удалось подтвердить сохранение сессии.",
  "status.workspaceRequired": "Укажите путь к папке занятия.",
  "status.mic": "Разрешаем микрофон…",
  "status.live": "Занятие идёт",
  "status.preparing": "Готовим занятие…",
  "status.connecting": "Подключаемся…",
  "status.ending": "Завершаем занятие…",
  "status.closeFailed": "Не удалось завершить занятие: {message}",
  "status.closeTimeout": "Завершение затянулось. Попробуйте ещё раз.",
  "status.socketChecking": "Соединение закрыто. Проверяем сохранение…",
  "status.socketClosed": "Соединение с прокси закрыто.",
  "status.newReady": "Готово к новому занятию.",

  "audio.webAudio": "браузер не поддерживает Web Audio",
  "audio.worklet": "браузер не поддерживает AudioWorklet",
  "audio.denied": "Нет доступа к микрофону. Занятие идёт без звука.",
  "audio.notFound": "Микрофон не найден. Занятие идёт без звука.",
  "audio.unavailable": "Аудио недоступно: {message}",
  "start.failed": "Ошибка запуска: {message}",

  "proxy.startFailed": "запуск не удался ({status})",
  "proxy.noSessionId": "прокси не вернул sessionId",
  "proxy.noSessionConnect": "нет сессии для подключения",
  "proxy.badJson": "прокси прислал некорректный JSON",
  "proxy.unknownMessage": "прокси прислал неизвестный тип сообщения",
  "proxy.unreachable": "соединение с прокси недоступно",
  "proxy.noSessionClose": "нет сессии для завершения",
  "proxy.closeFailed": "завершение не удалось ({status})",
  "proxy.noSession": "нет сессии",
  "proxy.statusFailed": "статус не получен ({status})",

  "console.brand": "Grow · консоль родителя",
  "console.sessionLink": "Занятие",
  "console.close": "Завершить занятие",
  "console.workspaceSection": "Папка занятия",
  "console.workspaceLabel": "Папка занятия",
  "console.recent": "Недавние:",
  "console.recentAria": "Недавние папки",
  "console.open": "Открыть",
  "console.chatSection": "Чат с менеджером",
  "console.chatTitle": "Чат с менеджером",
  "console.chatEmpty": "Спросите, что изменить в занятии…",
  "console.chatPlaceholder": "Например: сделай тьютора мягче и короче",
  "console.send": "Отправить",
  "console.configSection": "Конфигурация",
  "console.configTitle": "Конфигурация",
  "console.tab.tutor": "тьютор",
  "console.tab.curriculum": "программа",
  "console.tab.permissions": "права",
  "console.save": "Сохранить",
  "console.presets": "Пресеты",
  "console.sideSection": "Панель",
  "console.sideTitle": "Панель",
  "console.tab.diff": "разница",
  "console.tab.diary": "дневник",
  "console.tab.report": "отчёт",
  "console.tab.lesson": "план",
  "console.noChanges": "Изменений пока нет.",
  "console.error": "ошибка {status}",
  "console.workspaceRequired": "Укажите папку занятия.",
  "console.roleParent": "Родитель",
  "console.roleManager": "Менеджер",
  "console.tools": "инструменты: {list}",
  "console.thinking": "Думает…",
  "console.thinkingStatus": "Менеджер думает…",
  "console.done": "Готово.",
  "console.errorPrefix": "Ошибка: {message}",
  "console.chatFailed": "Не удалось выполнить: {message}",
  "console.readOnly": "только чтение",
  "console.savingConfig": "Сохраняем конфигурацию…",
  "console.savedConfig": "Конфигурация сохранена.",
  "console.saveFailed": "Не удалось сохранить: {message}",
  "console.noPresets": "Пресетов нет.",
  "console.applyingPreset": "Применяем пресет «{name}»…",
  "console.presetApplied": "Пресет «{name}» применён.",
  "console.presetFailed": "Не удалось применить пресет: {message}",
  "console.noChangesInline": "Изменений нет.",
  "console.fileNotFound": "Файл не найден.",
  "console.closeConfirm":
    "Завершить занятие {id}? Ребёнок больше не сможет его продолжить.",
  "console.ending": "Завершаем занятие…",
  "console.ended": "Занятие завершено: {folder}",
  "console.endFailed": "Не удалось завершить занятие: {message}",
  "console.reading": "Читаем папку…",
  "console.opened": "Папка открыта.",
  "console.openPrompt": "Укажите папку занятия, чтобы открыть консоль.",
};

const EN = {
  "title.app": "Grow — session",
  "title.console": "Grow — parent console",

  "beat.recall": "recalling",
  "beat.present": "explaining",
  "beat.attempt": "trying",
  "beat.diagnose": "figuring out",
  "beat.repair": "fixing",
  "beat.extend": "extending",
  "beat.consolidate": "consolidating",
  "beat.reflect": "reflecting",
  "beat.close": "closing",
  "beat.line": "beat: {label} · {outcome}",
  "beat.none": "beat: —",
  "outcome.ok": "ok",
  "outcome.struggle": "tricky",
  "outcome.skip": "skipped",

  "transcript.empty": "Quiet for now…",
  "transcript.child": "Child",
  "transcript.tutor": "Tutor",
  "transcript.title": "Conversation",

  "canvas.empty": "canvas is empty",
  "canvas.tenframe": "Ten-frame",
  "canvas.numberline": "Number line",
  "canvas.choices": "Choose an answer",
  "canvas.filled": "filled: {filled} of 10",
  "canvas.cell": "cell {index}",
  "canvas.cellFilled": "cell {index}, filled",
  "canvas.numberlineRange": "number line from {min} to {max}",
  "canvas.numberlineMarker": "number line from {min} to {max}, marker {marker}",

  "topbar.console": "Parent console",
  "landing.title": "Tutor session",
  "landing.lede":
    "Choose a session folder. The tutor reads the config, memory and lesson plan from these files.",
  "landing.workspace": "Session folder",
  "landing.recent": "Recent:",
  "landing.recentAria": "Recent folders",
  "landing.start": "Start session",
  "landing.hint":
    "The microphone opens right away. Everything else is voice and taps on the canvas.",
  "session.close": "End session",
  "closed.title": "session saved",
  "closed.new": "New session",
  "closed.exit": "exit",

  "after.idle": "after session: —",
  "after.processing": "after session: processing…",
  "after.skipped": "after session: skipped — the session didn't happen",
  "after.done": "after session: done{details}",
  "after.error": "after session: error",

  "status.ready": "Ready.",
  "status.done": "Done.",
  "status.loading": "Loading…",
  "status.proxyError": "Proxy error: {message}",
  "status.proxyUnknown": "unknown",
  "status.sessionFailed":
    "The session didn't happen: the child didn't answer. Start again when you're ready.",
  "status.saved": "Session saved.",
  "status.confirmFailed": "Couldn't confirm the session was saved.",
  "status.workspaceRequired": "Enter a session folder.",
  "status.mic": "Requesting the microphone…",
  "status.live": "Session live",
  "status.preparing": "Preparing the session…",
  "status.connecting": "Connecting…",
  "status.ending": "Ending the session…",
  "status.closeFailed": "Couldn't end the session: {message}",
  "status.closeTimeout": "Ending is taking too long. Try again.",
  "status.socketChecking": "Connection closed. Checking the save…",
  "status.socketClosed": "Connection to the proxy closed.",
  "status.newReady": "Ready for a new session.",

  "audio.webAudio": "this browser does not support Web Audio",
  "audio.worklet": "this browser does not support AudioWorklet",
  "audio.denied": "No microphone access. The session continues without sound.",
  "audio.notFound": "No microphone found. The session continues without sound.",
  "audio.unavailable": "Audio unavailable: {message}",
  "start.failed": "Start failed: {message}",

  "proxy.startFailed": "start failed ({status})",
  "proxy.noSessionId": "the proxy did not return a sessionId",
  "proxy.noSessionConnect": "no session to connect",
  "proxy.badJson": "the proxy sent invalid JSON",
  "proxy.unknownMessage": "the proxy sent an unknown message type",
  "proxy.unreachable": "could not reach the proxy",
  "proxy.noSessionClose": "no session to end",
  "proxy.closeFailed": "could not end the session ({status})",
  "proxy.noSession": "no session",
  "proxy.statusFailed": "could not get status ({status})",

  "console.brand": "Grow · parent console",
  "console.sessionLink": "Session",
  "console.close": "End session",
  "console.workspaceSection": "Session folder",
  "console.workspaceLabel": "Session folder",
  "console.recent": "Recent:",
  "console.recentAria": "Recent folders",
  "console.open": "Open",
  "console.chatSection": "Manager chat",
  "console.chatTitle": "Manager chat",
  "console.chatEmpty": "Ask what to change in the session…",
  "console.chatPlaceholder": "For example: make the tutor warmer and shorter",
  "console.send": "Send",
  "console.configSection": "Configuration",
  "console.configTitle": "Configuration",
  "console.tab.tutor": "tutor",
  "console.tab.curriculum": "curriculum",
  "console.tab.permissions": "permissions",
  "console.save": "Save",
  "console.presets": "Presets",
  "console.sideSection": "Panel",
  "console.sideTitle": "Panel",
  "console.tab.diff": "diff",
  "console.tab.diary": "diary",
  "console.tab.report": "report",
  "console.tab.lesson": "plan",
  "console.noChanges": "No changes yet.",
  "console.error": "error {status}",
  "console.workspaceRequired": "Enter a session folder.",
  "console.roleParent": "Parent",
  "console.roleManager": "Manager",
  "console.tools": "tools: {list}",
  "console.thinking": "Thinking…",
  "console.thinkingStatus": "The manager is thinking…",
  "console.done": "Done.",
  "console.errorPrefix": "Error: {message}",
  "console.chatFailed": "Couldn't run that: {message}",
  "console.readOnly": "read only",
  "console.savingConfig": "Saving the configuration…",
  "console.savedConfig": "Configuration saved.",
  "console.saveFailed": "Couldn't save: {message}",
  "console.noPresets": "No presets.",
  "console.applyingPreset": "Applying preset “{name}”…",
  "console.presetApplied": "Preset “{name}” applied.",
  "console.presetFailed": "Couldn't apply the preset: {message}",
  "console.noChangesInline": "No changes.",
  "console.fileNotFound": "File not found.",
  "console.closeConfirm":
    "End session {id}? The child will not be able to continue it.",
  "console.ending": "Ending the session…",
  "console.ended": "Session ended: {folder}",
  "console.endFailed": "Couldn't end the session: {message}",
  "console.reading": "Reading the folder…",
  "console.opened": "Folder opened.",
  "console.openPrompt": "Enter a session folder to open the console.",
};

/** Both dictionaries; exported for the locale tests. */
export const LOCALE_DICTIONARIES = { ru: RU, en: EN };

/** Anything other than the exact value `en` behaves as the Russian default. */
export function normalizeLocale(value) {
  return value === "en" ? "en" : "ru";
}

let current = "ru";

export function setLocale(locale) {
  current = normalizeLocale(locale);
  return current;
}

export function getLocale() {
  return current;
}

/** Translate one key in an explicit locale (pure; used by the tests). */
export function translateFor(locale, key, vars = {}) {
  const dictionary = LOCALE_DICTIONARIES[normalizeLocale(locale)];
  const template = dictionary[key] ?? RU[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  );
}

/** Translate one key in the locale chosen at boot. */
export function t(key, vars) {
  return translateFor(current, key, vars);
}

/** Ask the running proxy which locale it uses; failures keep Russian. */
export async function loadLocale() {
  let locale = "ru";
  try {
    const response = await fetch(LOCALE_URL);
    if (response.ok) {
      const payload = await response.json();
      locale = normalizeLocale(payload.locale);
    }
  } catch {
    // Static-file dev tools or an older proxy: keep the Russian default.
  }
  return setLocale(locale);
}

/** Rewrite all marked text in the page to the current locale. */
export function applyDocument(doc = globalThis.document) {
  if (doc === undefined || doc === null) {
    return;
  }
  doc.documentElement.lang = current;
  for (const element of doc.querySelectorAll("[data-i18n]")) {
    element.textContent = t(element.dataset.i18n);
  }
  for (const element of doc.querySelectorAll("[data-i18n-placeholder]")) {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder));
  }
  for (const element of doc.querySelectorAll("[data-i18n-aria-label]")) {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  }
}
