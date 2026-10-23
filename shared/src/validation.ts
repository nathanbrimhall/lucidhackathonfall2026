import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol.js";

export const joinOfficeSchema = z.strictObject({ protocolVersion: z.literal(PROTOCOL_VERSION) });

/** Strict intent-only payload; clients cannot submit coordinates or timing. */
export const playerInputSchema = z.strictObject({
  seq: z.number().int().safe().nonnegative(),
  dx: z.number().finite().min(-1).max(1),
  dy: z.number().finite().min(-1).max(1),
});

export const playerStatusSchema = z.strictObject({
  status: z.enum(["available", "away", "busy"]),
});
