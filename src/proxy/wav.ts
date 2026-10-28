import { readFileSync, rmSync, writeFileSync } from "node:fs";

/** PCM format used by both recorded streams. */
export interface PcmFormat {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
}

export const MIC_FORMAT: PcmFormat = {
  sampleRate: 16_000,
  channels: 1,
  bitsPerSample: 16,
};

export const TUTOR_FORMAT: PcmFormat = {
  sampleRate: 24_000,
  channels: 1,
  bitsPerSample: 16,
};

export interface WaveStampResult {
  readonly wavPath: string;
  readonly dataBytes: number;
  readonly durationSeconds: number;
}

/**
 * Build a canonical 44-byte PCM WAV header. Length fields are derived from
 * `dataBytes`, so callers can patch a header by rebuilding it.
 */
export function buildWavHeader(dataBytes: number, format: PcmFormat): Uint8Array {
  if (!Number.isInteger(dataBytes) || dataBytes < 0) {
    throw new RangeError(`invalid PCM data length: ${dataBytes}`);
  }
  const blockAlign = (format.channels * format.bitsPerSample) / 8;
  const byteRate = format.sampleRate * blockAlign;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, format.channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bitsPerSample, true);
  writeAscii(header, 36, "data");
  view.setUint32(40, dataBytes, true);

  return header;
}

/**
 * Convert a raw PCM file to a playable WAV file by prepending a header
 * carrying the real data length. The source PCM file is removed once the WAV
 * is written successfully.
 */
export function stampPcmToWav(
  pcmPath: string,
  wavPath: string,
  format: PcmFormat,
): WaveStampResult {
  const pcm = readFileSync(pcmPath);
  const header = buildWavHeader(pcm.byteLength, format);
  const wav = new Uint8Array(header.byteLength + pcm.byteLength);
  wav.set(header, 0);
  wav.set(pcm, header.byteLength);
  writeFileSync(wavPath, wav);
  rmSync(pcmPath);

  const blockAlign = (format.channels * format.bitsPerSample) / 8;
  return {
    wavPath,
    dataBytes: pcm.byteLength,
    durationSeconds: pcm.byteLength / (format.sampleRate * blockAlign),
  };
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    target[offset + i] = text.charCodeAt(i);
  }
}
