import { expect, it } from "vitest";
import { validateHelpers } from "../../tools/ai-demo/helpers.js";
// @ts-expect-error Browser-only module is intentionally plain JavaScript.
import { shouldInterrupt, loadPreferences } from "../../tools/ai-demo/interruptions.js";
it("requires known helpers, a linked discussion and real evidence",()=>{
 const match={personId:"cameron",reason:"He is testing speaker mapping.",conversationId:"speaker-mapping",evidenceIds:["e2"]};expect(validateHelpers({helpers:[match]})[0].person.name).toBe("Cameron");
 for(const wrong of [{...match,personId:"unknown"},{...match,conversationId:"review-safety"},{...match,evidenceIds:["missing"]}])expect(()=>validateHelpers({helpers:[wrong]})).toThrow();expect(()=>validateHelpers({helpers:[match,match]})).toThrow();expect(validateHelpers({helpers:[]})).toEqual([]);
});
it("interrupts only with explicit permission while Available",()=>{
 for(const state of ['away','meeting','dnd','unknown'])expect(shouldInterrupt(state,true)).toBe(false);
 expect(shouldInterrupt('available',false)).toBe(false);expect(shouldInterrupt('available',true)).toBe(true);
});
it("defaults to quiet and rejects malformed stored preferences",()=>{
 for(const text of [null,'broken','{}','{"presence":"available","allowImmediate":"yes"}'])expect(loadPreferences({getItem:()=>text})).toEqual({presence:'available',allowImmediate:false});
 expect(loadPreferences({getItem:()=>'{"presence":"dnd","allowImmediate":true}'})).toEqual({presence:'dnd',allowImmediate:true});
});
