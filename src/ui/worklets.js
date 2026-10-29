// AudioWorklet processors. Loaded with addModule() by app.js — this file runs
// in AudioWorkletGlobalScope, not the window, and must stay self-contained
// apart from its core.js import (AudioWorklet modules support static imports).
import {
  FRAME_SAMPLES,
  LinearResampler,
  MIC_SAMPLE_RATE,
  PLAYBACK_SAMPLE_RATE,
  floatToInt16,
  frameInt16,
} from "./core.js";

const MAX_QUEUED_SECONDS = 20;

/**
 * Microphone capture: resample the device rate (normally 48 kHz) down to
 * 16 kHz mono, convert to Int16, and post 100 ms / 3200-byte frames to the
 * main thread. Continuous — no gating.
 */
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.resampler = new LinearResampler(sampleRate, MIC_SAMPLE_RATE);
    this.pending = new Int16Array(0);
  }

  process(inputs) {
    const channel = inputs[0] !== undefined ? inputs[0][0] : undefined;
    if (channel === undefined || channel.length === 0) {
      return true;
    }

    const resampled = this.resampler.process(channel);
    if (resampled.length === 0) {
      return true;
    }

    const result = frameInt16(this.pending, floatToInt16(resampled), FRAME_SAMPLES);
    this.pending = result.pending;
    for (const frame of result.frames) {
      this.port.postMessage(frame.buffer, [frame.buffer]);
    }
    return true;
  }
}

/**
 * Tutor playback: one queue of 24 kHz float samples. process() resamples to
 * the device rate with linear interpolation. `flush` empties the queue on a
 * barge-in (`turn` / `interrupted`). When the queue drains after playing audio,
 * post `{type: "drained"}`: the main thread turns that into the debounced
 * `tutor_playback_idle` WS message (PROTOCOL §2).
 */
class PlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.position = 0;
    this.ratio = PLAYBACK_SAMPLE_RATE / sampleRate;
    this.maxSamples = PLAYBACK_SAMPLE_RATE * MAX_QUEUED_SECONDS;
    this.drained = true;
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data === null || typeof data !== "object") {
        return;
      }
      if (data.type === "pcm" && data.samples instanceof Float32Array) {
        this.append(data.samples);
      } else if (data.type === "flush") {
        this.flush();
      }
    };
  }

  append(samples) {
    if (samples.length === 0) {
      return;
    }
    this.drained = false;

    const overflow = Math.max(0, this.buffer.length + samples.length - this.maxSamples);
    if (overflow > 0) {
      const kept = this.buffer.subarray(overflow);
      const next = new Float32Array(kept.length + samples.length);
      next.set(kept, 0);
      next.set(samples, kept.length);
      this.buffer = next;
      this.position = Math.max(0, this.position - overflow);
      return;
    }

    const next = new Float32Array(this.buffer.length + samples.length);
    next.set(this.buffer, 0);
    next.set(samples, this.buffer.length);
    this.buffer = next;
  }

  flush() {
    this.buffer = new Float32Array(0);
    this.position = 0;
    this.drained = true;
  }

  process(_inputs, outputs) {
    const channels = outputs[0];
    if (channels === undefined || channels.length === 0) {
      return true;
    }

    const frame = new Float32Array(channels[0].length);
    const buffer = this.buffer;
    let position = this.position;
    const hadAudio = buffer.length >= 2;

    if (buffer.length >= 2) {
      for (let index = 0; index < frame.length; index += 1) {
        if (position >= buffer.length - 1) {
          break;
        }
        const sampleIndex = Math.floor(position);
        const fraction = position - sampleIndex;
        frame[index] =
          buffer[sampleIndex] * (1 - fraction) + buffer[sampleIndex + 1] * fraction;
        position += this.ratio;
      }
    }

    // Drop entirely consumed samples; keep the fractional read position so
    // interpolation across the boundary stays continuous.
    const consumed = Math.min(buffer.length, Math.floor(position));
    this.buffer = consumed > 0 ? buffer.slice(consumed) : buffer;
    this.position = position - consumed;

    for (const channel of channels) {
      channel.set(frame);
    }

    if (hadAudio && this.buffer.length < 2 && !this.drained) {
      this.drained = true;
      this.port.postMessage({ type: "drained" });
    }
    return true;
  }
}

registerProcessor("grow-capture", CaptureProcessor);
registerProcessor("grow-player", PlayerProcessor);
