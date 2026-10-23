import { createHash } from "node:crypto";
import { AccessToken, TokenVerifier, WebhookEvent } from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { LiveKitService, type LiveKitBackend, type MediaBinding } from "../src/services/LiveKitService.js";

const config = {
  livekitApiKey: "testkey", livekitApiSecret: "test-livekit-secret-at-least-thirty-two-characters",
  livekitInternalUrl: "http://livekit:7880", livekitPublicUrl: "wss://media.example.test",
};

function fixture(overrides: Partial<LiveKitBackend> = {}) {
  const backend = {
    issueToken: vi.fn(async (_binding: Readonly<MediaBinding>) => "signed-token"),
    removeParticipant: vi.fn(async (_room: string, _identity: string) => {}),
    deleteRoom: vi.fn(async (_room: string) => {}),
    verifyWebhook: vi.fn(async (body: string) => WebhookEvent.fromJsonString(body)),
    ...overrides,
  };
  return { backend, service: new LiveKitService(config, { backend }) };
}

function event(id: string, name: string, room: string, identity: string, sid = "PA_one", joinedAt = "1") {
  return WebhookEvent.fromJsonString(JSON.stringify({
    id, event: name, room: { name: room }, participant: { identity, sid, joinedAt },
  }));
}

describe("LiveKit credentials and authoritative bindings", () => {
  it("signs only microphone publication and subscription for an opaque floor and seat, with a 60-second TTL", async () => {
    const service = new LiveKitService(config);
    const identity = service.register("colyseus-room", "guest", "session", "Ada");
    const result = await service.issueToken("guest", "session");
    const verified = await new TokenVerifier(config.livekitApiKey, config.livekitApiSecret).verify(result.token);
    const claims = JSON.parse(Buffer.from(result.token.split(".")[1]!, "base64url").toString());
    expect(verified.sub).toBe(identity);
    expect(claims.name).toBe("Ada");
    expect(claims.video).toEqual({
      roomJoin: true, room: result.roomName, canPublish: true, canPublishSources: ["microphone"],
      canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false,
    });
    expect(result.roomName).toMatch(/^floor_/);
    expect(result.roomName).not.toContain("colyseus-room");
    expect(result.mediaIdentity).toBe(identity);
    expect(result.url).toBe(config.livekitPublicUrl);
    expect(claims.exp - claims.nbf).toBe(60);
    expect(result.expiresAt).toBe(new Date(claims.exp * 1000).toISOString());
    await expect(new TokenVerifier(config.livekitApiKey, "wrong-secret").verify(result.token)).rejects.toThrow();
  });

  it("keeps a connected identity stable, separates rooms, and uses a fresh identity on reconnect", async () => {
    const { service, backend } = fixture();
    const first = service.register("r", "u", "s", "Ada");
    expect(service.register("r", "u", "s", "Ada")).toBe(first);
    service.register("r", "v", "t", "Bob");
    service.register("other", "w", "x", "Eve");
    expect(service.getBinding("s")?.roomName).toBe(service.getBinding("t")?.roomName);
    expect(service.getBinding("s")?.roomName).not.toBe(service.getBinding("x")?.roomName);
    expect(() => service.register("r", "u", "duplicate", "Ada")).toThrow("FORBIDDEN");
    const oldRoom = service.getBinding("s")!.roomName;
    await service.issueToken("u", "s");
    await service.unregister("s");
    expect(backend.removeParticipant).toHaveBeenCalledWith(oldRoom, first);
    expect(service.register("r", "u", "s", "Ada")).not.toBe(first);
  });

  it("denies absent or mismatched seats without calling the signer", async () => {
    const { service, backend } = fixture();
    service.register("r", "owner", "s", "Ada");
    await expect(service.issueToken("intruder", "s")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.issueToken("owner", "missing")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(backend.issueToken).not.toHaveBeenCalled();
    const copy = service.getBinding("s")! as MediaBinding;
    copy.participantSid = "forged";
    expect(service.getBinding("s")?.participantSid).toBeUndefined();
  });

  it("rechecks the binding after asynchronous signing and revokes before participant removal completes", async () => {
    let resolveToken!: (token: string) => void;
    let resolveRemoval!: () => void;
    let issuance = 0;
    const { service } = fixture({
      issueToken: () => ++issuance === 1 ? Promise.resolve("first-token") : new Promise((resolve) => { resolveToken = resolve; }),
      removeParticipant: () => new Promise((resolve) => { resolveRemoval = resolve; }),
    });
    const identity = service.register("r", "u", "s", "Ada");
    await service.issueToken("u", "s");
    const pending = service.issueToken("u", "s");
    const removal = service.unregister("s");
    expect(service.getBinding("s")).toBeUndefined();
    expect(service.register("r", "u", "s", "Ada")).not.toBe(identity);
    resolveToken("old-token");
    await expect(pending).rejects.toMatchObject({ code: "FORBIDDEN" });
    resolveRemoval();
    await removal;
  });

  it("fails closed when signing, participant removal, or disposal fails", async () => {
    const { service, backend } = fixture({
      removeParticipant: async () => { throw new Error("network"); },
    });
    service.register("r", "u", "s", "Ada");
    vi.mocked(backend.issueToken).mockRejectedValueOnce(new Error("network"));
    await expect(service.issueToken("u", "s")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await service.issueToken("u", "s");
    await expect(service.unregister("s")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(service.issueToken("u", "s")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.dispose();
    expect(() => service.register("r", "u", "s", "Ada")).toThrow("UNAVAILABLE");
    await expect(service.issueToken("u", "s")).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});

describe("LiveKit lifecycle webhooks", () => {
  it("verifies SDK signatures against the exact raw body and rejects missing, forged, or changed authentication", async () => {
    const service = new LiveKitService(config);
    const body = '{ "id": "signed-event", "event": "room_started", "room": { "name": "floor" } }';
    const signer = new AccessToken(config.livekitApiKey, config.livekitApiSecret, { ttl: 60 });
    signer.sha256 = createHash("sha256").update(body).digest("base64");
    const authorization = await signer.toJwt();
    expect((await service.verifyWebhook(body, authorization)).id).toBe("signed-event");
    await expect(service.verifyWebhook(body)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(service.verifyWebhook(body, "forged")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(service.verifyWebhook(body + " ", authorization)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("evicts unbound, wrong-room, and replayed old identities without granting office access", async () => {
    const { service, backend } = fixture();
    const identity = service.register("r", "u", "s", "Ada");
    const room = service.getBinding("s")!.roomName;
    await service.handleWebhook(event("a", "participant_joined", room, "unbound"));
    await service.handleWebhook(event("b", "participant_joined", "wrong-room", identity));
    await service.unregister("s");
    service.register("r", "u", "s", "Ada");
    await service.handleWebhook(event("c", "participant_joined", room, identity));
    expect(backend.removeParticipant).toHaveBeenCalledWith(room, "unbound");
    expect(backend.removeParticipant).toHaveBeenCalledWith("wrong-room", identity);
    expect(backend.removeParticipant).toHaveBeenLastCalledWith(room, identity);
    expect(service.getBinding("s")?.mediaIdentity).not.toBe(identity);
  });

  it("ignores delayed left and joined events for previous participant SIDs", async () => {
    const { service } = fixture();
    const identity = service.register("r", "u", "s", "Ada");
    const room = service.getBinding("s")!.roomName;
    await service.handleWebhook(event("j1", "participant_joined", room, identity, "old", "1"));
    await service.handleWebhook(event("j2", "participant_joined", room, identity, "new", "2"));
    await service.handleWebhook(event("old-left", "participant_left", room, identity, "old"));
    await service.handleWebhook(event("delayed-old-join", "participant_joined", room, identity, "old", "1"));
    expect(service.getBinding("s")?.participantSid).toBe("new");
    await service.handleWebhook(event("new-left", "participant_left", room, identity, "new"));
    expect(service.getBinding("s")?.participantSid).toBeUndefined();
    await expect(service.issueToken("u", "s")).resolves.toMatchObject({ mediaIdentity: identity });
  });

  it("deduplicates event IDs, retries failures, expires dedupe entries, and bounds the cache", async () => {
    const backend = fixture().backend;
    let now = 0;
    const service = new LiveKitService(config, { backend, now: () => now });
    const joined = event("id", "participant_joined", "r", "unknown");
    vi.mocked(backend.removeParticipant).mockRejectedValueOnce(new Error("network"));
    await expect(service.handleWebhook(joined)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await service.handleWebhook(joined);
    await service.handleWebhook(joined);
    expect(backend.removeParticipant).toHaveBeenCalledTimes(2);
    now = 300_000;
    await service.handleWebhook(joined);
    expect(backend.removeParticipant).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 2048; i++) await service.handleWebhook(event(`bounded-${i}`, "room_started", "r", "unknown"));
    await service.handleWebhook(joined);
    expect(backend.removeParticipant).toHaveBeenCalledTimes(4);
  });

  it("cleans up every room binding and creates a fresh opaque room on reuse", async () => {
    const { service, backend } = fixture();
    service.register("r", "u", "s", "Ada");
    service.register("r", "v", "t", "Bob");
    const oldRoom = service.getBinding("s")!.roomName;
    await service.issueToken("u", "s");
    await service.cleanupRoom("r");
    expect(service.getBinding("s")).toBeUndefined();
    expect(service.getBinding("t")).toBeUndefined();
    expect(backend.deleteRoom).toHaveBeenCalledWith(oldRoom);
    service.register("r", "u", "s", "Ada");
    expect(service.getBinding("s")!.roomName).not.toBe(oldRoom);
  });
});
