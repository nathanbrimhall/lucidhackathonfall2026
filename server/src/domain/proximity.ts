export interface ProximityParticipant {
  sessionId: string;
  mediaIdentity: string;
  x: number;
  y: number;
  connected: boolean;
  audioMode: "floor" | "meeting";
  zoneId: string;
  muted: boolean;
  deafened: boolean;
}

export interface ProximitySpeaker {
  mediaIdentity: string;
  distance: number;
  gain: number;
}

const FULL_GAIN_DISTANCE = 2;
const GAIN_CUTOFF_DISTANCE = 6;
const UNSUBSCRIBE_DISTANCE = 7;

/**
 * Computes the listener's public-floor speakers from direct pairwise distance.
 * The caller may pass prior eligible identities to retain subscriptions through
 * the 6-to-7 tile hysteresis band. This function has no shared state.
 */
export function computeProximity(
  listener: ProximityParticipant,
  participants: Iterable<ProximityParticipant>,
  previousEligible: ReadonlySet<string> = new Set<string>(),
): ProximitySpeaker[] {
  if (!listener.connected || listener.audioMode !== "floor" || listener.deafened
    || !Number.isFinite(listener.x) || !Number.isFinite(listener.y)) return [];

  const byIdentity = new Map<string, ProximitySpeaker>();
  for (const speaker of participants) {
    if (!speaker.connected || speaker.audioMode !== "floor" || speaker.muted
      || speaker.sessionId === listener.sessionId || speaker.mediaIdentity === listener.mediaIdentity
      || speaker.zoneId !== listener.zoneId || !Number.isFinite(speaker.x) || !Number.isFinite(speaker.y)) continue;

    const distance = Math.hypot(speaker.x - listener.x, speaker.y - listener.y);
    if (distance > GAIN_CUTOFF_DISTANCE && !(previousEligible.has(speaker.mediaIdentity) && distance <= UNSUBSCRIBE_DISTANCE)) continue;
    const gain = distance <= FULL_GAIN_DISTANCE
      ? 1
      : distance >= GAIN_CUTOFF_DISTANCE
        ? 0
        : (GAIN_CUTOFF_DISTANCE - distance) / (GAIN_CUTOFF_DISTANCE - FULL_GAIN_DISTANCE);
    // Media identities are expected to be unique. If malformed input repeats
    // one, retain its closest instance deterministically.
    const existing = byIdentity.get(speaker.mediaIdentity);
    if (!existing || distance < existing.distance) byIdentity.set(speaker.mediaIdentity, { mediaIdentity: speaker.mediaIdentity, distance, gain });
  }

  return [...byIdentity.values()].sort((a, b) => a.mediaIdentity.localeCompare(b.mediaIdentity));
}
