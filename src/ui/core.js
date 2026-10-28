// Pure client-side logic: PCM framing, transcript and canvas state.
// No DOM and no Web Audio globals live here, so Bun tests can import it.
// The browser modules (app.js, canvas.js, worklets.js) only render this state.

export const MIC_SAMPLE_RATE = 16000;
export const PLAYBACK_SAMPLE_RATE = 24000;
export const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz
export const MAX_TEXT_BLOCKS = 6;
export const MAX_TRANSCRIPT_LINES = 200;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Convert float samples in [-1, 1] to signed 16-bit PCM with clamping. */
export function floatToInt16(samples) {
  const output = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const value = clamp(samples[index], -1, 1);
    output[index] = Math.round(value < 0 ? value * 0x8000 : value * 0x7fff);
  }
  return output;
}

/** Convert signed 16-bit PCM to float samples in [-1, 1]. */
export function int16ToFloat32(samples) {
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    output[index] = samples[index] / 0x8000;
  }
  return output;
}

/**
 * Streaming linear resampler. Keeps one sample of history between blocks so
 * block boundaries do not click. Feed it successive process() blocks.
 */
export class LinearResampler {
  constructor(inputRate, outputRate) {
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.step = inputRate / outputRate;
    this.position = 0;
    this.previous = null;
  }

  process(input) {
    if (input.length === 0) {
      return new Float32Array(0);
    }
    if (this.inputRate === this.outputRate) {
      return input;
    }

    const output = [];
    let position = this.position;
    while (position < input.length - 1) {
      const index = Math.floor(position);
      const fraction = position - index;
      const left = index < 0 ? this.previous ?? input[0] : input[index];
      const right = input[index + 1];
      output.push(left + (right - left) * fraction);
      position += this.step;
    }

    this.previous = input[input.length - 1];
    this.position = position - input.length;
    return Float32Array.from(output);
  }
}

/**
 * Accumulate Int16 samples and cut them into fixed-size frames. Returns only
 * whole frames; the tail stays in `pending` for the next call.
 */
export function frameInt16(pending, samples, frameSamples = FRAME_SAMPLES) {
  const merged = new Int16Array(pending.length + samples.length);
  merged.set(pending, 0);
  merged.set(samples, pending.length);

  const frames = [];
  let offset = 0;
  while (merged.length - offset >= frameSamples) {
    frames.push(merged.slice(offset, offset + frameSamples));
    offset += frameSamples;
  }
  return { frames, pending: merged.slice(offset) };
}

/** Format elapsed milliseconds as mm:ss for the session clock. */
export function formatClock(elapsedMs) {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

// --- Transcript -----------------------------------------------------------

export function initialTranscriptState() {
  return { lines: [], partial: { tutor: "", child: "" } };
}

/**
 * Apply one PROTOCOL §2 transcript event. A partial replaces the in-progress
 * text for its role; a final commits the line and clears that role's partial.
 */
export function applyTranscript(state, message) {
  const role = message.role === "child" ? "child" : "tutor";
  const text = typeof message.text === "string" ? message.text : "";

  if (message.partial === true) {
    return {
      lines: state.lines,
      partial: { ...state.partial, [role]: text },
    };
  }

  const lines = text.length === 0
    ? state.lines
    : [...state.lines, { role, text }].slice(-MAX_TRANSCRIPT_LINES);
  return {
    lines,
    partial: { ...state.partial, [role]: "" },
  };
}

// --- Canvas ---------------------------------------------------------------

export function initialCanvasState() {
  return {
    tenframe: null,
    numberline: null,
    choices: null,
    texts: [],
    nextTextId: 1,
  };
}

function emptyCells() {
  return Array.from({ length: 10 }, () => false);
}

function filledCells(count) {
  const cells = emptyCells();
  for (let index = 0; index < count; index += 1) {
    cells[index] = true;
  }
  return cells;
}

/**
 * Apply one PROTOCOL §2 canvas event. Widget tools replace their widget;
 * `show_text` appends to a rolling text area.
 */
export function applyCanvasEvent(state, message) {
  if (!isRecord(message) || !isRecord(message.args)) {
    return state;
  }
  const args = message.args;

  switch (message.tool) {
    case "show_ten_frame": {
      const filled = finiteNumber(args.filled);
      if (filled === null) {
        return state;
      }
      return {
        ...state,
        tenframe: { cells: filledCells(clamp(Math.round(filled), 0, 10)) },
      };
    }
    case "fill_frame": {
      const index = finiteNumber(args.index);
      if (index === null || index < 0 || index > 9) {
        return state;
      }
      const cells = state.tenframe === null ? emptyCells() : [...state.tenframe.cells];
      cells[Math.round(index)] = true;
      return { ...state, tenframe: { cells } };
    }
    case "show_number_line": {
      const min = finiteNumber(args.min);
      const max = finiteNumber(args.max);
      const marker = args.marker === null ? null : finiteNumber(args.marker);
      if (min === null || max === null || min === max) {
        return state;
      }
      return { ...state, numberline: { min, max, marker } };
    }
    case "show_choice_cards": {
      if (!Array.isArray(args.cards)) {
        return state;
      }
      const cards = args.cards
        .filter((card) => isRecord(card) && typeof card.id === "string" && typeof card.label === "string")
        .slice(0, 4)
        .map((card) => ({ id: card.id, label: card.label }));
      if (cards.length < 2) {
        return state;
      }
      return { ...state, choices: { cards, selectedId: null } };
    }
    case "show_text": {
      if (typeof args.text !== "string") {
        return state;
      }
      const entry = { id: state.nextTextId, text: args.text };
      return {
        ...state,
        texts: [...state.texts, entry].slice(-MAX_TEXT_BLOCKS),
        nextTextId: state.nextTextId + 1,
      };
    }
    default:
      return state;
  }
}

/** Optimistically fill one cell after the child taps it. */
export function tapTenFrame(state, index) {
  if (state.tenframe === null || index < 0 || index > 9 || state.tenframe.cells[index]) {
    return state;
  }
  const cells = [...state.tenframe.cells];
  cells[index] = true;
  return { ...state, tenframe: { cells } };
}

/** Optimistically mark a chosen card. */
export function selectChoice(state, id) {
  if (state.choices === null || !state.choices.cards.some((card) => card.id === id)) {
    return state;
  }
  return { ...state, choices: { ...state.choices, selectedId: id } };
}
