import { describe, expect, test } from "bun:test";
import {
  FRAME_SAMPLES,
  LinearResampler,
  MAX_TEXT_BLOCKS,
  applyCanvasEvent,
  applyTranscript,
  floatToInt16,
  formatClock,
  frameInt16,
  initialCanvasState,
  initialTranscriptState,
  int16ToFloat32,
  selectChoice,
  tapTenFrame,
} from "../src/ui/core.js";

describe("PCM conversion", () => {
  test("floatToInt16 clamps to the signed 16-bit range", () => {
    const pcm = floatToInt16(Float32Array.from([-2, -1, -0.5, 0, 0.5, 1, 2]));
    expect([...pcm]).toEqual([-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  });

  test("int16ToFloat32 maps the extremes to -1 and ~1", () => {
    const floats = int16ToFloat32(Int16Array.from([-32768, 0, 32767]));
    expect(floats[0]).toBe(-1);
    expect(floats[1]).toBe(0);
    expect(floats[2]).toBeCloseTo(1, 4);
  });
});

describe("frame buffering", () => {
  test("emits only full 100 ms frames and carries the tail", () => {
    const first = frameInt16(new Int16Array(0), new Int16Array(1000));
    expect(first.frames).toHaveLength(0);
    expect(first.pending).toHaveLength(1000);

    const second = frameInt16(first.pending, new Int16Array(1000));
    expect(second.frames).toHaveLength(1);
    expect(second.frames[0]).toHaveLength(FRAME_SAMPLES);
    expect(second.frames[0].byteLength).toBe(3200);
    expect(second.pending).toHaveLength(400);

    const third = frameInt16(second.pending, new Int16Array(1200));
    expect(third.frames).toHaveLength(1);
    expect(third.pending).toHaveLength(0);
  });

  test("keeps sample order across frame boundaries", () => {
    const input = Int16Array.from({ length: 4000 }, (_, index) => index % 100);
    const result = frameInt16(new Int16Array(0), input);
    expect(result.frames).toHaveLength(2);
    expect(result.pending).toHaveLength(800);
    expect(result.frames[0][0]).toBe(0);
    expect(result.frames[0][1599]).toBe(1599 % 100);
    expect(result.frames[1][0]).toBe(1600 % 100);
  });
});

describe("resampling", () => {
  test("48 kHz to 16 kHz keeps a constant signal and divides the length by three", () => {
    const source = new Float32Array(480).fill(0.25);
    const resampler = new LinearResampler(48000, 16000);
    const output = resampler.process(source);
    expect(output).toHaveLength(160);
    for (const sample of output) {
      expect(sample).toBeCloseTo(0.25, 5);
    }
  });

  test("continued blocks do not restart the read position", () => {
    const resampler = new LinearResampler(48000, 16000);
    const ramp = Float32Array.from({ length: 128 }, (_, index) => index);
    const first = resampler.process(ramp);
    const second = resampler.process(ramp);
    expect(first.length).toBeGreaterThan(30);
    expect(second.length).toBeGreaterThan(30);
    // 128 input samples advanced the read position past the block; the next
    // output lands one sample into the second block (not back at zero).
    expect(second[0]).toBe(1);
  });
});

describe("session clock", () => {
  test("formats elapsed milliseconds as mm:ss", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(65_000)).toBe("01:05");
    expect(formatClock(3_600_000)).toBe("60:00");
    expect(formatClock(-500)).toBe("00:00");
  });
});

describe("transcript routing", () => {
  test("a partial replaces the in-progress line for its role", () => {
    let state = initialTranscriptState();
    state = applyTranscript(state, { role: "tutor", text: "При", partial: true });
    state = applyTranscript(state, { role: "tutor", text: "Привет", partial: true });
    expect(state.lines).toHaveLength(0);
    expect(state.partial.tutor).toBe("Привет");
  });

  test("a final commits the line and clears that role's partial", () => {
    let state = initialTranscriptState();
    state = applyTranscript(state, { role: "tutor", text: "Привет", partial: true });
    state = applyTranscript(state, { role: "tutor", text: "Привет!", partial: false });
    expect(state.lines).toEqual([{ role: "tutor", text: "Привет!" }]);
    expect(state.partial.tutor).toBe("");
  });

  test("child and tutor partials coexist", () => {
    let state = initialTranscriptState();
    state = applyTranscript(state, { role: "tutor", text: "Сколько?", partial: true });
    state = applyTranscript(state, { role: "child", text: "три", partial: true });
    expect(state.partial.tutor).toBe("Сколько?");
    expect(state.partial.child).toBe("три");
  });
});

