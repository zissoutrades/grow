import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWavHeader,
  MIC_FORMAT,
  stampPcmToWav,
  TUTOR_FORMAT,
} from "../src/proxy/wav";

const folders: string[] = [];

function tempFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), "grow-wav-"));
  folders.push(folder);
  return folder;
}

afterEach(() => {
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

describe("buildWavHeader", () => {
  test("writes a canonical 44-byte PCM header with patched lengths", () => {
    const header = buildWavHeader(32_000, MIC_FORMAT);
    const view = new DataView(header.buffer);

    expect(header.byteLength).toBe(44);
    expect(ascii(header, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 32_000);
    expect(ascii(header, 8, 4)).toBe("WAVE");
    expect(ascii(header, 12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(ascii(header, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(32_000);
  });

  test("uses the tutor stream's 24 kHz sample rate", () => {
    const header = buildWavHeader(48_000, TUTOR_FORMAT);
    const view = new DataView(header.buffer);

    expect(view.getUint32(24, true)).toBe(24_000);
    expect(view.getUint32(28, true)).toBe(48_000);
  });

  test("rejects a negative data length", () => {
    expect(() => buildWavHeader(-1, MIC_FORMAT)).toThrow(RangeError);
  });
});

describe("stampPcmToWav", () => {
  test("prepends the header, keeps the samples, and removes the PCM file", () => {
    const folder = tempFolder();
    const pcmPath = join(folder, "mic.pcm");
    const wavPath = join(folder, "mic.wav");
    const samples = new Uint8Array(1_000);
    samples.fill(7);
    writeFileSync(pcmPath, samples);

    const result = stampPcmToWav(pcmPath, wavPath, MIC_FORMAT);

    expect(result.dataBytes).toBe(1_000);
    expect(result.durationSeconds).toBe(1_000 / 32_000);
    expect(existsSync(pcmPath)).toBe(false);
    const wav = new Uint8Array(readFileSync(wavPath));
    expect(wav.byteLength).toBe(1_044);
    expect(new DataView(wav.buffer).getUint32(40, true)).toBe(1_000);
    expect([...wav.subarray(44, 54)]).toEqual(new Array(10).fill(7));
  });
});

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = "";
  for (let i = 0; i < length; i += 1) {
    text += String.fromCharCode(bytes[offset + i]);
  }
  return text;
}
