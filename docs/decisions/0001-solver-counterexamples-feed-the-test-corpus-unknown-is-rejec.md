# 0001. Solver counterexamples feed the test corpus; unknown is rejected

- Status: Accepted
- Date: 2026-09-30
- Agreed at turn: 1
- Diagram: [0001-solver-counterexamples-feed-the-test-corpus-unknown-is-rejec.excalidraw](./0001-solver-counterexamples-feed-the-test-corpus-unknown-is-rejec.excalidraw)

## Context

Superoptimizer pipeline: an LLM (claude-sonnet-5-5) proposes assembly optimizations, a test generator smoke-tests each candidate, and an SMT solver gives the definitive equivalence verdict. The open question was what happens when a candidate passes tests but the solver returns SAT (a counterexample) or unknown/timeout, and where that feedback flows.

## Options considered

- Tests as a cheap pre-filter before SMT, with every failure looping back to the LLM (the proposed shape; kept).
- On SAT, discard the candidate and only tell the LLM it failed. Not chosen: the counterexample is lost, so later candidates can repeat the same bug and pay for the solver again.
- On unknown/timeout, accept the candidate on test evidence. Rejected: it would break the guarantee of a definite semantic equivalence check.

## Decision

Order is LLM proposal, then test smoke test, then SMT check.
- Test failure: return the failing input to the LLM for another proposal.
- SMT SAT: add the counterexample to the shared test corpus (CEGIS-style) and ask the LLM for another proposal.
- SMT unknown/timeout: reject the candidate as unproven. Never accept on test evidence alone.
- Only UNSAT accepts a candidate.

The user agreed with the recommendation as proposed and stated the SAT behavior in their own words: add the counterexample and ask the LLM for another proposal.

## Consequences

- The test corpus grows with every solver counterexample, so the cheap filter catches more wrong candidates over time and fewer reach the solver.
- Soundness rests on the solver alone. Tests only save solver time.
- Rejecting unknown can discard correct but hard-to-prove optimizations. This is the accepted cost of soundness.
- Deferred, not discussed: a retry or attempt budget per source function, solver timeout values, and whether the corpus is shared across functions or kept per function.
- Deferred: whether unknown candidates are logged for a longer offline solver run.

## Whiteboard at agreement

```yaml
nodes:
  accept: {label: "Accepted", kind: ellipse, cluster: null}
  llm: {label: "LLM proposer", kind: rect, cluster: null}
  smt: {label: "SMT equiv", kind: rect, cluster: null}
  src: {label: "Source asm fn", kind: ellipse, cluster: null}
  tests: {label: "Test gen smoke", kind: rect, cluster: null}
  verdict: {label: "Verdict?", kind: diamond, cluster: null}
edges:
  - {id: llm->tests, from: llm, to: tests, label: "candidate"}
  - {id: smt->verdict, from: smt, to: verdict, label: null}
  - {id: src->llm, from: src, to: llm, label: null}
  - {id: tests->llm, from: tests, to: llm, label: "fail + input"}
  - {id: tests->smt, from: tests, to: smt, label: "pass"}
  - {id: verdict->accept, from: verdict, to: accept, label: "UNSAT"}
  - {id: verdict->llm, from: verdict, to: llm, label: "SAT / unknown"}
notes:
  - {id: note-1, text: "Open: on SAT, does the counterexample join the test corpus? On timeout/unknown, what happens?"}
```
