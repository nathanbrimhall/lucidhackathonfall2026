import { TokenVerifier, WebhookEvent } from "livekit-server-sdk";
import { describe, expect, it, vi } from "vitest";
import { LiveKitService, type MediaBinding } from "../src/services/LiveKitService.js";

const config = {
  livekitApiKey: "testkey", livekitApiSecret: "test-livekit-secret-at-least-thirty-two-characters",
  livekitInternalUrl: "http://livekit:7880", livekitPublicUrl: "wss://media.example.test",
};
const ASSISTANT = "assistant_consent-revision-1";
const ROOM = "meet_current-epoch";
function fixture() {
  const backend = {
    issueToken: vi.fn(async (_binding: Readonly<MediaBinding>) => "member-token"),
    removeParticipant: vi.fn(async (_room: string, _identity: string) => {}),
    deleteRoom: vi.fn(async (_room: string) => {}),
    verifyWebhook: vi.fn(async (body: string) => WebhookEvent.fromJsonString(body)),
    listRooms: vi.fn(async () => [ROOM]), listParticipants: vi.fn(async (_room: string) => [ASSISTANT]),
  };
  const service = new LiveKitService(config, { backend });
  const memberIdentity = service.register("office-room", "ada-user", "ada-session", "Ada");
  const floorRoom = service.getBinding("ada-session")!.roomName;
  service.transition("ada-session", { revision: 1, mode: "meeting", zoneId: "east", meetingSessionId: "meeting-1", roomName: ROOM });
  return { service, backend, memberIdentity, floorRoom };
}
function event(id: string, name: string, room = ROOM, identity = ASSISTANT) {
  return WebhookEvent.fromJsonString(JSON.stringify({ id, event: name, room: { name: room }, participant: { identity, sid: `PA_${id}` } }));
}

describe("M4 read-only assistant media authorization", () => {
  it("signs a verified subscribe-only token for a current meeting epoch and rejects floor, unknown, retired, and disposed rooms", async () => {
    const { service, backend, floorRoom } = fixture();
    for (const room of [floorRoom, "meet_unknown", "floor_forged"]) {
      await expect(service.issueAssistant(room, ASSISTANT, 600)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    const token = await service.issueAssistant(ROOM, ASSISTANT, 600);
    const verified = await new TokenVerifier(config.livekitApiKey, config.livekitApiSecret).verify(token);
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
    expect(verified.sub).toBe(ASSISTANT);
    expect(claims.name).toBe("AI note taker");
    expect(claims.video).toEqual({ roomJoin: true, room: ROOM, canPublish: false, canSubscribe: true, canPublishData: false, canUpdateOwnMetadata: false });
    expect(claims.exp - claims.nbf).toBe(600);
    expect(backend.issueToken).not.toHaveBeenCalled();
    await service.removeAssistant(ASSISTANT);
    service.transition("ada-session", { revision: 2, mode: "meeting", zoneId: "east", meetingSessionId: "meeting-1", roomName: "meet_next" });
    await service.retireRoom(ROOM);
    await expect(service.issueAssistant(ROOM, ASSISTANT, 600)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service.dispose();
    await expect(service.issueAssistant("meet_next", ASSISTANT, 600)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("retains the active assistant on join and reconciliation only in its authorized room", async () => {
    const { service, backend, memberIdentity } = fixture();
    await service.issueAssistant(ROOM, ASSISTANT, 600);
    await service.handleWebhook(event("authorized-join", "participant_joined"));
    expect(backend.removeParticipant).not.toHaveBeenCalled();
    backend.listParticipants.mockResolvedValue([memberIdentity, ASSISTANT, "stranger"]);
    await service.reconcile();
    expect(backend.removeParticipant.mock.calls).toEqual([[ROOM, "stranger"]]);
    await service.handleWebhook(event("wrong-room", "participant_joined", "meet_other"));
    expect(backend.removeParticipant).toHaveBeenLastCalledWith("meet_other", ASSISTANT);
    expect(service.getBinding("ada-session")?.mediaIdentity).toBe(memberIdentity);
    await service.dispose();
  });

  it("removes authorization synchronously before remote removal finishes, then evicts replayed joins and reconciliation participants", async () => {
    const { service, backend } = fixture();
    await service.issueAssistant(ROOM, ASSISTANT, 600);
    let finishRemoval!: () => void;
    backend.removeParticipant.mockImplementationOnce(() => new Promise<void>(resolve => { finishRemoval = resolve; }));
    const removal = service.removeAssistant(ASSISTANT);
    expect(backend.removeParticipant).toHaveBeenCalledWith(ROOM, ASSISTANT);
    await service.handleWebhook(event("revoked-replay", "participant_joined"));
    expect(backend.removeParticipant).toHaveBeenCalledTimes(2);
    await service.reconcile();
    expect(backend.removeParticipant).toHaveBeenCalledTimes(3);
    finishRemoval(); await removal;
    await service.removeAssistant(ASSISTANT);
    expect(backend.removeParticipant).toHaveBeenCalledTimes(3);
    await service.dispose();
  });

  it("evicts an assistant attempting to publish even while its subscription authorization remains active", async () => {
    const { service, backend } = fixture();
    await service.issueAssistant(ROOM, ASSISTANT, 600);
    await service.handleWebhook(event("valid-subscribe", "participant_joined"));
    expect(backend.removeParticipant).not.toHaveBeenCalled();
    await service.handleWebhook(event("forbidden-publish", "track_published"));
    expect(backend.removeParticipant).toHaveBeenCalledExactlyOnceWith(ROOM, ASSISTANT);
    await service.removeAssistant(ASSISTANT);
    await service.dispose();
  });
});
