import { Room, ServerError, type Client } from "@colyseus/core";
import { schema, t } from "@colyseus/schema";
import { PROTOCOL_VERSION } from "../../../shared/src/protocol.js";
import { joinOfficeSchema } from "../../../shared/src/validation.js";
import { AuthError, type AuthService } from "../auth/AuthService.js";

// M0 validates identity and exercises schema patches. Player/movement state arrives in M1.
const FoundationState = schema({ officeId: t.string(), protocolVersion: t.number().default(PROTOCOL_VERSION) });

export function createOfficeRoom(auth: AuthService, officeId: string) {
  return class OfficeRoom extends Room<{ state: InstanceType<typeof FoundationState> }> {
    maxClients = 20;
    state = new FoundationState({ officeId });

    static async onAuth(token: string, options: unknown) {
      if (!joinOfficeSchema.safeParse(options).success) throw new ServerError(400, "INVALID_INPUT");
      try { return { identity: auth.authenticate(token), token }; }
      catch (error) {
        throw new ServerError(error instanceof AuthError && error.code === "FORBIDDEN" ? 403 : 401, error instanceof AuthError ? error.code : "UNAUTHORIZED");
      }
    }

    onJoin(client: Client) {
      // Revalidate after seat reservation; identity must still be authorized when consumed.
      let identity;
      try { identity = auth.authenticate(client.auth?.token); }
      catch { throw new ServerError(401, "UNAUTHORIZED"); }
      if (identity.officeId !== officeId) throw new ServerError(403, "FORBIDDEN");
      client.auth = identity;
      client.send("session.ready", { ...identity, sessionId: client.sessionId, protocolVersion: PROTOCOL_VERSION });
    }
  };
}
