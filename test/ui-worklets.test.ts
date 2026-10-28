import { describe, expect, test } from "bun:test";

// The worklet module expects AudioWorkletGlobalScope globals. Provide the
// smallest fakes needed to instantiate the processors in Bun, then import the
// module dynamically so the globals exist before registerProcessor runs.
const registry: Record<string, new () => {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage(data: unknown): void };
  process(inputs: unknown, outputs?: unknown): boolean;
}> = {};

class FakePort {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: unknown[] = [];

  postMessage(data: unknown): void {
    this.sent.push(data);
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.sampleRate = 48000;
globals.AudioWorkletProcessor = class {
  port = new FakePort();
};
globals.registerProcessor = (name: string, ctor: never) => {
  registry[name] = ctor;
};

await import("../src/ui/worklets.js");

describe("capture worklet", () => {
  test("resamples 48 kHz input and posts 3200-byte frames", () => {
    const Processor = registry["grow-capture"];
    const processor = new Processor();
    const port = processor.port as FakePort;
    const block = new Float32Array(128).fill(0.25);

    // 80 blocks = 10240 input samples at 48 kHz ~= 3413 samples at 16 kHz,
    // which is two complete 1600-sample frames.
    for (let index = 0; index < 80; index += 1) {
      processor.process([[block]]);
    }

    expect(port.sent.length).toBe(2);
    for (const frame of port.sent) {
      expect(frame).toBeInstanceOf(ArrayBuffer);
      expect((frame as ArrayBuffer).byteLength).toBe(3200);
    }
  });

  test("does nothing when the input block is empty", () => {
    const Processor = registry["grow-capture"];
    const processor = new Processor();
    const port = processor.port as FakePort;
    expect(processor.process([[]])).toBe(true);
    expect(port.sent).toHaveLength(0);
  });
});

describe("player worklet", () => {
  test("plays queued 24 kHz samples and flushes them on interrupt", () => {
    const Processor = registry["grow-player"];
    const processor = new Processor();
    const port = processor.port as FakePort;

    const samples = new Float32Array(4800).fill(0.5);
    port.onmessage?.({ data: { type: "pcm", samples } });

    const output = new Float32Array(256);
    processor.process([], [[output]]);
    expect(output.some((sample) => Math.abs(sample - 0.5) < 1e-4)).toBe(true);

    port.onmessage?.({ data: { type: "flush" } });
    const silence = new Float32Array(256);
    processor.process([], [[silence]]);
    expect(silence.every((sample) => sample === 0)).toBe(true);
  });

  test("outputs silence when the queue is empty", () => {
    const Processor = registry["grow-player"];
    const processor = new Processor();
    const output = new Float32Array(128);
    processor.process([], [[output]]);
    expect(output.every((sample) => sample === 0)).toBe(true);
  });
});
