/** Tool declarations and pure execution for the Grow tutor session. */

import { currentLocale, type Locale } from "./locale";

export const BEAT_IDS = [
  "recall",
  "present",
  "attempt",
  "diagnose",
  "repair",
  "extend",
  "consolidate",
  "reflect",
  "close",
] as const;

export type BeatId = (typeof BEAT_IDS)[number];

export const BEAT_OUTCOMES = ["ok", "struggle", "skip"] as const;

export type BeatOutcome = (typeof BEAT_OUTCOMES)[number];

export const CANVAS_TOOLS = [
  "show_ten_frame",
  "fill_frame",
  "show_number_line",
  "show_choice_cards",
  "show_text",
] as const;

export type CanvasToolName = (typeof CANVAS_TOOLS)[number];

export const TOOL_NAMES = ["advance_beat", ...CANVAS_TOOLS, "consult_planner"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface FunctionCall {
  readonly id?: string;
  readonly name: string;
  readonly args?: unknown;
}

export interface CanvasEvent {
  readonly tool: CanvasToolName;
  readonly args: CanvasWidgetArgs;
}

export interface BeatEvent {
  readonly beatId: BeatId;
  readonly outcome: BeatOutcome;
}

export interface ToolExecution {
  readonly response: Record<string, unknown>;
  readonly canvas?: CanvasEvent;
  readonly beat?: BeatEvent;
}

export interface ChoiceCard {
  readonly id: string;
  readonly label: string;
}

export type CanvasWidgetArgs =
  | { readonly filled: number }
  | { readonly index: number }
  | { readonly min: number; readonly max: number; readonly marker: number | null }
  | { readonly cards: readonly ChoiceCard[] }
  | { readonly text: string };

export class ToolValidationError extends Error {
  readonly toolName: string;

  constructor(toolName: string, message: string) {
    super(`${toolName}: ${message}`);
    this.name = "ToolValidationError";
    this.toolName = toolName;
  }
}

export type ChildActionKind = "choice" | "tenframe" | "numberline";

export interface ChildAction {
  readonly kind: ChildActionKind;
  readonly value: unknown;
}

interface ToolCopy {
  readonly advanceBeat: string;
  readonly beatId: string;
  readonly outcome: string;
  readonly showTenFrame: string;
  readonly filled: string;
  readonly fillFrame: string;
  readonly index: string;
  readonly showNumberLine: string;
  readonly min: string;
  readonly max: string;
  readonly marker: string;
  readonly showChoiceCards: string;
  readonly showText: string;
  readonly text: string;
  readonly consultPlanner: string;
  readonly question: string;
}

const TOOL_COPY: Record<Locale, ToolCopy> = {
  ru: {
    advanceBeat: "Отметь переход к следующему этапу урока. Вызывай при каждом переходе.",
    beatId: "Этап урока.",
    outcome: "Как прошёл этап.",
    showTenFrame: "Показать на холсте тен-фрейм с заполненными слева направо клетками.",
    filled: "Сколько клеток заполнено (0–10).",
    fillFrame: "Заполнить одну клетку тен-фрейма на холсте.",
    index: "Индекс клетки от 0 до 9.",
    showNumberLine: "Показать числовую прямую с маркером.",
    min: "Левая граница.",
    max: "Правая граница.",
    marker: "Позиция маркера или null.",
    showChoiceCards: "Показать карточки с вариантами ответа (2–4 штуки).",
    showText: "Показать короткий текст на холсте.",
    text: "Текст для холста.",
    consultPlanner: "Спросить планировщика (в демо недоступен).",
    question: "Вопрос планировщику.",
  },
  en: {
    advanceBeat: "Mark a transition to the next lesson beat. Call it at every transition.",
    beatId: "Lesson beat.",
    outcome: "How the beat went.",
    showTenFrame: "Show a ten-frame on the canvas with cells filled left to right.",
    filled: "How many cells are filled (0–10).",
    fillFrame: "Fill one cell of the ten-frame on the canvas.",
    index: "Cell index from 0 to 9.",
    showNumberLine: "Show a number line with a marker.",
    min: "Left end.",
    max: "Right end.",
    marker: "Marker position, or null.",
    showChoiceCards: "Show answer choice cards (2–4).",
    showText: "Show a short text on the canvas.",
    text: "Text for the canvas.",
    consultPlanner: "Ask the planner (unavailable in the demo).",
    question: "Question for the planner.",
  },
};

/** Gemini function declarations (PROTOCOL §5). */
function buildDeclarations(copy: ToolCopy) {
  return [
    {
      name: "advance_beat",
      description: copy.advanceBeat,
      parameters: {
        type: "OBJECT",
        properties: {
          beatId: {
            type: "STRING",
            enum: [...BEAT_IDS],
            description: copy.beatId,
          },
          outcome: {
            type: "STRING",
            enum: [...BEAT_OUTCOMES],
            description: copy.outcome,
          },
        },
        required: ["beatId", "outcome"],
      },
    },
    {
      name: "show_ten_frame",
      description: copy.showTenFrame,
      parameters: {
        type: "OBJECT",
        properties: {
          filled: {
            type: "INTEGER",
            minimum: 0,
            maximum: 10,
            description: copy.filled,
          },
        },
        required: ["filled"],
      },
    },
    {
      name: "fill_frame",
      description: copy.fillFrame,
      parameters: {
        type: "OBJECT",
        properties: {
          index: {
            type: "INTEGER",
            minimum: 0,
            maximum: 9,
            description: copy.index,
          },
        },
        required: ["index"],
      },
    },
    {
      name: "show_number_line",
      description: copy.showNumberLine,
      parameters: {
        type: "OBJECT",
        properties: {
          min: { type: "NUMBER", description: copy.min },
          max: { type: "NUMBER", description: copy.max },
          marker: {
            type: "NUMBER",
            nullable: true,
            description: copy.marker,
          },
        },
        required: ["min", "max", "marker"],
      },
    },
    {
      name: "show_choice_cards",
      description: copy.showChoiceCards,
      parameters: {
        type: "OBJECT",
        properties: {
          cards: {
            type: "ARRAY",
            minItems: "2",
            maxItems: "4",
            items: {
              type: "OBJECT",
              properties: {
                id: { type: "STRING" },
                label: { type: "STRING" },
              },
              required: ["id", "label"],
            },
          },
        },
        required: ["cards"],
      },
    },
    {
      name: "show_text",
      description: copy.showText,
      parameters: {
        type: "OBJECT",
        properties: {
          text: { type: "STRING", description: copy.text },
        },
        required: ["text"],
      },
    },
    {
      name: "consult_planner",
      description: copy.consultPlanner,
      parameters: {
        type: "OBJECT",
        properties: {
          question: { type: "STRING", description: copy.question },
        },
        required: ["question"],
      },
    },
  ] as const;
}

/** Russian declarations: the default kept as an export for existing callers. */
export const TOOL_DECLARATIONS = buildDeclarations(TOOL_COPY.ru);

/** Declarations whose descriptions follow the demo locale. */
export function toolDeclarations(locale: Locale = currentLocale()) {
  return buildDeclarations(TOOL_COPY[locale]);
}

/**
 * Execute one upstream tool call. Pure: callers log the call/result and emit
 * canvas/beat events to the client.
 */
export function executeToolCall(call: FunctionCall): ToolExecution {
  if (!isToolName(call.name)) {
    throw new ToolValidationError(call.name, "unknown tool");
  }
  const args = asRecord(call.args ?? {}, call.name, "args");

  switch (call.name) {
    case "advance_beat": {
      const beatId = asBeatId(args.beatId, call.name);
      const outcome = asBeatOutcome(args.outcome, call.name);
      return {
        response: { ok: true },
        beat: { beatId, outcome },
      };
    }
    case "show_ten_frame": {
      const filled = asInteger(args.filled, call.name, "filled", 0, 10);
      return { response: { ok: true }, canvas: { tool: "show_ten_frame", args: { filled } } };
    }
    case "fill_frame": {
      const index = asInteger(args.index, call.name, "index", 0, 9);
      return { response: { ok: true }, canvas: { tool: "fill_frame", args: { index } } };
    }
    case "show_number_line": {
      const min = asNumber(args.min, call.name, "min");
      const max = asNumber(args.max, call.name, "max");
      if (min >= max) {
        throw new ToolValidationError(call.name, "min must be less than max");
      }
      const marker =
        args.marker === null || args.marker === undefined
          ? null
          : asNumber(args.marker, call.name, "marker");
      return {
        response: { ok: true },
        canvas: { tool: "show_number_line", args: { min, max, marker } },
      };
    }
    case "show_choice_cards": {
      if (!Array.isArray(args.cards)) {
        throw new ToolValidationError(call.name, "cards must be an array");
      }
      if (args.cards.length < 2 || args.cards.length > 4) {
        throw new ToolValidationError(call.name, "cards must contain 2–4 items");
      }
      const cards = args.cards.map((rawCard, index) => {
        const card = asRecord(rawCard, call.name, `cards[${index}]`);
        return {
          id: asString(card.id, call.name, `cards[${index}].id`),
          label: asString(card.label, call.name, `cards[${index}].label`),
        };
      });
      return { response: { ok: true }, canvas: { tool: "show_choice_cards", args: { cards } } };
    }
    case "show_text": {
      const text = asString(args.text, call.name, "text");
      return { response: { ok: true }, canvas: { tool: "show_text", args: { text } } };
    }
    case "consult_planner":
      asString(args.question, call.name, "question");
      return {
        response: { available: false, note: "planner not reachable" },
      };
  }
}

const CHILD_ACTION_WORDS: Record<
  Locale,
  { readonly prefix: string; readonly card: string; readonly cell: string; readonly number: string }
> = {
  ru: { prefix: "[canvas] ребёнок нажал: ", card: "карточка", cell: "клетка", number: "число" },
  en: { prefix: "[canvas] child tapped: ", card: "card", cell: "cell", number: "number" },
};

/**
 * Render a child's canvas action as the text turn the tutor sees
 * (PROTOCOL §2). The value shapes are intentionally tolerant: U2 may send a
 * string label, a number, or `{id,label}` / `{index}`.
 */
export function formatChildAction(
  action: ChildAction,
  locale: Locale = currentLocale(),
): string {
  const words = CHILD_ACTION_WORDS[locale];
  switch (action.kind) {
    case "choice": {
      const label = choiceLabel(action.value);
      return `${words.prefix}${words.card} ${label}`;
    }
    case "tenframe": {
      const index = fieldNumber(action.value, "index");
      return `${words.prefix}${words.cell} ${index + 1}`;
    }
    case "numberline": {
      const value = fieldNumber(action.value, "value");
      return `${words.prefix}${words.number} ${value}`;
    }
  }
}

function choiceLabel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    if (typeof value.label === "string") {
      return value.label;
    }
    if (typeof value.id === "string") {
      return value.id;
    }
  }
  throw new ToolValidationError("child_action", "choice value needs a label");
}

