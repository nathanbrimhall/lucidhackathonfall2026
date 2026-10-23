import { z } from "zod";

export const MAP_CONTRACT_VERSION = 1;
const coordinate = z.number().finite().nonnegative();
export const pointSchema = z.strictObject({ x: coordinate, y: coordinate });
export const boundsSchema = z.strictObject({ x: coordinate, y: coordinate, width: z.number().finite().positive(), height: z.number().finite().positive() });
export type Point = z.infer<typeof pointSchema>;
export type Bounds = z.infer<typeof boundsSchema>;
export const meetingZoneSchema = z.strictObject({
  id: z.string().min(1).max(80), name: z.string().min(1).max(120), bounds: boundsSchema,
  polygon: z.array(pointSchema).min(3).max(64).optional(),
  audioMode: z.literal("meeting"), videoEnabled: z.boolean(),
});
export type MeetingZone = z.infer<typeof meetingZoneSchema>;

export function zonePolygon(zone: MeetingZone): Point[] {
  const { x, y, width, height } = zone.bounds;
  return zone.polygon ?? [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

// Even/odd rays use half-open edges. Rectangles own their left/top boundaries,
// excluding right/bottom; adjacent polygon edges have one deterministic owner.
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const signedArea = (p: Point[]) => p.reduce((sum, a, i) => { const b = p[(i + 1) % p.length]; return sum + a.x * b.y - b.x * a.y; }, 0) / 2;
function onSegment(a: Point, b: Point, p: Point) {
  return cross(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x) && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y);
}
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point) {
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function isSimple(p: Point[]) {
  if (signedArea(p) === 0) return false;
  for (let i = 0; i < p.length; i++) {
    if (p[i].x === p[(i + 1) % p.length].x && p[i].y === p[(i + 1) % p.length].y) return false;
    for (let j = i + 1; j < p.length; j++) {
      if (j === i + 1 || (i === 0 && j === p.length - 1)) continue;
      if (segmentsIntersect(p[i], p[(i + 1) % p.length], p[j], p[(j + 1) % p.length])) return false;
    }
  }
  return true;
}

// Triangulation plus strict separating axes detects coincident/contained and
// concave interiors without treating a shared doorway edge as an overlap.
function triangles(polygon: Point[]): Point[][] {
  const p = signedArea(polygon) > 0 ? [...polygon] : [...polygon].reverse();
  const result: Point[][] = [];
  while (p.length > 3) {
    let removed = false;
    for (let i = 0; i < p.length; i++) {
      const a = p[(i + p.length - 1) % p.length], b = p[i], c = p[(i + 1) % p.length];
      if (cross(a, b, c) === 0) { p.splice(i, 1); removed = true; break; }
      if (cross(a, b, c) < 0) continue;
      if (p.some(v => v !== a && v !== b && v !== c && cross(a, b, v) >= 0 && cross(b, c, v) >= 0 && cross(c, a, v) >= 0)) continue;
      result.push([a, b, c]); p.splice(i, 1); removed = true; break;
    }
    if (!removed) return [];
  }
  result.push(p);
  return result;
}
function triangleOverlap(a: Point[], b: Point[]) {
  for (const p of [a, b]) for (let i = 0; i < 3; i++) {
    const v = p[i], w = p[(i + 1) % 3], nx = v.y - w.y, ny = w.x - v.x;
    const ap = a.map(q => q.x * nx + q.y * ny), bp = b.map(q => q.x * nx + q.y * ny);
    if (Math.max(...ap) <= Math.min(...bp) || Math.max(...bp) <= Math.min(...ap)) return false;
  }
  return true;
}

export const mapSchema = z.strictObject({
  contractVersion: z.literal(MAP_CONTRACT_VERSION), mapId: z.string().min(1).max(80), version: z.number().int().positive(),
  units: z.literal("tiles"), width: z.number().int().positive().max(10000), height: z.number().int().positive().max(10000),
  blockedTiles: z.array(z.strictObject({ x: coordinate.int(), y: coordinate.int() })).max(10000),
  blockedRects: z.array(boundsSchema).max(1000), spawnPoints: z.array(pointSchema).min(1).max(100),
  meetingZones: z.array(meetingZoneSchema).max(100),
}).superRefine((map, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  for (const r of [...map.blockedRects, ...map.blockedTiles.map(t => ({ ...t, width: 1, height: 1 }))]) {
    if (r.x + r.width > map.width || r.y + r.height > map.height) fail("Blocked geometry exceeds map bounds");
  }
  for (const p of map.spawnPoints) {
    const radius = 0.25;
    if (p.x < radius || p.y < radius || p.x > map.width - radius || p.y > map.height - radius) fail("Spawn exceeds walkable bounds");
    for (const r of [...map.blockedRects, ...map.blockedTiles.map(t => ({ ...t, width: 1, height: 1 }))]) {
      const x = Math.max(r.x, Math.min(p.x, r.x + r.width)), y = Math.max(r.y, Math.min(p.y, r.y + r.height));
      if ((p.x - x) ** 2 + (p.y - y) ** 2 < radius ** 2) fail("Spawn intersects blocked geometry");
    }
  }
  const ids = new Set<string>();
  const valid: Point[][] = [];
  for (const zone of map.meetingZones) {
    if (ids.has(zone.id)) fail("Duplicate meeting zone id");
    ids.add(zone.id);
    const p = zonePolygon(zone), b = zone.bounds;
    if (b.x + b.width > map.width || b.y + b.height > map.height) fail("Zone exceeds map bounds");
    if (p.some(v => v.x < b.x || v.y < b.y || v.x > b.x + b.width || v.y > b.y + b.height)) fail("Polygon exceeds zone bounds");
    if (!isSimple(p)) { fail("Zone polygon must be simple with positive area"); continue; }
    valid.push(p);
  }
  for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) {
    if (triangles(valid[i]).some(a => triangles(valid[j]).some(b => triangleOverlap(a, b)))) fail("Meeting zone interiors overlap");
  }
});
export type OfficeMap = z.infer<typeof mapSchema>;
