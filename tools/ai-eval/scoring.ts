import type { AiDraftNotes } from "../../shared/src/ai-worker.js";
import type { ExpectedAction, ExpectedNoteFact } from "./fixtures.js";
/** Transparent fixture-specific lexical/evidence matching, not an LLM judge or a proof of semantic truth. */
export function scoreActions(notes: AiDraftNotes, expected: ExpectedAction[]) {
  const actual = notes.actionItems;
  const candidates = expected.map(e => actual.flatMap((item, index) => {
    const text = item.text.toLowerCase();
    return e.terms.every(group => group.some(term => text.includes(term.toLowerCase()))) && e.evidence.some(id => item.segmentIds.includes(id)) ? [index] : [];
  }));
  // Maximum bipartite matching prevents one action counting for multiple expectations.
  const assigned = new Map<number, number>();
  function match(e: number, seen: Set<number>): boolean {
    for (const index of candidates[e]) {
      if (seen.has(index)) continue;
      seen.add(index);
      if (!assigned.has(index) || match(assigned.get(index)!, seen)) { assigned.set(index, e); return true; }
    }
    return false;
  }
  expected.forEach((_, index) => match(index, new Set()));
  const pairs = [...assigned].map(([actualIndex, expectedIndex]) => ({ actualIndex, expectedId: expected[expectedIndex].id,
    ownershipError: actual[actualIndex].ownerUserId !== expected[expectedIndex].ownerUserId,
    deadlineError: !sameDate(actual[actualIndex].dueAt, expected[expectedIndex].dueAt),
  }));
  const matchedIds = new Set(pairs.map(p => p.expectedId));
  return { expectedActions: expected.length, actualActions: actual.length, matchedActions: pairs.length,
    missedActions: expected.filter(e => !matchedIds.has(e.id)).map(e => e.id),
    inventedActions: actual.flatMap((item, index) => assigned.has(index) ? [] : [{ index, text: item.text }]),
    ownershipErrors: pairs.filter(p => p.ownershipError).length, deadlineErrors: pairs.filter(p => p.deadlineError).length,
    precision: actual.length ? pairs.length / actual.length : expected.length ? 0 : 1,
    recall: expected.length ? pairs.length / expected.length : 1, pairs,
  };
}
function sameDate(a: string | null, b: string | null) { return a === null || b === null ? a === b : Date.parse(a) === Date.parse(b); }

/** Coverage of labeled facts, not a writing-quality score or semantic entailment check. */
export function scoreNoteCoverage(notes: AiDraftNotes, facts: ExpectedNoteFact[]) {
  const matchedFacts: string[] = [], missingFacts: string[] = [];
  for (const fact of facts) {
    const claims = fact.section === "decisions" ? notes.decisions : [...notes.summary, ...notes.decisions];
    const found = claims.some(claim => fact.terms.every(group => group.some(term => claim.text.toLowerCase().includes(term.toLowerCase()))) && fact.evidence.some(id => claim.segmentIds.includes(id)));
    (found ? matchedFacts : missingFacts).push(fact.id);
  }
  return { expectedFacts: facts.length, matchedFacts, missingFacts, coverage: facts.length ? matchedFacts.length / facts.length : 1, method: "fixture-terms-and-evidence-coverage-v1" };
}