function fieldNumber(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (isRecord(value)) {
    const nested = value[field];
    if (typeof nested === "number" && Number.isFinite(nested)) {
      return nested;
    }
  }
  throw new ToolValidationError("child_action", `${field} must be a number`);
}

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

function asBeatId(value: unknown, tool: string): BeatId {
  if (typeof value !== "string" || !(BEAT_IDS as readonly string[]).includes(value)) {
    throw new ToolValidationError(tool, `invalid beatId: ${String(value)}`);
  }
  return value as BeatId;
}

function asBeatOutcome(value: unknown, tool: string): BeatOutcome {
  if (typeof value !== "string" || !(BEAT_OUTCOMES as readonly string[]).includes(value)) {
    throw new ToolValidationError(tool, `invalid outcome: ${String(value)}`);
  }
  return value as BeatOutcome;
}

function asRecord(value: unknown, tool: string, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ToolValidationError(tool, `${field} must be an object`);
  }
  return value;
}

function asString(value: unknown, tool: string, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolValidationError(tool, `${field} must be a non-empty string`);
  }
  return value;
}

function asNumber(value: unknown, tool: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolValidationError(tool, `${field} must be a number`);
  }
  return value;
}

function asInteger(
  value: unknown,
  tool: string,
  field: string,
  min: number,
  max: number,
): number {
  const number = asNumber(value, tool, field);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ToolValidationError(tool, `${field} must be an integer ${min}–${max}`);
  }
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
