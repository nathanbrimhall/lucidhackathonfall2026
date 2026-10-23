import { describe, expect, it } from "vitest";
import type { OfficeMap } from "../../shared/src/map-contract.js";
import { isPositionWalkable } from "../src/domain/collision.js";
import { movePlayer, SIMULATION_INTERVAL_MS } from "../src/domain/movement.js";

const openMap = (): OfficeMap => ({ contractVersion: 1, mapId: "test", version: 1, units: "tiles", width: 20, height: 20, blockedTiles: [], blockedRects: [], spawnPoints: [{ x: 1, y: 1 }], meetingZones: [] });

describe("authoritative movement", () => {
  it("moves four tiles per second at 20Hz without mutating its inputs", () => {
    const map = openMap(), start = { x: 2, y: 2 };
    let next = start;
    for (let i = 0; i < 20; i++) next = movePlayer(map, next, { dx: 1, dy: 0 }, SIMULATION_INTERVAL_MS);
    expect(next.x).toBeCloseTo(6);
    expect(next.y).toBe(2);
    expect(start).toEqual({ x: 2, y: 2 });
  });
  it("normalizes diagonals and clamps long server frames", () => {
    const map = openMap(), start = { x: 2, y: 2 };
    const next = movePlayer(map, start, { dx: 1, dy: 1 }, 100000);
    expect(Math.hypot(next.x - start.x, next.y - start.y)).toBeCloseTo(0.2);
    expect(next.x - start.x).toBeCloseTo(next.y - start.y);
  });
  it.each([NaN, Infinity, -10, 0])("does not move for invalid/nonpositive elapsed %s", elapsed => {
    expect(movePlayer(openMap(), { x: 2, y: 2 }, { dx: 1, dy: 0 }, elapsed)).toEqual({ x: 2, y: 2 });
  });
  it.each([{ dx: Infinity, dy: 0 }, { dx: 0, dy: NaN }, { dx: 100, dy: 0 }])("rejects invalid directions %j", input => {
    expect(movePlayer(openMap(), { x: 2, y: 2 }, input, 50)).toEqual({ x: 2, y: 2 });
  });
  it("keeps the complete circular footprint within map bounds", () => {
    const map = openMap();
    expect(movePlayer(map, { x: 0.3, y: 0.3 }, { dx: -1, dy: -1 }, 50)).toEqual({ x: 0.25, y: 0.25 });
    expect(movePlayer(map, { x: 19.7, y: 19.7 }, { dx: 1, dy: 1 }, 50)).toEqual({ x: 19.75, y: 19.75 });
  });
  it("prevents tunneling through thin walls and permits sliding", () => {
    const map = openMap();
    map.blockedRects = [{ x: 5, y: 0, width: 0.001, height: 20 }];
    let next = { x: 4.7, y: 2 };
    for (let i = 0; i < 30; i++) next = movePlayer(map, next, { dx: 1, dy: 1 }, 5000);
    expect(next.x).toBeLessThanOrEqual(4.75);
    expect(next.y).toBeGreaterThan(6);
    expect(isPositionWalkable(map, next)).toBe(true);
  });
  it("uses circles at tile corners and permits exact tangency", () => {
    const map = openMap(); map.blockedTiles = [{ x: 5, y: 5 }];
    expect(isPositionWalkable(map, { x: 4.75, y: 5.5 })).toBe(true);
    expect(isPositionWalkable(map, { x: 4.76, y: 5.5 })).toBe(false);
    expect(isPositionWalkable(map, { x: 4.8, y: 4.8 })).toBe(true);
    expect(isPositionWalkable(map, { x: 4.85, y: 4.85 })).toBe(false);
  });
});
