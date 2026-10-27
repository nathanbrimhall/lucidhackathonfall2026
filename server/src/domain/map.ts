import { readFileSync } from "node:fs";
import { mapSchema, type OfficeMap } from "../../../shared/src/map-contract.js";

/** Asset path works from both source and the compiled dist/server/src tree. */
export function loadOfficeMap(layout: "legacy" | "prototype" = "legacy"): OfficeMap {
  return mapSchema.parse(JSON.parse(readFileSync(new URL(layout === "prototype" ? "../../maps/prototype-office.json" : "../../maps/office.json", import.meta.url), "utf8")));
}
