import { pointInPolygon, zonePolygon, type MeetingZone, type OfficeMap, type Point } from "../../../shared/src/map-contract.js";

/** Map validation rejects overlapping interiors, so at most one zone owns a point. */
export function zoneAt(map: OfficeMap, point: Point): MeetingZone | undefined {
  return map.meetingZones.find(zone => pointInPolygon({ x: point.x, y: point.y }, zonePolygon(zone)));
}
