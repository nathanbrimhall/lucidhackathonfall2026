import { z } from "zod";
import { PROTOCOL_VERSION } from "./protocol.js";

export const joinOfficeSchema = z.strictObject({ protocolVersion: z.literal(PROTOCOL_VERSION) });
