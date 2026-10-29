import { afterAll, describe, expect, test } from "bun:test";
import { createProxyClient } from "../src/ui/proxy-client.js";

// The client module only touches WebSocket inside connect(); a tiny fake keeps
// the test off the network while checking the exact wire message.
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static last: FakeSocket | null = null;

  readyState = FakeSocket.OPEN;
  binaryType = "";
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    const existing = this.listeners.get(type) ?? [];
    this.listeners.set(type, [...existing, listener]);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
  }
}

const globals = globalThis as unknown as Record<string, unknown>;
const originalWebSocket = globals.WebSocket;
globals.WebSocket = FakeSocket;

afterAll(() => {
  globals.WebSocket = originalWebSocket;
});

describe("proxy client playback idle", () => {
  test("sends the PROTOCOL §2 tutor_playback_idle message", () => {
    const client = createProxyClient({}, { httpBaseUrl: "http://test", wsBaseUrl: "ws://test" });
    client.connect("session-1");

    expect(client.sendPlaybackIdle()).toBe(true);
    expect(FakeSocket.last?.sent).toEqual(['{"type":"tutor_playback_idle"}']);
  });

  test("returns false when the socket is not open", () => {
    const client = createProxyClient({}, { httpBaseUrl: "http://test", wsBaseUrl: "ws://test" });
    client.connect("session-2");
    if (FakeSocket.last !== null) {
      FakeSocket.last.readyState = FakeSocket.CLOSED;
    }

    expect(client.sendPlaybackIdle()).toBe(false);
  });
});
