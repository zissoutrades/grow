import { describe, expect, test } from "bun:test";
import {
  executeToolCall,
  formatChildAction,
  TOOL_DECLARATIONS,
  toolDeclarations,
  ToolValidationError,
} from "../src/proxy/tools";

describe("tool declarations", () => {
  test("declare every protocol tool exactly once", () => {
    const names = TOOL_DECLARATIONS.map((declaration) => declaration.name);
    expect(names).toEqual([
      "advance_beat",
      "show_ten_frame",
      "fill_frame",
      "show_number_line",
      "show_choice_cards",
      "show_text",
      "consult_planner",
    ]);
  });
});

describe("executeToolCall", () => {
  test("advance_beat emits a beat event and acknowledges", () => {
    const result = executeToolCall({
      name: "advance_beat",
      args: { beatId: "attempt", outcome: "struggle" },
    });

    expect(result.beat).toEqual({ beatId: "attempt", outcome: "struggle" });
    expect(result.response).toEqual({ ok: true });
    expect(result.canvas).toBeUndefined();
  });

  test("advance_beat accepts the extend beat", () => {
    const result = executeToolCall({
      name: "advance_beat",
      args: { beatId: "extend", outcome: "ok" },
    });

    expect(result.beat).toEqual({ beatId: "extend", outcome: "ok" });
    expect(result.response).toEqual({ ok: true });
  });

  test("advance_beat rejects an unknown beat id", () => {
    expect(() =>
      executeToolCall({ name: "advance_beat", args: { beatId: "warmup", outcome: "ok" } }),
    ).toThrow(ToolValidationError);
  });

  test("show_ten_frame emits the canvas event", () => {
    const result = executeToolCall({ name: "show_ten_frame", args: { filled: 7 } });

    expect(result.canvas).toEqual({ tool: "show_ten_frame", args: { filled: 7 } });
    expect(result.response).toEqual({ ok: true });
  });

  test("show_ten_frame rejects a count outside 0–10", () => {
    expect(() => executeToolCall({ name: "show_ten_frame", args: { filled: 11 } })).toThrow(
      ToolValidationError,
    );
    expect(() =>
      executeToolCall({ name: "show_ten_frame", args: { filled: 1.5 } }),
    ).toThrow(ToolValidationError);
  });

  test("fill_frame accepts cell indexes 0–9 only", () => {
    expect(executeToolCall({ name: "fill_frame", args: { index: 9 } }).canvas).toEqual({
      tool: "fill_frame",
      args: { index: 9 },
    });
    expect(() => executeToolCall({ name: "fill_frame", args: { index: 10 } })).toThrow(
      ToolValidationError,
    );
  });

  test("show_number_line accepts a null marker", () => {
    const result = executeToolCall({
      name: "show_number_line",
      args: { min: 0, max: 10, marker: null },
    });

    expect(result.canvas).toEqual({
      tool: "show_number_line",
      args: { min: 0, max: 10, marker: null },
    });
  });

  test("show_number_line rejects an inverted range", () => {
    expect(() =>
      executeToolCall({ name: "show_number_line", args: { min: 10, max: 0, marker: 3 } }),
    ).toThrow(ToolValidationError);
  });

  test("show_choice_cards accepts two to four cards", () => {
    const cards = [
      { id: "a", label: "три" },
      { id: "b", label: "четыре" },
    ];

    expect(executeToolCall({ name: "show_choice_cards", args: { cards } }).canvas).toEqual({
      tool: "show_choice_cards",
      args: { cards },
    });
    expect(() =>
      executeToolCall({ name: "show_choice_cards", args: { cards: [cards[0]] } }),
    ).toThrow(ToolValidationError);
  });

  test("show_text requires non-empty text", () => {
    expect(executeToolCall({ name: "show_text", args: { text: "Молодец!" } }).canvas).toEqual({
      tool: "show_text",
      args: { text: "Молодец!" },
    });
    expect(() => executeToolCall({ name: "show_text", args: { text: "" } })).toThrow(
      ToolValidationError,
    );
  });

  test("consult_planner reports the planner as unavailable", () => {
    const result = executeToolCall({
      name: "consult_planner",
      args: { question: "дальше?" },
    });

    expect(result.response).toEqual({
      available: false,
      note: "planner not reachable",
    });
  });

  test("rejects an unknown tool", () => {
    expect(() => executeToolCall({ name: "do_magic", args: {} })).toThrow(
      ToolValidationError,
    );
  });
});

describe("formatChildAction", () => {
  test("renders a choice card by label", () => {
    expect(formatChildAction({ kind: "choice", value: { id: "b", label: "семь" } })).toBe(
      "[canvas] ребёнок нажал: карточка семь",
    );
  });

  test("renders a ten-frame cell index", () => {
    expect(formatChildAction({ kind: "tenframe", value: 4 })).toBe(
      "[canvas] ребёнок нажал: клетка 5",
    );
  });

  test("renders the zero-based ten-frame index as one-based for the tutor", () => {
    expect(formatChildAction({ kind: "tenframe", value: { index: 6 } })).toBe(
      "[canvas] ребёнок нажал: клетка 7",
    );
  });

  test("renders a number-line value", () => {
    expect(formatChildAction({ kind: "numberline", value: { value: 8 } })).toBe(
      "[canvas] ребёнок нажал: число 8",
    );
  });

  test("rejects a malformed action", () => {
    expect(() => formatChildAction({ kind: "choice", value: 42 })).toThrow(
      ToolValidationError,
    );
  });
});

describe("tool locale", () => {
  test("tool descriptions and canvas labels follow the demo locale", () => {
    const declarations = toolDeclarations("en");
    const advance = declarations.find((declaration) => declaration.name === "advance_beat");
    const tenFrame = declarations.find((declaration) => declaration.name === "show_ten_frame");
    const fill = declarations.find((declaration) => declaration.name === "fill_frame");

    expect(advance?.description).toBe(
      "Mark a transition to the next lesson beat. Call it at every transition.",
    );
    expect(tenFrame?.description).toBe(
      "Show a ten-frame on the canvas with cells filled left to right.",
    );
    expect(fill?.description).toBe(
      "Fill one cell of the ten-frame on the canvas.",
    );
    expect(declarations.map((declaration) => declaration.name)).toEqual(
      TOOL_DECLARATIONS.map((declaration) => declaration.name),
    );

    expect(formatChildAction({ kind: "choice", value: { label: "seven" } }, "en")).toBe(
      "[canvas] child tapped: card seven",
    );
    expect(formatChildAction({ kind: "tenframe", value: 4 }, "en")).toBe(
      "[canvas] child tapped: cell 5",
    );
    expect(formatChildAction({ kind: "numberline", value: { value: 8 } }, "en")).toBe(
      "[canvas] child tapped: number 8",
    );
  });

  test("the Russian defaults are unchanged", () => {
    expect(formatChildAction({ kind: "choice", value: { label: "семь" } })).toBe(
      "[canvas] ребёнок нажал: карточка семь",
    );
  });
});
