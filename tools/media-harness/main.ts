import { Client, type Room as OfficeRoom } from "@colyseus/sdk";
import { Room, RoomEvent, Track, RemoteAudioTrack, DisconnectReason, setLogLevel, LogLevel } from "livekit-client";
import { PROTOCOL_VERSION, type GuestIdentity, type GuestSession, type PlayerState, type AudioPolicy, type AudioMode, type MediaCredentials, type MediaTransition, type MeetingEntered, type MeetingExited, type AIStatus, type NoteRecord, type DraftClaim } from "../../shared/src/protocol.js";
import type { OfficeMap } from "../../shared/src/map-contract.js";

type State = { players: { values(): IterableIterator<PlayerState> }; meetings?: { get(zoneId: string): { occupancy: number } | undefined } };
type NoteItem = DraftClaim;
type Note = NoteRecord;
type NotesResponse = { notes: Note[] };
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status"), mediaStatus = element("media-status"), policyText = element("policy"), meetingText = element("meeting");
const canvas = element<HTMLCanvasElement>("map"), context = canvas.getContext("2d")!;
const mic = element<HTMLButtonElement>("mic"), deafen = element<HTMLButtonElement>("deafen"), resume = element<HTMLButtonElement>("resume");
const retryMedia = element<HTMLButtonElement>("retry-media"), audio = element<HTMLButtonElement>("audio"), republish = element<HTMLButtonElement>("republish"), leave = element<HTMLButtonElement>("leave");
const aiRequest = element<HTMLButtonElement>("ai-request"), aiConsent = element<HTMLButtonElement>("ai-consent"), aiDecline = element<HTMLButtonElement>("ai-decline"), aiWithdraw = element<HTMLButtonElement>("ai-withdraw"), aiStop = element<HTMLButtonElement>("ai-stop");
const storageKey = "media-harness.guest", preferenceKey = "media-harness.preferences";
let token = sessionStorage.getItem(storageKey) ?? "", identity: GuestIdentity | undefined;
let office: OfficeRoom<State> | undefined, media: Room | undefined, map: OfficeMap | undefined;
let generation = 0, connecting = false, sequence = 0, revision = -1, micBusy = false;
let meetingSessionId = "", aiState: AIStatus | undefined, localAIDecision: boolean | undefined, displayedConsentRevision = -1, displayedConsentSession = "", aiRequestPending = false;
// target: the media room (mode/zone) this page expects; policies for any other target are ignored. mediaEpoch invalidates in-flight transition work.
let target: { mode: AudioMode; zoneId: string } = { mode: "floor", zoneId: "" }, transitionRev = -1, mediaEpoch = 0, micIntent = false, lastPolicy: AudioPolicy | undefined, failed: MediaTransition | undefined;
const intentional = new WeakSet<Room>(), delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(`Request failed (${status}).`); } }
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
  retryMedia.disabled = !office || !failed;
  republish.disabled = !media || !microphoneActive || micBusy;
  mic.textContent = microphoneActive ? "Mute microphone" : (muted ? "Enable microphone" : "Re-enable microphone (saved on)");
  deafen.textContent = deafened ? "Undeafen" : "Deafen";
  element<HTMLButtonElement>("join").disabled = connecting || Boolean(office);
  const inMeeting = Boolean(office && meetingSessionId);
  aiRequest.disabled = !inMeeting || !media || aiRequestPending || Boolean(aiState && !["completed", "canceled", "failed"].includes(aiState.status));
  const waiting = Boolean(aiState && ["requesting_consent", "paused"].includes(aiState.status));
  aiConsent.disabled = !inMeeting || !waiting;
  aiDecline.disabled = !inMeeting || !waiting;
  const selfConsented = Boolean(aiState?.roster.some(person => person.userId === identity?.userId && person.consented));
  aiWithdraw.disabled = !inMeeting || !aiState || !["capturing", "paused", "processing", "requesting_consent"].includes(aiState.status) || !selfConsented;
  aiStop.disabled = !inMeeting || !aiState || !["capturing", "paused", "requesting_consent"].includes(aiState.status);
}
function preferences() { office?.send("media.preferences", { muted: !microphoneActive, deafened }); }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) { let code = ""; try { code = String(((await response.json()) as { error?: { code?: unknown } }).error?.code ?? ""); } catch { /* No JSON error body. */ } throw new HttpError(response.status, code); }
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
  generation++; mediaEpoch++; connecting = false; keys.clear(); gains.clear(); revision = -1;
  target = { mode: "floor", zoneId: "" }; transitionRev = -1; micIntent = false; lastPolicy = undefined; failed = undefined; meetingText.textContent = ""; meetingSessionId = ""; aiState = undefined; localAIDecision = undefined; aiRequestPending = false; renderAI();
  const oldOffice = office, oldMedia = media; office = undefined; media = undefined;
  microphoneActive = false; micBusy = false;
  for (const track of playing.keys()) detach(track);
  if (oldMedia) { intentional.add(oldMedia); for (const pub of oldMedia.localParticipant.trackPublications.values()) pub.track?.stop(); void oldMedia.disconnect().catch(() => {}); }
  if (oldOffice) void oldOffice.leave().catch(() => {});
  status.textContent = message; mediaStatus.textContent = "Media stopped. Retry manually; microphone needs an explicit click.";
  policyText.textContent = "No active audio policy."; controls();
}
function addText(parent: HTMLElement, tag: keyof HTMLElementTagNameMap, value: unknown, className?: string) {
  const node = document.createElement(tag); node.textContent = String(value ?? ""); if (className) node.className = className; parent.append(node); return node;
}
function renderAI() {
  const statusNode = element("ai-status"), rosterNode = element("ai-roster");
  statusNode.textContent = aiState ? `AI notes: ${aiState.status}${aiState.status === "capturing" ? ` · ${aiState.committedSegments ?? 0} speech excerpts transcribed` : ""}${aiState.error ? ` — ${aiState.error}` : ""}` : (meetingSessionId ? "AI notes have not been requested for this meeting." : "Enter a meeting room to request AI notes.");
  rosterNode.replaceChildren();
  if (aiState) {
    if (displayedConsentRevision !== aiState.revision || displayedConsentSession !== aiState.aiSessionId) {
      displayedConsentRevision = aiState.revision; displayedConsentSession = aiState.aiSessionId; localAIDecision = undefined;
      element("ai-roster-note").textContent = "The consent revision changed. Review the current roster and make a new decision.";
    }
    for (const person of aiState.roster) addText(rosterNode, "li", `${person.displayName} — ${person.consented ? "consented" : "has not consented"}`);
    if (!aiState.roster.length) addText(rosterNode, "li", "No participants reported.");
    if (localAIDecision !== undefined) element("ai-roster-note").textContent = localAIDecision ? "You consented for this roster revision." : "You declined for this roster revision.";
  } else element("ai-roster-note").textContent = "Every current occupant must decide for capture to begin. A roster change resets consent.";
  controls();
}
function renderNote(note: Note) {
  const article = document.createElement("article"); article.className = "note";
  addText(article, "h3", `Draft note · ${new Date(note.createdAt).toLocaleString()}${note.partial ? " · partial" : ""}`);
  const addSection = (title: string, entries: NoteItem[]) => {
    addText(article, "h4", title);
    const list = document.createElement("ul");
    for (const entry of entries ?? []) {
      const li = document.createElement("li"); li.textContent = entry.text;
      if (entry.segmentIds?.length) addText(li, "small", `Sources: ${entry.segmentIds.join(", ")}`);
      list.append(li);
    }
    if (!entries?.length) addText(list, "li", "None"); article.append(list);
  };
  addSection("Summary", note.draft.summary ?? []); addSection("Decisions", note.draft.decisions ?? []);
  addSection("Action items", (note.draft.actionItems ?? []).map(item => ({ ...item, text: `${item.text}${item.ownerUserId ? ` · owner ${item.ownerUserId}` : " · owner unset"}${item.dueAt ? ` · due ${item.dueAt}` : " · due date unset"}` })));
  return article;
}
async function loadNotes(openId?: string) {
  const list = element("notes-list"), detail = element("note-detail");
  list.textContent = "Loading notes…";
  try {
    const result = await request<NotesResponse>("/api/notes"); list.replaceChildren();
    if (!result.notes?.length) addText(list, "p", "No notes available.");
    for (const note of result.notes ?? []) {
      const row = document.createElement("div"); row.className = "note-row";
      addText(row, "span", `${new Date(note.createdAt).toLocaleString()}${note.partial ? " · partial" : ""}`);
      const open = document.createElement("button"); open.type = "button"; open.textContent = "View draft"; open.onclick = () => void loadNotes(note.id); row.append(open); list.append(row);
    }
    if (openId) {
      const note = await request<Note>(`/api/notes/${encodeURIComponent(openId)}`); detail.replaceChildren(renderNote(note));
    }
  } catch { list.textContent = "Could not load notes. Check your connection and try again."; if (openId) detail.textContent = "Could not load this note."; }
}
function decideAI(consent: boolean) {
  if (!office || !aiState || !meetingSessionId || !["requesting_consent", "paused"].includes(aiState.status)) return;
  office.send("ai.consent", { aiSessionId: aiState.aiSessionId, revision: aiState.revision, consent });
  localAIDecision = consent; renderAI();
}
function renderPolicy() {
  const policy = lastPolicy; if (!policy || policy.mode !== target.mode || policy.zoneId !== target.zoneId) return;
  gains.clear();
  for (const speaker of policy.speakers) if (typeof speaker.mediaIdentity === "string" && Number.isFinite(speaker.gain)) gains.set(speaker.mediaIdentity, Math.min(1, Math.max(0, speaker.gain)));
  policyText.textContent = `Policy revision ${policy.revision} · mode ${policy.mode}${policy.zoneId ? ` (${policy.zoneId})` : ""} · LiveKit connects this page (grows on room transitions): ${mediaConnections}\n` + policy.speakers.map(s => `${s.mediaIdentity} · distance ${Number(s.distance).toFixed(2)} · gain ${Number(s.gain).toFixed(2)}`).join("\n");
  reconcile();
}
async function dropMedia() {
  const old = media; media = undefined; microphoneActive = false; micBusy = false; gains.clear();
  for (const track of [...playing.keys()]) detach(track);
  if (old) { intentional.add(old); for (const pub of old.localParticipant.trackPublications.values()) pub.track?.stop(); await old.disconnect().catch(() => {}); }
  policyText.textContent = "Switching audio room; no active audio policy."; controls();
}
// Connects to credentials' room if this page's office connection and media epoch are still current. Mic is re-enabled only when resumeMic (it was on before the transition).
async function attachMedia(attempt: number, epoch: number, credentials: MediaCredentials, resumeMic: boolean): Promise<boolean> {
  const current = () => attempt === generation && epoch === mediaEpoch;
  const live = new Room({ adaptiveStream: false, dynacast: false }); media = live;
  const mine = () => current() && media === live && !intentional.has(live);
  live.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (!(track instanceof RemoteAudioTrack)) return;
    if (!mine() || publication.source !== Track.Source.Microphone || deafened || !gains.has(participant.identity)) { publication.setSubscribed(false); track.setVolume(0); return; }
    track.setVolume(0); const el = track.attach(); element("audio-elements").append(el); playing.set(track, { identity: participant.identity, gain: 0, element: el });
  });
  live.on(RoomEvent.TrackUnsubscribed, track => { if (track instanceof RemoteAudioTrack) detach(track); });
  live.on(RoomEvent.TrackPublished, () => { if (mine()) reconcile(); });
  live.on(RoomEvent.ParticipantConnected, () => { if (mine()) reconcile(); });
  // Transition-driven disconnects are marked intentional; any other loss fails closed.
  live.on(RoomEvent.Reconnecting, () => { if (mine()) stop("Media connection interrupted. Media stopped; retry manually."); });
  live.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
    if (intentional.has(live) || !current()) return;
    if (reason !== DisconnectReason.PARTICIPANT_REMOVED || !office) { stop("Media disconnected. Retry manually."); return; }
    // Server-side removal can outrun its media.transition message; keep mic intent and fail closed only if none arrives.
    micIntent = microphoneActive; void dropMedia(); mediaStatus.textContent = "Removed from audio room by server; waiting for room change…";
    const waiting = mediaEpoch; void delay(3000).then(() => { if (current() && mediaEpoch === waiting) stop("Media removed by server. Retry manually."); });
  });
  try { await live.connect(credentials.url, credentials.token, { autoSubscribe: false }); }
  catch (error) { intentional.add(live); if (media === live) media = undefined; void live.disconnect().catch(() => {}); throw error; }
  if (!current()) { intentional.add(live); if (media === live) media = undefined; await live.disconnect().catch(() => {}); return false; }
  mediaConnections++; connecting = false; failed = undefined;
  target = { mode: credentials.mode, zoneId: credentials.zoneId }; renderPolicy(); preferences(); controls();
  status.textContent = `Connected as ${identity?.displayName ?? "guest"}. Focus the map to move.`;
  mediaStatus.textContent = resumeMic ? "LiveKit connected. Restoring microphone…" : "LiveKit connected. Enable microphone explicitly; use Resume audio if playback is blocked.";
  canvas.focus();
  if (resumeMic) {
    micBusy = true; controls();
    try { await live.localParticipant.setMicrophoneEnabled(true); if (!mine()) { for (const pub of live.localParticipant.trackPublications.values()) pub.track?.stop(); return true; } microphoneActive = true; muted = false; mediaStatus.textContent = "Microphone on."; }
    catch { microphoneActive = false; muted = true; savePreferences(); mediaStatus.textContent = "Microphone unavailable after room change. Enable it manually."; }
    finally { if (current()) { micBusy = false; preferences(); controls(); } }
  }
  return true;
}
// Fetch credentials; 409 TRANSITION_PENDING retries briefly, 409 STALE_TRANSITION abandons (a newer transition drives), anything else throws.
async function mediaCredentials(attempt: number, epoch: number, rev?: number): Promise<MediaCredentials | undefined> {
  for (let tries = 0; ; tries++) {
    if (attempt !== generation || epoch !== mediaEpoch || !office) return;
    try { return await request<MediaCredentials>("/api/media/token", { sessionId: office.sessionId, ...(rev === undefined ? {} : { transitionRevision: rev }) }); }
    catch (error) {
      if (attempt !== generation || epoch !== mediaEpoch) return;
      if (error instanceof HttpError && error.code === "STALE_TRANSITION") { mediaStatus.textContent = "Media transition superseded; waiting for the newest one."; return; }
      if (error instanceof HttpError && error.code === "TRANSITION_PENDING" && tries < 40) { await delay(Math.min(1000, 150 + tries * 100)); continue; }
      throw error;
    }
  }
}
async function transition(t: MediaTransition) {
  const attempt = generation;
  if (!office || !Number.isSafeInteger(t.revision) || t.revision < transitionRev || (t.mode !== "floor" && t.mode !== "meeting")) return;
  transitionRev = t.revision; const epoch = ++mediaEpoch; failed = undefined;
  if (media) micIntent = microphoneActive; // an in-flight earlier transition keeps the user's prior intent
  target = { mode: t.mode, zoneId: t.zoneId }; connecting = true;
  mediaStatus.textContent = "Switching audio room…";
  try {
    await dropMedia();
    if (attempt !== generation || epoch !== mediaEpoch || !office) return;
    office.send("media.transition.ack", { revision: t.revision });
    const credentials = await mediaCredentials(attempt, epoch, t.revision);
    if (!credentials || attempt !== generation || epoch !== mediaEpoch) return;
    await attachMedia(attempt, epoch, credentials, micIntent);
  } catch {
    if (attempt === generation && epoch === mediaEpoch) { connecting = false; failed = t; mediaStatus.textContent = "Audio room unavailable. Staying muted and disconnected; use Retry media connection."; controls(); }
  }
}
async function connect() {
  if (connecting || office) return;
  connecting = true; const attempt = ++generation; controls(); status.textContent = "Joining office…";
  let candidate: OfficeRoom<State> | undefined;
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
    candidate.onMessage("request.error", (error: {code?: string}) => {
      if (attempt !== generation) return;
      aiRequestPending = false;
      status.textContent = `Server rejected a request${error.code ? ` (${error.code})` : ""}.`;
      if (error.code === "AI_UNAVAILABLE") element("ai-status").textContent = "AI notes unavailable. Configure and start the AI worker.";
      controls();
    });
    candidate.onMessage("audio.policy", (policy: AudioPolicy) => {
      if (attempt !== generation || !Number.isSafeInteger(policy.revision) || policy.revision < revision || !Array.isArray(policy.speakers)) return;
      if (policy.mode !== target.mode || policy.zoneId !== target.zoneId) return;
      revision = policy.revision; lastPolicy = policy; renderPolicy();
    });
    candidate.onMessage("meeting.entered", (m: MeetingEntered) => { if (attempt === generation) { meetingText.textContent = `In ${String(m.name)} — private audio`; meetingSessionId = m.meetingSessionId; aiState = undefined; localAIDecision = undefined; aiRequestPending = false; renderAI(); } });
    candidate.onMessage("meeting.exited", (_m: MeetingExited) => { if (attempt === generation) { meetingText.textContent = "On the open floor — proximity audio"; meetingSessionId = ""; aiState = undefined; localAIDecision = undefined; aiRequestPending = false; renderAI(); } });
    candidate.onMessage("media.transition", (t: MediaTransition) => { if (attempt === generation) void transition(t); });
    candidate.onMessage("ai.status", (value: AIStatus) => {
      if (attempt !== generation || !value || value.meetingSessionId !== meetingSessionId || !Number.isSafeInteger(value.revision) || !Array.isArray(value.roster)) return;
      if (aiState && aiState.aiSessionId === value.aiSessionId && value.revision < aiState.revision) return;
      aiState = value; aiRequestPending = false; renderAI();
    });
    candidate.onMessage("notes.ready", (value: { noteId: string; aiSessionId: string }) => { if (attempt === generation && value?.noteId) { void loadNotes(value.noteId); } });
    candidate.onDrop(() => { if (attempt === generation) stop("Office connection dropped. Media stopped; retry manually."); });
    candidate.onLeave(() => { if (attempt === generation) stop("Office disconnected. Retry manually (a held seat may need time to expire)."); });
    candidate.onError(() => { if (attempt === generation) stop("Office connection failed. Retry manually."); });
    preferences();
    const epoch = ++mediaEpoch; if (!meetingText.textContent) meetingText.textContent = "On the open floor — proximity audio";
    const credentials = await mediaCredentials(attempt, epoch);
    if (attempt !== generation) return;
    if (!credentials) return; // A media.transition arrived first and drives the connection.
    await attachMedia(attempt, epoch, credentials, false);
    void loadNotes();
  } catch { if (attempt === generation) stop("Connection failed. Check invite/session, service configuration, and network; retry manually."); else void candidate?.leave().catch(() => {}); }
}
element<HTMLFormElement>("join-form").addEventListener("submit", event => { event.preventDefault(); void (async () => {
  try {
    const guest = await request<GuestSession>("/api/sessions/guest", { displayName: element<HTMLInputElement>("name").value, inviteCode: element<HTMLInputElement>("invite").value });
    token = guest.token; sessionStorage.setItem(storageKey, token); element<HTMLInputElement>("invite").value = ""; await connect();
  } catch { status.textContent = "Guest creation failed. Check invite and display name."; controls(); }
})(); });
retryMedia.onclick = () => { if (failed) void transition(failed); };
resume.onclick = () => void connect(); leave.onclick = () => stop("Disconnected by you.");
aiRequest.onclick = () => { if (!office || !meetingSessionId || !media || aiRequestPending) return; aiRequestPending = true; localAIDecision = undefined; renderAI(); office.send("ai.request", { requestId: crypto.randomUUID() }); element("ai-status").textContent = "Notes requested. Waiting for the current occupants to decide."; controls(); };
aiConsent.onclick = () => decideAI(true);
aiDecline.onclick = () => decideAI(false);
aiWithdraw.onclick = () => { if (!office || !aiState) return; office.send("ai.consent", { aiSessionId: aiState.aiSessionId, revision: aiState.revision, consent: false }); localAIDecision = false; element("ai-status").textContent = "Consent withdrawn. Capture and pending processing will be canceled by the server."; renderAI(); };
aiStop.onclick = () => { if (!office || !aiState) return; office.send("ai.stop", { aiSessionId: aiState.aiSessionId, revision: aiState.revision }); element("ai-status").textContent = "Stop requested. Authorized audio will be finalized into draft notes."; controls(); };
element<HTMLButtonElement>("refresh-notes").onclick = () => void loadNotes();
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
    for (const zone of map.meetingZones) { const b=zone.bounds; context.fillStyle="#ddd5ed"; context.fillRect(b.x,b.y,b.width,b.height); context.strokeStyle="#8a68a6"; context.strokeRect(b.x,b.y,b.width,b.height); context.fillStyle="#51396a"; context.font=".38px sans-serif"; const occupancy = office?.state?.meetings?.get(zone.id)?.occupancy; context.fillText(`${zone.name} · ${occupancy ? `${occupancy} inside` : "empty"} · private audio`, b.x+.2,b.y+.6); }
    context.fillStyle="#43536b"; for (const b of map.blockedRects) context.fillRect(b.x,b.y,b.width,b.height); for (const b of map.blockedTiles) context.fillRect(b.x,b.y,1,1);
    if (office?.state?.players) for (const player of office.state.players.values()) { context.fillStyle=player.sessionId===office.sessionId ? "#2865dd" : "#008c83"; context.beginPath(); context.arc(player.x,player.y,.25,0,Math.PI*2); context.fill(); context.fillStyle="#16223a"; context.font=".42px sans-serif"; context.fillText(player.displayName,player.x+.35,player.y); }
    context.restore();
  }
  requestAnimationFrame(frame);
}
controls(); frame();
