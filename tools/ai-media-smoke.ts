/** Real self-hosted RTC transport with synthetic PCM, never an external speech-provider claim. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { AudioFrame, AudioSource, LocalAudioTrack, Room, TrackPublishOptions, TrackSource, dispose } from "@livekit/rtc-node";
import { createLiveKitCapture } from "../worker/src/audio.js";

const url = process.env.AI_SMOKE_LIVEKIT_URL;
if (!url) throw new Error("Set AI_SMOKE_LIVEKIT_URL for an isolated LiveKit instance without application webhooks");
const apiUrl = url.replace(/^ws/, "http");
const key = process.env.AI_SMOKE_API_KEY;
const secret = process.env.AI_SMOKE_API_SECRET;
if (!key || !secret) throw new Error("AI_SMOKE_API_KEY and AI_SMOKE_API_SECRET are required for the isolated test instance");
const name = `ai_smoke_${randomUUID()}`;
const mediaIdentity = `speaker_${randomUUID()}`;
const service = new RoomServiceClient(apiUrl, key, secret, { requestTimeout: 2, failover: false });
const publisher = new Room();
const source = new AudioSource(16_000, 1, 100);
const track = LocalAudioTrack.createAudioTrack("synthetic-microphone", source);
const cancellation = new AbortController();
const deadline = setTimeout(() => cancellation.abort(), 20_000);
let capture: Promise<void> | undefined;
let captured = 0;
async function token(identity: string, canPublish: boolean) {
  const access = new AccessToken(key!, secret!, { identity, ttl: 60 });
  access.addGrant({ roomJoin: true, room: name, canSubscribe: true, canPublish, canPublishData: false });
  return access.toJwt();
}
try {
  const readyDeadline = Date.now() + 10_000;
  for (;;) {
    let ready = false;
    try {
      const response = await fetch(apiUrl, { signal: AbortSignal.timeout(1_000) });
      ready = response.ok;
      await response.body?.cancel();
    } catch { /* The isolated container may still be starting. */ }
    if (ready) break;
    if (Date.now() >= readyDeadline || cancellation.signal.aborted) throw new Error("Isolated LiveKit did not become ready within 10 seconds");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await service.createRoom({ name, emptyTimeout: 60 });
  capture = createLiveKitCapture().run({
    id: "smoke", leaseToken: "smoke", aiSessionId: "smoke", revision: 1, kind: "capture", roomName: name,
    url, token: await token(`worker_${randomUUID()}`, false), speakers: [{ userId: "synthetic-user", mediaIdentity }], maxDurationSeconds: 20,
  }, {
    signal: cancellation.signal, chunkSeconds: 1,
    async onChunk(chunk) {
      assert.equal(chunk.speakerUserId, "synthetic-user");
      const wav = Buffer.from(chunk.wav);
      assert.equal(wav.toString("ascii", 0, 4), "RIFF");
      assert.equal(wav.readUInt32LE(24), 16_000);
      assert.equal(wav.length, 32_044);
      assert.ok(wav.subarray(44).some((byte) => byte !== 0), "Expected decoded PCM signal");
      assert.ok(chunk.endMs >= chunk.startMs + 1_000);
      captured++;
      cancellation.abort();
    },
  });
  // Observe immediately; a capture failure must not become an unhandled rejection.
  void capture.catch(() => cancellation.abort());
  await publisher.connect(url, await token(mediaIdentity, true), { autoSubscribe: false, dynacast: false });
  const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
  await publisher.localParticipant!.publishTrack(track, options);
  for (let frameIndex = 0; frameIndex < 500 && !cancellation.signal.aborted; frameIndex++) {
    const samples = new Int16Array(320);
    for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin((frameIndex * 320 + i) * 2 * Math.PI * 440 / 16_000) * 8_000);
    await source.captureFrame(new AudioFrame(samples, 16_000, 1, 320));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  cancellation.abort();
  await capture;
  assert.equal(captured, 1, "Expected one real decoded microphone WAV chunk");
  console.info("AI media smoke passed: real self-hosted LiveKit microphone PCM -> bounded speaker-labelled WAV; no speech-provider call.");
} finally {
  clearTimeout(deadline); cancellation.abort();
  await capture?.catch(() => {});
  await publisher.disconnect(); await track.close(); await source.close();
  await service.deleteRoom(name).catch(() => {});
  await dispose();
}
