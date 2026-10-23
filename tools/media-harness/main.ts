import { Client, type Room as OfficeRoom } from "@colyseus/sdk";
import { Room, RoomEvent, Track, RemoteAudioTrack, setLogLevel, LogLevel } from "livekit-client";
import { PROTOCOL_VERSION, type GuestIdentity, type GuestSession, type PlayerState, type AudioPolicy, type MediaCredentials } from "../../shared/src/protocol.js";
import type { OfficeMap } from "../../shared/src/map-contract.js";

type State = { players: { values(): IterableIterator<PlayerState> } };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status"), mediaStatus = element("media-status"), policyText = element("policy");
const canvas = element<HTMLCanvasElement>("map"), context = canvas.getContext("2d")!;
const mic = element<HTMLButtonElement>("mic"), deafen = element<HTMLButtonElement>("deafen"), resume = element<HTMLButtonElement>("resume");
const audio = element<HTMLButtonElement>("audio"), republish = element<HTMLButtonElement>("republish"), leave = element<HTMLButtonElement>("leave");
const storageKey = "m2-media-harness.guest", preferenceKey = "m2-media-harness.preferences";
let token = sessionStorage.getItem(storageKey) ?? "", identity: GuestIdentity | undefined;
let office: OfficeRoom<State> | undefined, media: Room | undefined, map: OfficeMap | undefined;
let generation = 0, connecting = false, sequence = 0, revision = -1, micBusy = false;
let muted = true, deafened = false, microphoneActive = false, mediaConnections = 0;
try { const saved = JSON.parse(sessionStorage.getItem(preferenceKey) ?? "null") as { muted?: unknown; deafened?: unknown } | null; muted = saved?.muted !== false; deafened = saved?.deafened === true; } catch { /* Ignore invalid local preferences. */ }
const keys = new Set<string>(), gains = new Map<string, number>();
const playing = new Map<RemoteAudioTrack, { identity: string; gain: number; element: HTMLMediaElement }>();
// SDK log errors may contain signaling credentials; keep this harness's UI and console credential-free.
setLogLevel(LogLevel.silent);
const savePreferences = () => sessionStorage.setItem(preferenceKey, JSON.stringify({ muted, deafened }));
function controls() {
  resume.disabled = !token || connecting || Boolean(office);
  for (const button of [mic, deafen, audio]) button.disabled = !media || connecting || micBusy;
  leave.disabled = !office && !connecting;
  republish.disabled = !media || !microphoneActive || micBusy;
  mic.textContent = microphoneActive ? "Mute microphone" : (muted ? "Enable microphone" : "Re-enable microphone (saved on)");
  deafen.textContent = deafened ? "Undeafen" : "Deafen";
  element<HTMLButtonElement>("join").disabled = connecting || Boolean(office);
}
function preferences() { office?.send("media.preferences", { muted: !microphoneActive, deafened }); }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`Request failed (${response.status}). Check access, invite, and service availability.`);
  return await response.json() as T;
}
function reconcile() {
  if (!media) return;
  for (const participant of media.remoteParticipants.values()) for (const publication of participant.trackPublications.values()) {
    const wanted = !deafened && publication.source === Track.Source.Microphone && gains.has(participant.identity);
    if (publication.isDesired !== wanted) publication.setSubscribed(wanted);
    if (!wanted && publication.track instanceof RemoteAudioTrack) { publication.track.setVolume(0); const value = playing.get(publication.track); if (value) value.gain = 0; }
  }
}
function detach(track: RemoteAudioTrack) { track.setVolume(0); for (const el of track.detach()) el.remove(); playing.get(track)?.element.remove(); playing.delete(track); }
function stop(message: string) {
  generation++; connecting = false; keys.clear(); gains.clear(); revision = -1;
  const oldOffice = office, oldMedia = media; office = undefined; media = undefined;
  microphoneActive = false; micBusy = false;
  for (const track of playing.keys()) detach(track);
  if (oldMedia) { for (const pub of oldMedia.localParticipant.trackPublications.values()) pub.track?.stop(); void oldMedia.disconnect().catch(() => {}); }
  if (oldOffice) void oldOffice.leave().catch(() => {});
  status.textContent = message; mediaStatus.textContent = "Media stopped. Retry manually; microphone needs an explicit click.";
  policyText.textContent = "No active audio policy."; controls();
}
async function connect() {
  if (connecting || office) return;
  connecting = true; const attempt = ++generation; controls(); status.textContent = "Joining office…";
  let candidate: OfficeRoom<State> | undefined, live: Room | undefined;
  try {
    identity = await request<GuestIdentity>("/api/sessions/current");
    const path = `/api/offices/${encodeURIComponent(identity.officeId)}`;
    map = await request<OfficeMap>(`${path}/map`);
    const client = new Client(location.origin);
    const seat = await request<Parameters<Client["consumeSeatReservation"]>[0]>(`${path}/join`, { protocolVersion: PROTOCOL_VERSION });
    candidate = await client.consumeSeatReservation<State>(seat);
    if (attempt !== generation) { await candidate.leave(); return; }
    office = candidate; sequence = 0;
    candidate.onMessage("session.ready", () => {});
    candidate.onMessage("request.error", () => { status.textContent = "Server rejected a request. Disconnect/retry if this persists."; });
    candidate.onMessage("audio.policy", (policy: AudioPolicy) => {
      if (attempt !== generation || !Number.isSafeInteger(policy.revision) || policy.revision < revision || !Array.isArray(policy.speakers)) return;
      revision = policy.revision; gains.clear();
      for (const speaker of policy.speakers) if (typeof speaker.mediaIdentity === "string" && Number.isFinite(speaker.gain)) gains.set(speaker.mediaIdentity, Math.min(1, Math.max(0, speaker.gain)));
      policyText.textContent = `Policy revision ${revision} · LiveKit connects this page: ${mediaConnections}\n` + policy.speakers.map(s => `${s.mediaIdentity} · distance ${Number(s.distance).toFixed(2)} · gain ${Number(s.gain).toFixed(2)}`).join("\n");
      reconcile();
    });
    candidate.onDrop(() => { if (attempt === generation) stop("Office connection dropped. Media stopped; retry manually."); });
    candidate.onLeave(() => { if (attempt === generation) stop("Office disconnected. Retry manually (a held seat may need time to expire)."); });
    candidate.onError(() => { if (attempt === generation) stop("Office connection failed. Retry manually."); });
    preferences();
    const credentials = await request<MediaCredentials>("/api/media/token", { sessionId: candidate.sessionId });
    if (attempt !== generation) return;
    live = new Room({ adaptiveStream: false, dynacast: false }); media = live;
    live.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (!(track instanceof RemoteAudioTrack)) return;
      if (publication.source !== Track.Source.Microphone || deafened || !gains.has(participant.identity)) { publication.setSubscribed(false); track.setVolume(0); return; }
      track.setVolume(0); const el = track.attach(); element("audio-elements").append(el); playing.set(track, { identity: participant.identity, gain: 0, element: el });
    });
    live.on(RoomEvent.TrackUnsubscribed, track => { if (track instanceof RemoteAudioTrack) detach(track); });
    live.on(RoomEvent.TrackPublished, reconcile);
    live.on(RoomEvent.ParticipantConnected, reconcile);
    live.on(RoomEvent.Reconnecting, () => { if (attempt === generation) stop("Media connection interrupted. Media stopped; retry manually."); });
    live.on(RoomEvent.Disconnected, () => { if (attempt === generation) stop("Media disconnected. Retry manually."); });
    await live.connect(credentials.url, credentials.token, { autoSubscribe: false });
    if (attempt !== generation) { await live.disconnect(); return; }
    mediaConnections++; connecting = false; reconcile(); preferences(); controls();
    status.textContent = `Connected as ${identity.displayName}. Focus the map to move.`;
    mediaStatus.textContent = "LiveKit connected. Enable microphone explicitly; use Resume audio if playback is blocked."; canvas.focus();
  } catch { if (attempt === generation) stop("Connection failed. Check invite/session, service configuration, and network; retry manually."); else { void candidate?.leave().catch(() => {}); void live?.disconnect().catch(() => {}); } }
}
element<HTMLFormElement>("join-form").addEventListener("submit", event => { event.preventDefault(); void (async () => {
  try {
    const guest = await request<GuestSession>("/api/sessions/guest", { displayName: element<HTMLInputElement>("name").value, inviteCode: element<HTMLInputElement>("invite").value });
    token = guest.token; sessionStorage.setItem(storageKey, token); element<HTMLInputElement>("invite").value = ""; await connect();
  } catch { status.textContent = "Guest creation failed. Check invite and display name."; controls(); }
})(); });
resume.onclick = () => void connect(); leave.onclick = () => stop("Disconnected by you.");
element("forget").onclick = () => { stop("Saved guest forgotten. Create a new guest to join."); token = ""; sessionStorage.removeItem(storageKey); controls(); };
mic.onclick = () => { if (!media || micBusy) return; const current = media, attempt = generation; micBusy = true; controls(); void (async () => {
  try { await current.localParticipant.setMicrophoneEnabled(!microphoneActive); if (generation !== attempt) { for (const pub of current.localParticipant.trackPublications.values()) pub.track?.stop(); return; } microphoneActive = !microphoneActive; muted = !microphoneActive; savePreferences(); preferences(); mediaStatus.textContent = microphoneActive ? "Microphone on." : "Microphone muted."; }
  catch { microphoneActive = false; muted = true; savePreferences(); preferences(); mediaStatus.textContent = "Microphone unavailable or permission denied. Listening and movement remain available."; }
  finally { micBusy = false; controls(); }
})(); };
deafen.onclick = () => { deafened = !deafened; savePreferences(); if (deafened) for (const track of playing.keys()) { track.setVolume(0); const value = playing.get(track); if (value) value.gain = 0; } reconcile(); preferences(); controls(); };
audio.onclick = () => { void media?.startAudio().then(() => { mediaStatus.textContent = "Audio playback resumed."; }).catch(() => { mediaStatus.textContent = "Playback blocked. Check browser sound permissions and click again."; }); };
republish.onclick = () => { if (!media || micBusy) return; const current = media, attempt = generation; micBusy = true; controls(); void (async () => {
  try { for (const pub of current.localParticipant.trackPublications.values()) if (pub.source === Track.Source.Microphone && pub.track) await current.localParticipant.unpublishTrack(pub.track, true); microphoneActive = false; preferences(); if (attempt !== generation) return; await current.localParticipant.setMicrophoneEnabled(true); if (attempt !== generation) { for (const pub of current.localParticipant.trackPublications.values()) pub.track?.stop(); return; } microphoneActive = true; muted = false; savePreferences(); preferences(); }
  catch { microphoneActive = false; preferences(); mediaStatus.textContent = "Republish failed. Enable microphone to retry."; }
  finally { micBusy = false; controls(); }
})(); };
canvas.addEventListener("keydown", event => { const key = event.key.toLowerCase(); if (["w","a","s","d","arrowup","arrowleft","arrowdown","arrowright"].includes(key)) { event.preventDefault(); keys.add(key); } });
window.addEventListener("keyup", event => keys.delete(event.key.toLowerCase()));
window.addEventListener("blur", () => keys.clear()); canvas.addEventListener("blur", () => keys.clear());
window.addEventListener("pagehide", () => stop("Page closed."));
setInterval(() => { if (!office) return; const has = (...values: string[]) => values.some(key => keys.has(key)); office.send("player.input", { seq: ++sequence, dx: Number(has("d","arrowright")) - Number(has("a","arrowleft")), dy: Number(has("s","arrowdown")) - Number(has("w","arrowup")) }); preferences(); }, 100);
function frame() {
  for (const [track, value] of playing) { const target = deafened ? 0 : gains.get(value.identity) ?? 0; value.gain += (target - value.gain) * .2; track.setVolume(value.gain); }
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (map) {
    const scale = Math.min(canvas.width / map.width, canvas.height / map.height);
    context.save(); context.scale(scale, scale); context.lineWidth = 1 / scale;
    context.strokeStyle = "#c5cfdd"; for (let x=0;x<=map.width;x++) { context.beginPath(); context.moveTo(x,0); context.lineTo(x,map.height); context.stroke(); } for (let y=0;y<=map.height;y++) { context.beginPath(); context.moveTo(0,y); context.lineTo(map.width,y); context.stroke(); }
    for (const zone of map.meetingZones) { const b=zone.bounds; context.fillStyle="#ddd5ed"; context.fillRect(b.x,b.y,b.width,b.height); context.strokeStyle="#8a68a6"; context.strokeRect(b.x,b.y,b.width,b.height); context.fillStyle="#51396a"; context.font=".38px sans-serif"; context.fillText(`${zone.name} · future private audio`, b.x+.2,b.y+.6); }
    context.fillStyle="#43536b"; for (const b of map.blockedRects) context.fillRect(b.x,b.y,b.width,b.height); for (const b of map.blockedTiles) context.fillRect(b.x,b.y,1,1);
    if (office?.state?.players) for (const player of office.state.players.values()) { context.fillStyle=player.sessionId===office.sessionId ? "#2865dd" : "#008c83"; context.beginPath(); context.arc(player.x,player.y,.25,0,Math.PI*2); context.fill(); context.fillStyle="#16223a"; context.font=".42px sans-serif"; context.fillText(player.displayName,player.x+.35,player.y); }
    context.restore();
  }
  requestAnimationFrame(frame);
}
controls(); frame();
