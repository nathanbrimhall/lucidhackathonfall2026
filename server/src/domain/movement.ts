import type { OfficeMap, Point } from "../../../shared/src/map-contract.js";
import { isPositionWalkable, PLAYER_RADIUS } from "./collision.js";

export { PLAYER_RADIUS } from "./collision.js";
export const MOVEMENT_SPEED = 4;
export const SIMULATION_HZ = 20;
export const SIMULATION_INTERVAL_MS = 1000 / SIMULATION_HZ;
export const MAX_ELAPSED_MS = SIMULATION_INTERVAL_MS;
export interface MovementDirection { dx: number; dy: number }

/** Pure authoritative integration. Time comes from the server simulation only. */
export function movePlayer(map: OfficeMap, position: Point, input: MovementDirection, elapsedMs: number): Point {
  // Schema instances expose accessor fields; object spread does not copy them.
  const next = { x: position.x, y: position.y };
  if (!isPositionWalkable(map, position) || !Number.isFinite(input.dx) || !Number.isFinite(input.dy)
    || Math.abs(input.dx) > 1 || Math.abs(input.dy) > 1 || !Number.isFinite(elapsedMs)) return next;
  const dt = Math.max(0, Math.min(elapsedMs, MAX_ELAPSED_MS)) / 1000;
  const length = Math.max(1, Math.hypot(input.dx, input.dy));
  const dx = input.dx / length * MOVEMENT_SPEED * dt, dy = input.dy / length * MOVEMENT_SPEED * dt;
  // Small steps cannot cross a solid obstacle in one jump. Resolve each axis
  // independently so pushing diagonally against a wall still permits sliding.
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / (PLAYER_RADIUS / 2)));
  for (let i = 0; i < steps; i++) {
    const x = Math.max(PLAYER_RADIUS, Math.min(map.width - PLAYER_RADIUS, next.x + dx / steps));
    if (isPositionWalkable(map, { x, y: next.y })) next.x = x;
    const y = Math.max(PLAYER_RADIUS, Math.min(map.height - PLAYER_RADIUS, next.y + dy / steps));
    if (isPositionWalkable(map, { x: next.x, y })) next.y = y;
  }
  return next;
}
