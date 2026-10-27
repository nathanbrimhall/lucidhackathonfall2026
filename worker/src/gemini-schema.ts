import { z } from "zod";
import { aiDraftNotesSchema } from "../../shared/src/ai-worker.js";
/** Retain the shared contract while omitting provider-side regex/length/format constraints to keep the generation schema small. Full validation still runs locally. */
export function geminiNotesJsonSchema(): unknown {
  function convert(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(convert);
    if (!value || typeof value !== "object") return value;
    let record = value as Record<string, unknown>;
    if (Array.isArray(record.anyOf) && record.anyOf.every(arm => typeof arm.type === "string" && ["string", "null"].includes(arm.type))) {
      record = { ...(record.anyOf.find(arm => arm.type === "string") ?? {}), type: record.anyOf.map(arm => arm.type) };
    }
    return Object.fromEntries(Object.entries(record).filter(([key]) => !["$schema", "pattern", "minLength", "maxLength", "minItems", "maxItems", "format"].includes(key)).map(([key, item]) => [key, convert(item)]));
  }
  return convert(z.toJSONSchema(aiDraftNotesSchema));
}
