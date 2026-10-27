import { schema, t } from "@colyseus/schema";
import { PROTOCOL_VERSION } from "../../../../shared/src/protocol.js";

export const Player = schema({
  userId: t.string(), sessionId: t.string(), displayName: t.string(),
  avatarId: t.string().default("guest"),
  x: t.float64(), y: t.float64(), facing: t.string().default("down"),
  status: t.string().default("available"), connected: t.boolean().default(true),
  zoneId: t.string().default(""), audioMode: t.string().default("floor"),
  lastProcessedInputSeq: t.float64().default(-1),
}, "Player");

/** Public occupancy only; LiveKit room names and epochs never enter synchronized state. */
export const MeetingIndicator = schema({
  zoneId: t.string(), meetingSessionId: t.string(), occupancy: t.number().default(0),
  videoAvailable: t.boolean().default(false), videoCallActive: t.boolean().default(false),
  assistantStatus: t.string().default("none"),
}, "MeetingIndicator");

/** Generic status only. Agents never join the player or audio collections. */
export const Agent = schema({
  agentId: t.string(), x: t.float64(), y: t.float64(),
  state: t.string().default("idle"), badge: t.string().default("AI"),
  sponsorUserId: t.string().default(""),
}, "Agent");

export const OfficeState = schema({
  officeId: t.string(), protocolVersion: t.number().default(PROTOCOL_VERSION),
  mapId: t.string(), mapVersion: t.number(), serverTick: t.float64().default(0),
  players: t.map(Player), meetings: t.map(MeetingIndicator), agents: t.map(Agent),
}, "OfficeState");
