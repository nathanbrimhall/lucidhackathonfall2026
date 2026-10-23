import { describe, expect, it } from "vitest";
import { mapSchema, pointInPolygon, zonePolygon, type MeetingZone, type OfficeMap } from "../../shared/src/map-contract.js";
import { loadOfficeMap } from "../src/domain/map.js";
import { isPositionWalkable } from "../src/domain/collision.js";

function zone(id: string, x: number, y: number, width = 3, height = 3): MeetingZone {
  return { id, name: id, bounds: { x, y, width, height }, audioMode: "meeting", videoEnabled: false };
}
function mapWithZones(meetingZones: MeetingZone[]): OfficeMap { return { ...loadOfficeMap(), meetingZones }; }

describe("versioned map contract", () => {
  it("loads the seed asset with walkable spawns", () => {
    const map = loadOfficeMap();
    expect(map.mapId).toBe("office");
    expect(map.spawnPoints.every(p => isPositionWalkable(map, p))).toBe(true);
  });
  it("rejects unknown versions, units, out-of-bounds obstacles and blocked spawns", () => {
    const map = loadOfficeMap();
    for (const change of [
      { contractVersion: 2 }, { units: "pixels" }, { width: Infinity },
      { blockedTiles: [{ x: map.width, y: 0 }] },
      { blockedRects: [{ x: 0, y: 0, width: 100, height: 1 }] },
      { spawnPoints: [{ x: 0, y: 0 }] }, { spawnPoints: [{ x: 8.1, y: 5.1 }] },
    ]) expect(mapSchema.safeParse({ ...map, ...change }).success).toBe(false);
  });
  it("rejects contained, coincident and crossing meeting interiors", () => {
    for (const pair of [
      [zone("a", 2, 2, 8, 8), zone("b", 3, 3)],
      [zone("a", 2, 2), zone("b", 2, 2)],
      [zone("a", 2, 2, 8, 2), zone("b", 4, 1, 2, 8)],
    ]) expect(mapSchema.safeParse(mapWithZones(pair)).success).toBe(false);
  });
  it("allows shared edges and corners with half-open ownership", () => {
    const a = zone("a", 2, 2), b = zone("b", 5, 2), c = zone("c", 5, 5);
    expect(mapSchema.safeParse(mapWithZones([a, b, c])).success).toBe(true);
    expect(pointInPolygon({ x: 5, y: 3 }, zonePolygon(a))).toBe(false);
    expect(pointInPolygon({ x: 5, y: 3 }, zonePolygon(b))).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, zonePolygon(b))).toBe(false);
    expect(pointInPolygon({ x: 5, y: 5 }, zonePolygon(c))).toBe(true);
  });
  it("supports concave polygons and detects interior overlap in their arms", () => {
    const a = zone("a", 2, 2, 6, 6);
    a.polygon = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 2, y: 8 }];
    expect(mapSchema.safeParse(mapWithZones([a, zone("gap", 5, 5, 2, 2)])).success).toBe(true);
    expect(mapSchema.safeParse(mapWithZones([a, zone("arm", 3, 5, 2, 2)])).success).toBe(false);
  });
  it("rejects duplicate ids, self intersections, degenerate and out-of-bounds polygons", () => {
    const a = zone("a", 2, 2);
    expect(mapSchema.safeParse(mapWithZones([a, zone("a", 8, 8)])).success).toBe(false);
    for (const polygon of [
      [{ x: 2, y: 2 }, { x: 5, y: 5 }, { x: 2, y: 5 }, { x: 5, y: 2 }],
      [{ x: 2, y: 2 }, { x: 3, y: 3 }, { x: 4, y: 4 }],
      [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 2, y: 5 }],
    ]) expect(mapSchema.safeParse(mapWithZones([{ ...a, polygon }])).success).toBe(false);
  });
});