describe("canvas routing", () => {
  test("show_ten_frame fills cells left to right", () => {
    const state = applyCanvasEvent(initialCanvasState(), {
      tool: "show_ten_frame",
      args: { filled: 3 },
    });
    expect(state.tenframe?.cells).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  test("fill_frame updates the same widget instead of stacking a new one", () => {
    let state = applyCanvasEvent(initialCanvasState(), {
      tool: "show_ten_frame",
      args: { filled: 3 },
    });
    state = applyCanvasEvent(state, { tool: "fill_frame", args: { index: 5 } });
    expect(state.tenframe?.cells.filter(Boolean)).toHaveLength(4);
    expect(state.tenframe?.cells[5]).toBe(true);
  });

  test("a new ten-frame replaces the previous one", () => {
    let state = applyCanvasEvent(initialCanvasState(), {
      tool: "show_ten_frame",
      args: { filled: 5 },
    });
    state = applyCanvasEvent(state, { tool: "show_ten_frame", args: { filled: 1 } });
    expect(state.tenframe?.cells.filter(Boolean)).toHaveLength(1);
    expect(state.tenframe?.cells[0]).toBe(true);
  });

  test("fill_frame without an existing frame creates one", () => {
    const state = applyCanvasEvent(initialCanvasState(), {
      tool: "fill_frame",
      args: { index: 2 },
    });
    expect(state.tenframe?.cells[2]).toBe(true);
    expect(state.tenframe?.cells.filter(Boolean)).toHaveLength(1);
  });

  test("show_number_line replaces the marker and clamps nothing in state", () => {
    let state = applyCanvasEvent(initialCanvasState(), {
      tool: "show_number_line",
      args: { min: 0, max: 10, marker: 7 },
    });
    expect(state.numberline).toEqual({ min: 0, max: 10, marker: 7 });
    state = applyCanvasEvent(state, {
      tool: "show_number_line",
      args: { min: 0, max: 20, marker: null },
    });
    expect(state.numberline).toEqual({ min: 0, max: 20, marker: null });
  });

  test("show_choice_cards replaces the previous cards", () => {
    let state = applyCanvasEvent(initialCanvasState(), {
      tool: "show_choice_cards",
      args: {
        cards: [
          { id: "6", label: "6" },
          { id: "7", label: "7" },
          { id: "8", label: "8" },
        ],
      },
    });
    expect(state.choices?.cards).toHaveLength(3);

    state = applyCanvasEvent(state, {
      tool: "show_choice_cards",
      args: {
        cards: [
          { id: "a", label: "да" },
          { id: "b", label: "нет" },
        ],
      },
    });
    expect(state.choices?.cards).toEqual([
      { id: "a", label: "да" },
      { id: "b", label: "нет" },
    ]);
    expect(state.choices?.selectedId).toBeNull();
  });

  test("fewer than two choice cards are ignored", () => {
    const state = initialCanvasState();
    const next = applyCanvasEvent(state, {
      tool: "show_choice_cards",
      args: { cards: [{ id: "a", label: "да" }] },
    });
    expect(next).toBe(state);
  });

  test("show_text appends to a rolling list", () => {
    let state = initialCanvasState();
    for (let index = 0; index < MAX_TEXT_BLOCKS + 1; index += 1) {
      state = applyCanvasEvent(state, {
        tool: "show_text",
        args: { text: `строка ${index}` },
      });
    }
    expect(state.texts).toHaveLength(MAX_TEXT_BLOCKS);
    expect(state.texts[state.texts.length - 1].text).toBe(`строка ${MAX_TEXT_BLOCKS}`);
  });

  test("an unknown tool leaves the state untouched", () => {
    const state = initialCanvasState();
    expect(applyCanvasEvent(state, { tool: "no_such_tool", args: {} })).toBe(state);
  });

  test("tapping a cell fills it and a second tap is a no-op", () => {
    const initial = applyCanvasEvent(initialCanvasState(), {
      tool: "show_ten_frame",
      args: { filled: 0 },
    });
    const tapped = tapTenFrame(initial, 4);
    expect(tapped.tenframe?.cells[4]).toBe(true);
    expect(tapTenFrame(tapped, 4)).toBe(tapped);
  });

  test("selecting a card marks it and rejects unknown ids", () => {
    const state = applyCanvasEvent(initialCanvasState(), {
      tool: "show_choice_cards",
      args: {
        cards: [
          { id: "a", label: "да" },
          { id: "b", label: "нет" },
        ],
      },
    });
    const selected = selectChoice(state, "b");
    expect(selected.choices?.selectedId).toBe("b");
    expect(selectChoice(selected, "zzz")).toBe(selected);
  });
});
