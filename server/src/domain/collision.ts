import type { OfficeMap, Point, Bounds } from "../../../shared/src/map-contract.js";

export const PLAYER_RADIUS = 0.25;

function intersectsCircle(rect: Bounds, position: Point, radius: number): boolean {
  const x = Math.max(rect.x, Math.min(position.x, rect.x + rect.width));
  const y = Math.max(rect.y, Math.min(position.y, rect.y + rect.height));
  return (position.x - x) ** 2 + (position.y - y) ** 2 < radius ** 2;
}

/** Tangency is allowed; a player's circular footprint must not enter an obstacle. */
export function isPositionWalkable(map: OfficeMap, position: Point, radius = PLAYER_RADIUS): boolean {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(radius) || radius <= 0) return false;
  if (position.x < radius || position.y < radius || position.x > map.width - radius || position.y > map.height - radius) return false;
  return !map.blockedRects.some(rect => intersectsCircle(rect, position, radius))
    && !map.blockedTiles.some(tile => intersectsCircle({ ...tile, width: 1, height: 1 }, position, radius));
}
