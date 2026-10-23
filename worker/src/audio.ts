import type { AiCaptureJob } from "../../shared/src/ai-worker.js";

export const SAMPLE_RATE = 16_000;
export interface AudioChunk { speakerUserId: string; startMs: number; endMs: number; wav: Uint8Array }
export interface AudioCapture {
  run(job: AiCaptureJob, options: { signal: AbortSignal; chunkSeconds: number; onChunk(chunk: AudioChunk, signal: AbortSignal): Promise<void> }): Promise<void>;
}

/** PCM16 mono WAV, created entirely in memory; no raw audio is written to disk. */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(samples[i], 44 + i * 2);
  return wav;
}

/** Fixed memory bounds, independent of frame size or capture duration. */
export class PcmChunker {
  private samples: Int16Array;
  private length = 0;
  private startMs: number | undefined;
  constructor(seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 20) throw new Error("Invalid chunk length");
    this.samples = new Int16Array(SAMPLE_RATE * seconds);
  }
  push(frame: Int16Array, nowMs: number): Array<{ samples: Int16Array; startMs: number; endMs: number }> {
    const output: Array<{ samples: Int16Array; startMs: number; endMs: number }> = [];
    // RTC frames are configured to 20ms. Reject adversarial/invalid oversized frames.
    if (frame.length > SAMPLE_RATE) throw new Error("Oversized audio frame");
    let offset = 0;
    while (offset < frame.length) {
      this.startMs ??= Math.max(0, Math.floor(nowMs - frame.length * 1000 / SAMPLE_RATE));
      const count = Math.min(this.samples.length - this.length, frame.length - offset);
      this.samples.set(frame.subarray(offset, offset + count), this.length);
      this.length += count; offset += count;
      if (this.length === this.samples.length) {
        output.push({ samples: this.samples.slice(), startMs: this.startMs, endMs: this.startMs + this.length * 1000 / SAMPLE_RATE });
        this.discard();
      }
    }
    return output;
  }
  discard() { this.samples.fill(0); this.length = 0; this.startMs = undefined; }
}

export function createLiveKitCapture(): AudioCapture {
  return {
    async run(job, options) {
      // Lazy import keeps tests independent of native RTC libraries.
      const { Room, RoomEvent, AudioStream, TrackKind, TrackSource } = await import("@livekit/rtc-node");
      const room = new Room();
      const allowed = new Map(job.speakers.map((s) => [s.mediaIdentity, s.userId]));
      const readers = new Set<ReadableStreamDefaultReader<import("@livekit/rtc-node").AudioFrame>>();
      const tasks = new Set<Promise<void>>();
      const activeSpeakers = new Set<string>();
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      let disconnecting: Promise<void> | undefined;
      // The native SDK does not coalesce concurrent disconnect calls.
      const disconnect = () => room.isConnected ? (disconnecting ??= room.disconnect()) : Promise.resolve();
      let failure: unknown;
      const startedAt = performance.now();
      const fail = (error: unknown) => { failure ??= error; controller.abort(); };
      const onAbort = () => {
        for (const reader of readers) void reader.cancel().catch(() => {});
        void disconnect().catch(() => {});
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const permitted = (publication: import("@livekit/rtc-node").RemoteTrackPublication, participant: import("@livekit/rtc-node").RemoteParticipant) =>
        !signal.aborted && allowed.has(participant.identity) && publication.kind === TrackKind.KIND_AUDIO && publication.source === TrackSource.SOURCE_MICROPHONE;
      room.on(RoomEvent.TrackPublished, (publication, participant) => publication.setSubscribed(permitted(publication, participant)));
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (!permitted(publication, participant)) { publication.setSubscribed(false); return; }
        if (activeSpeakers.has(participant.identity)) { publication.setSubscribed(false); return; }
        activeSpeakers.add(participant.identity);
        const task = (async () => {
          const reader = new AudioStream(track, { sampleRate: SAMPLE_RATE, numChannels: 1, frameSizeMs: 20 }).getReader();
          readers.add(reader);
          const chunker = new PcmChunker(options.chunkSeconds);
          let pending: Promise<void> | undefined;
          try {
            while (!signal.aborted) {
              const { value: frame, done } = await reader.read();
              if (done || signal.aborted) break;
              if (frame.sampleRate !== SAMPLE_RATE || frame.channels !== 1) throw new Error("Unexpected PCM format");
              for (const chunk of chunker.push(frame.data, performance.now() - startedAt)) {
                if (pending) throw new Error("Transcription backpressure limit exceeded");
                const wav = encodeWav(chunk.samples);
                chunk.samples.fill(0);
                pending = options.onChunk({ speakerUserId: allowed.get(participant.identity)!, startMs: chunk.startMs, endMs: Math.floor(chunk.endMs), wav }, signal)
                  .catch((error) => { if (!signal.aborted) fail(error); })
                  .finally(() => { wav.fill(0); pending = undefined; });
              }
            }
          } catch (error) { if (!signal.aborted) fail(error); }
          finally {
            chunker.discard(); readers.delete(reader); activeSpeakers.delete(participant.identity);
            await reader.cancel().catch(() => {});
            await pending;
          }
        })().catch((error) => { if (!signal.aborted) fail(error); });
        tasks.add(task); void task.finally(() => tasks.delete(task));
      });
      room.on(RoomEvent.Disconnected, () => { if (!signal.aborted) fail(new Error("Media disconnected")); });
      // A reconnect can change publications/identity; fail closed and require a new job/consent.
      room.on(RoomEvent.Reconnecting, () => fail(new Error("Media interrupted")));
      try {
        if (signal.aborted) return;
        const connecting = room.connect(job.url.replace(/^http/, "ws"), job.token, { autoSubscribe: false, dynacast: false, dataStream: { maxPayloadByteLength: 1_024 } });
        // RTC connect itself has no AbortSignal API. Never subscribe after cancellation,
        // and dispose a late connection immediately if its native handshake finishes later.
        void connecting.then(() => { if (signal.aborted) return disconnect(); }).catch(() => {});
        const connectTimeout = setTimeout(() => fail(new Error("Media connection timed out")), 10_000);
        try {
          await Promise.race([connecting, new Promise<void>((resolve) => {
            if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
          })]);
        } finally { clearTimeout(connectTimeout); }
        if (signal.aborted) return;
        if (room.name !== job.roomName) throw new Error("Unexpected media room");
        for (const participant of room.remoteParticipants.values()) {
          for (const publication of participant.trackPublications.values()) publication.setSubscribed(permitted(publication, participant));
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      } finally {
        controller.abort(); onAbort();
        await disconnect();
        await Promise.allSettled(tasks);
        signal.removeEventListener("abort", onAbort);
      }
      if (failure) throw failure;
    },
  };
}
