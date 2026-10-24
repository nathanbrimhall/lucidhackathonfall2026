/** Format an instant as a datetime-local value in the selected IANA time zone. */
export function toLocalInput(iso: string, timezone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid date and time.");
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  } catch { throw new Error("Enter a valid IANA time zone, such as America/Denver."); }
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** Convert wall-clock input to UTC, rejecting DST gaps and overlaps. */
export function wallTimeToIso(value: string, timezone: string): string {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }); }
  catch { throw new Error("Enter a valid IANA time zone, such as America/Denver."); }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid date and time.");
  const [, ys, mos, ds, hs, mis] = match;
  const [y, mo, d, h, mi] = [ys, mos, ds, hs, mis].map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi), check = new Date(wallAsUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) throw new Error("Choose a real calendar date and time.");
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 3) {
    const sample = wallAsUtc + delta * 3600000;
    const p = Object.fromEntries(formatter.formatToParts(new Date(sample)).map(x => [x.type, x.value]));
    const represented = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    offsets.add(represented - Math.floor(sample / 1000) * 1000);
  }
  const candidates = [...offsets].map(offset => wallAsUtc - offset).filter(epoch => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map(x => [x.type, x.value]));
    return Number(p.year) === y && Number(p.month) === mo && Number(p.day) === d && Number(p.hour) === h && Number(p.minute) === mi;
  });
  if (!candidates.length) throw new Error("That local time does not exist because of a daylight-saving clock change.");
  if (candidates.length > 1) throw new Error("That local time is ambiguous because clocks move back. Choose a different time.");
  return new Date(candidates[0]).toISOString();
}
