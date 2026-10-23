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

export const OfficeState = schema({
  officeId: t.string(), protocolVersion: t.number().default(PROTOCOL_VERSION),
  mapId: t.string(), mapVersion: t.number(), serverTick: t.float64().default(0),
  players: t.map(Player),
}, "OfficeState");
