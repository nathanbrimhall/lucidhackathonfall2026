import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLiveKitCapture, encodeWav, PcmChunker, SAMPLE_RATE, type AudioChunk } from "../src/audio.js";
import { captureJob } from "./fixtures.js";

const fixture = vi.hoisted(() => ({
  rooms: [] as Array<EventEmitter & { remoteParticipants: Map<string, unknown>; disconnect: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }>,
  controllers: [] as ReadableStreamDefaultController<unknown>[],
}));
vi.mock("@livekit/rtc-node", () => ({
  Room: class extends EventEmitter {
    name = "meet_one";
    isConnected = true;
    remoteParticipants = new Map<string, unknown>();
    connect = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
    constructor() { super(); fixture.rooms.push(this); }
  },
  RoomEvent: { TrackPublished: "published", TrackSubscribed: "subscribed", Disconnected: "disconnected", Reconnecting: "reconnecting" },
  TrackKind: { KIND_AUDIO: 1 }, TrackSource: { SOURCE_MICROPHONE: 2 },
  AudioStream: function () { return new ReadableStream<unknown>({ start(controller) { fixture.controllers.push(controller); } }); },
}));

const publication = (kind = 1, source = 2) => ({ sid: "track-1", kind, source, setSubscribed: vi.fn() });
beforeEach(() => { fixture.rooms.length = 0; fixture.controllers.length = 0; });

describe("bounded microphone capture", () => {
  it("creates valid little-endian PCM WAV and discards incomplete chunks", () => {
    const encoded = Buffer.from(encodeWav(new Int16Array([-2, 1])));
    expect(encoded.toString("ascii", 0, 4)).toBe("RIFF");
    expect(encoded.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(encoded.readUInt16LE(22)).toBe(1);
    expect(encoded.readInt16LE(44)).toBe(-2);
    const chunker = new PcmChunker(1);
    chunker.push(new Int16Array(8_000).fill(1), 500);
    chunker.discard();
    expect(chunker.push(new Int16Array(8_000).fill(2), 1_000)).toEqual([]);
    const [chunk] = chunker.push(new Int16Array(8_000).fill(2), 1_500);
    expect(chunk.samples.length).toBe(16_000);
    expect(chunk.startMs).toBe(500);
    expect(chunk.endMs).toBe(1_500);
    expect(chunk.samples.every((value) => value === 2)).toBe(true);
    expect(() => chunker.push(new Int16Array(16_001), 0)).toThrow("Oversized");
  });

  it("disables automatic subscription and rejects cameras, screen audio, and unlisted participants", async () => {
    const controller = new AbortController();
    const onChunk = vi.fn(async () => {});
    const task = createLiveKitCapture().run(captureJob, { signal: controller.signal, chunkSeconds: 1, onChunk });
    await vi.waitFor(() => expect(fixture.rooms).toHaveLength(1));
    const room = fixture.rooms[0];
    expect(room.connect.mock.calls[0][2]).toMatchObject({ autoSubscribe: false });
    const allowed = publication();
    room.emit("published", allowed, { identity: "media-alice" });
    expect(allowed.setSubscribed).toHaveBeenCalledWith(true);
    for (const [identity, kind, source] of [["mallory", 1, 2], ["media-alice", 2, 2], ["media-alice", 1, 3]] as const) {
      const denied = publication(kind, source);
      room.emit("published", denied, { identity });
      room.emit("subscribed", {}, denied, { identity });
      expect(denied.setSubscribed).toHaveBeenLastCalledWith(false);
    }
    expect(fixture.controllers).toHaveLength(0);
    controller.abort(); await task;
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("labels authorized chunks by speaker, bounds pending chunks, and aborts on backpressure", async () => {
    const controller = new AbortController();
    let providerSignal: AbortSignal | undefined;
    const onChunk = vi.fn(async (_chunk: AudioChunk, signal: AbortSignal) => new Promise<void>((resolve) => {
      providerSignal = signal; signal.addEventListener("abort", () => resolve(), { once: true });
    }));
    const result = createLiveKitCapture().run(captureJob, { signal: controller.signal, chunkSeconds: 1, onChunk });
    // Attach rejection observer immediately so backpressure rejection is never unhandled.
    const observed = expect(result).rejects.toThrow("backpressure");
    await vi.waitFor(() => expect(fixture.rooms).toHaveLength(1));
    fixture.rooms[0].emit("subscribed", {}, publication(), { identity: "media-alice" });
    await vi.waitFor(() => expect(fixture.controllers).toHaveLength(1));
    const audio = fixture.controllers[0];
    for (let i = 0; i < 100; i++) audio.enqueue({ data: new Int16Array(320).fill(1), sampleRate: SAMPLE_RATE, channels: 1 });
    await observed;
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(onChunk.mock.calls[0][0].speakerUserId).toBe("alice");
    expect(providerSignal?.aborted).toBe(true);
    expect(onChunk.mock.calls[0][0].wav.every((v: number) => v === 0)).toBe(true);
  });

  it("drops partial buffers and never transcribes after cancellation", async () => {
    const controller = new AbortController();
    const onChunk = vi.fn(async () => {});
    const task = createLiveKitCapture().run(captureJob, { signal: controller.signal, chunkSeconds: 1, onChunk });
    await vi.waitFor(() => expect(fixture.rooms).toHaveLength(1));
    fixture.rooms[0].emit("subscribed", {}, publication(), { identity: "media-alice" });
    await vi.waitFor(() => expect(fixture.controllers).toHaveLength(1));
    fixture.controllers[0].enqueue({ data: new Int16Array(320), sampleRate: SAMPLE_RATE, channels: 1 });
    controller.abort(); await task;
    expect(onChunk).not.toHaveBeenCalled();
  });
});
