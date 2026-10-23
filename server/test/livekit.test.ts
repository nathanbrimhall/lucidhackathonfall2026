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

describe("LiveKit meeting transitions and epochs", () => {
  const meeting = (revision: number, roomName: string) => ({ revision, mode: "meeting" as const, zoneId: "zone", meetingSessionId: "meeting-1", roomName });
  function deferred<T = void>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it("invalidates the old room immediately and gates destination credentials on revision, ack and removal", async () => {
    const { service, backend } = fixture();
    const identity = service.register("r", "u", "s", "Ada");
    const floor = await service.issueToken("u", "s");
    expect(floor).toMatchObject({ transitionRevision: 0, mode: "floor", zoneId: "" });
    expect(floor).not.toHaveProperty("meetingSessionId");
    service.transition("s", meeting(1, "meet_one"));
    expect(service.getBinding("s")).toMatchObject({ roomName: "meet_one", transitionRevision: 1, pending: true, acked: false, mode: "meeting" });
    expect(backend.removeParticipant).toHaveBeenCalledWith(floor.roomName, identity);
    await expect(service.issueToken("u", "s")).rejects.toMatchObject({ code: "TRANSITION_PENDING" });
    await expect(service.issueToken("u", "s", 0)).rejects.toMatchObject({ code: "STALE_TRANSITION" });
    await expect(service.issueToken("u", "s", 2)).rejects.toMatchObject({ code: "STALE_TRANSITION" });
    await expect(service.issueToken("u", "s", 1)).rejects.toMatchObject({ code: "TRANSITION_PENDING" });
    expect(service.acknowledge("s", 0)).toBe(false);
    expect(service.acknowledge("s", 2)).toBe(false);
    expect(service.acknowledge("s", 1)).toBe(true);
    expect(backend.issueToken).toHaveBeenCalledTimes(1);
    const credentials = await service.issueToken("u", "s", 1);
    expect(credentials).toMatchObject({ roomName: "meet_one", mediaIdentity: identity, transitionRevision: 1, mode: "meeting", zoneId: "zone", meetingSessionId: "meeting-1" });
    expect(vi.mocked(backend.issueToken).mock.lastCall![0]).toMatchObject({ roomName: "meet_one", transitionRevision: 1 });
    expect(service.getBinding("s")).toMatchObject({ pending: false });
    await expect(service.issueToken("u", "s")).resolves.toMatchObject({ roomName: "meet_one" });
    service.transition("s", { revision: 1, mode: "floor", zoneId: "" });
    expect(service.getBinding("s")?.roomName).toBe("meet_one");
    service.transition("s", { revision: 2, mode: "floor", zoneId: "" });
    expect(service.getBinding("s")).toMatchObject({ roomName: floor.roomName, zoneId: "", meetingSessionId: undefined, pending: true });
    expect(backend.removeParticipant).toHaveBeenLastCalledWith("meet_one", identity);
    expect(() => service.transition("s", { ...meeting(3, "floor_forged") })).toThrow("INVALID_INPUT");
  });

  it("rejects credentials whose transition changed during removal or signing", async () => {
    const removal = deferred(), signing = deferred<string>();
    const { service, backend } = fixture({ removeParticipant: vi.fn(() => removal.promise) });
    service.register("r", "u", "s", "Ada");
    await service.issueToken("u", "s");
    service.transition("s", meeting(1, "meet_one"));
    service.acknowledge("s", 1);
    const waiting = service.issueToken("u", "s", 1);
    service.transition("s", meeting(2, "meet_two"));
    removal.resolve();
    await expect(waiting).rejects.toMatchObject({ code: "STALE_TRANSITION" });
    expect(backend.issueToken).toHaveBeenCalledTimes(1);
    service.acknowledge("s", 2);
    vi.mocked(backend.issueToken).mockImplementationOnce(() => signing.promise);
    const signed = service.issueToken("u", "s", 2);
    await vi.waitFor(() => expect(backend.issueToken).toHaveBeenCalledTimes(2));
    service.transition("s", { revision: 3, mode: "floor", zoneId: "" });
    signing.resolve("meeting-token");
    await expect(signed).rejects.toMatchObject({ code: "STALE_TRANSITION" });
    service.acknowledge("s", 3);
    // meet_two was never issued, so the floor return needs no removal.
    await expect(service.issueToken("u", "s", 3)).resolves.toMatchObject({ mode: "floor", transitionRevision: 3 });
  });

  it("keeps a seat pending without credentials until old-room removal succeeds", async () => {
    const { service, backend } = fixture();
    const identity = service.register("r", "u", "s", "Ada");
    const floor = await service.issueToken("u", "s");
    vi.mocked(backend.removeParticipant).mockRejectedValueOnce(new Error("network"));
    service.transition("s", meeting(1, "meet_one"));
    service.acknowledge("s", 1);
    await expect(service.issueToken("u", "s", 1)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(service.getBinding("s")).toMatchObject({ pending: true, roomName: "meet_one" });
    expect(backend.issueToken).toHaveBeenCalledTimes(1);
    await expect(service.issueToken("u", "s", 1)).resolves.toMatchObject({ roomName: "meet_one" });
    expect(vi.mocked(backend.removeParticipant).mock.calls.filter(([room, id]) => room === floor.roomName && id === identity)).toHaveLength(2);
  });

  it("evicts any identity joining a retired epoch and deletes it", async () => {
    const { service, backend } = fixture();
    const ada = service.register("r", "u", "s", "Ada"), bob = service.register("r", "v", "t", "Bob");
    for (const [user, session] of [["u", "s"], ["v", "t"]]) {
      service.transition(session, meeting(1, "meet_old")); service.acknowledge(session, 1);
      await service.issueToken(user, session, 1);
    }
    service.transition("s", meeting(2, "meet_new"));
    service.transition("t", { revision: 2, mode: "floor", zoneId: "" });
    await service.retireRoom("meet_old");
    expect(backend.deleteRoom).toHaveBeenCalledWith("meet_old");
    vi.mocked(backend.removeParticipant).mockClear();
    await service.handleWebhook(event("replay-bob", "participant_joined", "meet_old", bob));
    await service.handleWebhook(event("replay-ada", "participant_joined", "meet_old", ada));
    await service.handleWebhook(event("bob-pub", "track_published", "meet_new", bob));
    expect(vi.mocked(backend.removeParticipant).mock.calls).toEqual([["meet_old", bob], ["meet_old", ada], ["meet_new", bob]]);
    await expect(service.retireRoom("floor_x")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("cleans up floor and current meeting rooms, including on disposal", async () => {
    const { service, backend } = fixture();
    service.register("r", "u", "s", "Ada");
    const floor = service.getBinding("s")!.roomName;
    await service.issueToken("u", "s");
    service.transition("s", meeting(1, "meet_live"));
    await service.cleanupRoom("r");
    expect(backend.deleteRoom).toHaveBeenCalledWith(floor);
    expect(backend.deleteRoom).toHaveBeenCalledWith("meet_live");
    service.register("other", "v", "t", "Bob");
    service.transition("t", meeting(1, "meet_other"));
    await service.unregister("t");
    await service.dispose();
    expect(backend.deleteRoom).toHaveBeenCalledWith("meet_other");
  });

  it("does not issue a room while a webhook eviction from it is still in flight", async () => {
    const eviction = deferred();
    const { service, backend } = fixture();
    const identity = service.register("r", "u", "s", "Ada");
    const floor = service.getBinding("s")!.roomName;
    service.transition("s", meeting(1, "meet_one")); service.acknowledge("s", 1);
    await service.issueToken("u", "s", 1);
    vi.mocked(backend.removeParticipant).mockImplementation((room) => room === floor ? eviction.promise : Promise.resolve());
    const webhook = service.handleWebhook(event("stale-floor", "participant_joined", floor, identity));
    service.transition("s", { revision: 2, mode: "floor", zoneId: "" }); service.acknowledge("s", 2);
    let settled = false;
    const issued = service.issueToken("u", "s", 2).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(backend.issueToken).toHaveBeenCalledTimes(1);
    eviction.resolve();
    await expect(issued).resolves.toMatchObject({ roomName: floor, transitionRevision: 2 });
    await webhook;
  });

  it("retries a failed retired-room deletion on cleanup and disposal", async () => {
    const { service, backend } = fixture({ listRooms: vi.fn(async () => ["meet_old"]), listParticipants: vi.fn(async () => []) });
    service.register("r", "u", "s", "Ada");
    service.transition("s", meeting(1, "meet_old"));
    service.transition("s", meeting(2, "meet_new"));
    vi.mocked(backend.deleteRoom).mockRejectedValueOnce(new Error("network"));
    await expect(service.retireRoom("meet_old")).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await service.reconcile();
    expect(vi.mocked(backend.deleteRoom).mock.calls.filter(([room]) => room === "meet_old")).toHaveLength(2);
    vi.mocked(backend.deleteRoom).mockRejectedValueOnce(new Error("network"));
    await service.retireRoom("meet_new").catch(() => {});
    vi.mocked(backend.deleteRoom).mockClear();
    await service.cleanupRoom("r");
    expect(vi.mocked(backend.deleteRoom).mock.calls.map(([room]) => room).sort()).toEqual(["meet_new"]);
    vi.mocked(backend.deleteRoom).mockClear();
    await service.dispose();
    expect(backend.deleteRoom).not.toHaveBeenCalled();

    const other = fixture();
    other.service.register("r", "u", "s", "Ada");
    other.service.transition("s", meeting(1, "meet_stuck"));
    other.service.transition("s", { revision: 2, mode: "floor", zoneId: "" });
    vi.mocked(other.backend.deleteRoom).mockRejectedValueOnce(new Error("network"));
    await other.service.retireRoom("meet_stuck").catch(() => {});
    await other.service.dispose();
    expect(vi.mocked(other.backend.deleteRoom).mock.calls.filter(([room]) => room === "meet_stuck")).toHaveLength(2);
  });

  it("reconciles orphaned rooms and unbound participants without touching current seats", async () => {
    const listParticipants = vi.fn(async (_room: string) => ["stranger"]);
    const { service, backend } = fixture({ listRooms: vi.fn(async () => [] as string[]), listParticipants });
    const identity = service.register("r", "u", "s", "Ada");
    const floor = service.getBinding("s")!.roomName;
    service.transition("s", meeting(1, "meet_live"));
    listParticipants.mockImplementation(async (room) => room === "meet_live" ? [identity, "stranger"] : [identity]);
    vi.mocked(backend.listRooms!).mockResolvedValue([floor, "meet_live", "meet_orphan", "floor_orphan", "unmanaged"]);
    await service.reconcile();
    expect(vi.mocked(backend.deleteRoom).mock.calls.map(([room]) => room).sort()).toEqual(["floor_orphan", "meet_orphan"]);
    expect(vi.mocked(backend.removeParticipant).mock.calls).toEqual(expect.arrayContaining([["meet_live", "stranger"], [floor, identity]]));
    expect(backend.removeParticipant).not.toHaveBeenCalledWith("meet_live", identity);
    vi.mocked(backend.listRooms!).mockRejectedValueOnce(new Error("network"));
    await expect(service.reconcile()).rejects.toThrow();
    vi.mocked(backend.deleteRoom).mockRejectedValueOnce(new Error("network"));
    await expect(service.reconcile()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
