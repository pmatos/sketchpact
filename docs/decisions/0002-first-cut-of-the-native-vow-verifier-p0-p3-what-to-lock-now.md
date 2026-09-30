# 0002. First cut of the native Vow verifier (P0-P3): what to lock now, what to defer

- Status: Accepted
- Date: 2026-09-30
- Agreed at turn: 1
- Diagram: [0002-first-cut-of-the-native-vow-verifier-p0-p3-what-to-lock-now.excalidraw](./0002-first-cut-of-the-native-vow-verifier-p0-p3-what-to-lock-now.excalidraw)

## Context

vow-lang/vow#1335 proposes replacing Vow -> C -> ESBMC with a native verifier written in Vow and lists 13 open decisions (D1-D13). This debate covered only what the first shippable native verifier (phases P0-P3) must commit to, settling four decisions together: (1) solver interface (D3, G1/G3), (2) call semantics (D4), (3) loops (D5), (4) collection/string model and v1 scope with the fail-closed `Skipped` gate (D6, D10). D1 (dual-compiler rule) was treated as a constraint. Both agents assumed option (b): the checker lives only in `compiler/`, with no Rust twin in `vow-verify`. If D1(a) is chosen instead, every feature costs twice as much.

Two agents argued with the user as arbiter: "simplicity" (smallest design meeting today's requirements; also the scribe) and "extensibility" (absorb likely changes, each seam justified by a named future change).

Facts checked before arguing:
- `vow-runtime/src/lib.rs:3850-3866` spawns children with piped stdout/stderr and no stdin, so an incremental SMT-LIB pipe (G3) needs new runtime work. `compiler/verifier.vow:283` already uses `process_run`.
- `docs/spec/contracts.md:36` specifies incremental BMC, not k-induction, and says `proven` needs the configured model checks to complete, otherwise `unknown`.
- Today's callee handling is inlining with `ensures` re-asserted (`c_emitter.rs:1159-1183`).
- Fixtures: `tests/verify` has 39 files, `tests/verify-fail` 27, `tests/verify-skip` 5. Only 4 files in `tests/verify` contain loops (`bounds_correct`, `strong_invariant`, `vec_fill`, `void_loop_invariant`), all with invariants. 10 of the 39 use Vec or String.
- `contracts.md:50` lists the String operations ESBMC models today: `from`, `len`, `push_byte`, `push_str`, `byte_at`, `matches_literal_at`. The extensibility agent cited this as line 52; the substance is right, the line number is off by two.

## Options considered

Solver interface (D3):
- One-shot `.smt2` file run via `process_run` (issue design C). Needs no language or runtime change.
- Incremental SMT-LIB over a stdin pipe. Needs G3 first.
- Rust shim around libbitwuzla/libz3 (design D). Touches `vow-linker` policy, binary size, fixed-point reproducibility, and both compilers' env tables.

Calls (D4): keep inlining callees with `ensures` re-asserted, or modular assume-guarantee. Modular changes verdicts and `contracts.md` semantics.

Loops (D5): incremental BMC only, or k-induction with user invariants used inductively (havoc, assume invariant, check preservation).

Collections and strings (D6, D10): SMT array plus symbolic length with no capacity caps; strings as length only, as array plus length, or as today's abstraction; fail-closed `Skipped` gate widened incrementally.

**Simplicity's position, as its owner stated it.** Change one variable at a time. D9 makes ESBMC the oracle: native must match its verdicts on `tests/verify*` before ESBMC can be removed. Inlining and BMC-only are today's semantics. Modular calls and k-induction change verdicts, so a diff against ESBMC could not tell a native bug from an intended semantics change. Swap the backend first and change semantics later, each with its own ADR. A one-shot `.smt2` per claim is the only interface with no prerequisite; pipe and shim serve a performance need (reuse across k and claims) that D9(iv)/P4 owns and nobody has measured. Collections use array plus length with no caps, which removes the capacity-assume soundness issue by construction. Strings: length only, with content-dependent operations `Skipped`. Native is opt-in (`--backend native`) with narrower coverage than ESBMC until D9 is met. Deferred: stdin pipe, Rust shim, modular calls, k-induction, exact strings, recursion, hash-consing (G4).

**Extensibility's position, as its owner stated it.** It conceded D4 (inline calls) and D5 (BMC only) and assumed D1(b). It argued for two small seams:
1. The encoder emits an SMT command list (one named assert per claim) that the SMT-LIB writer prints, instead of writing a file per claim. Otherwise the later pipe (P4) becomes an encoder rewrite; the issue sizes the encoder at 2-3k LOC. The extensibility agent estimated the seam at about 50 LOC.
2. One op-model table serves as both the `Skipped` gate and the home of the Vec/String model. It says skip logic already sits in three lists that drift (`c_emitter.rs:299`, `:520`, `:638`). The simplicity agent did not verify this citation.

It also named two weaknesses in simplicity's board:
- "String = len only" breaks D9 parity, because ESBMC models `byte_at`, `push_byte` and `matches_literal_at` (`contracts.md:50`), and array plus length reuses the Vec machinery.
- There is no unwinding assertion, so loops deeper than k would need to yield `unknown`, not `proven` (`contracts.md:36`).

## Decision

The arbiter heard both agents and pressed **Agree & finish** on turn 1 with an empty comment. There is no written ruling in the arbiter's words. The decision is the board as it stood at that moment, including both agents' nodes.

Locked now for the first cut:
- **D3 solver interface:** the encoder produces an SMT command list per claim (extensibility's seam, `e_cmds`, kept on the board). The writer prints it as one self-contained `.smt2`, run by `process_run` against a single external solver (board label: bitwuzla), and the model output is parsed into today's counterexample JSON. No stdin pipe (G3), no Rust shim, no runtime change.
- **D4 calls:** callees are inlined, as today. No modular assume-guarantee.
- **D5 loops:** incremental BMC only, bounded by `--max-k-step`. No k-induction and no inductive use of invariants.
- **D6/D10 scope:** Vec is an SMT array plus symbolic length with no capacity caps. Native runs behind opt-in `--backend native`; ESBMC remains the default and the oracle. One op-model table is the fail-closed `Skipped` gate (unmodelled ops, effects, recursion, sibling-branch reads) and holds the Vec/String model (extensibility's `e_models`, kept on the board).
- **D1:** assumed to be option (b), checker in `compiler/` only. This still needs an explicit maintainer decision recorded in CLAUDE.md or an ADR.

Deferred deliberately: stdin pipe (G3) and any incremental solving, Rust shim, modular calls, k-induction, recursion (stays `Skipped`), hash-consing and G4, and the D2 solver distribution question. The board names bitwuzla, but the one-shot interface keeps the solver swappable and D2 is not settled by this record.

**Not resolved by the arbiter: the String model.** The board carries two statements: simplicity's note ("String = len only, content ops Skipped") and extensibility's node ("Vec/String array & len"). The arbiter did not choose between them.
- Simplicity's view when writing this record, made after the arbiter agreed and open to amendment: it concedes the point. `contracts.md:50` confirms ESBMC models byte-level string operations, so length-only strings would leave verdicts that D9(i) requires the native backend to reproduce. Array plus length reuses the Vec machinery and adds no new design.
- Treat array plus length as the working assumption and confirm it before P3 exits.

Requirement raised by extensibility, not contested by simplicity, not drawn on the board: symex must emit an unwinding assertion, so that a loop deeper than k gives `unknown` and never `proven`. This is a soundness condition of parity with `contracts.md:36`, not an extension.

## Consequences

- The first cut reuses today's semantics, so any verdict difference against ESBMC on `tests/verify*` points at the native implementation, not at a changed rule. This keeps the D9 differential meaningful.
- No prerequisites in the runtime or language: P1-P3 can start once D1 and D13 (IR dominance) are settled.
- Costs accepted:
  - One solver process per claim, with no reuse across k or claims. This is the same as ESBMC's current behaviour, but it forfeits the native performance advantage until P4.
  - Inlining keeps the scaling limit of re-asserting callee `ensures` and does not close the `examples/divide.vow` hole (functions without a `vow` block are never targets).
  - Invariants stay unused inductively, and recursion stays `Skipped`.
  - The native backend covers less than ESBMC until the op table widens, so it cannot become the default before D9.
  - The command-list seam costs extra code now (extensibility estimated about 50 LOC) for a pipe swap that has no caller until G3 lands. Simplicity accepted this on the board without a rebuttal; the estimate is unmeasured.
  - D1(b) changes what `scripts/bootstrap.sh` guarantees about verification, since stage 0 keeps the ESBMC path.
- Open items for later ADRs: the String model, D2 solver distribution, the sibling-branch dominance rule (D13, currently handled by sending such IR to `Skipped`), and when to revisit D4/D5 after the backend swap is proven.

## Whiteboard at agreement

```yaml
nodes:
  e_cmds: {label: "SMT command list per claim, not a file", kind: rect, cluster: extensibility, owner: extensibility}
  e_models: {label: "One op table = gate; Vec/String array & len", kind: rect, cluster: extensibility, owner: extensibility}
  s_cex: {label: "Parse sat/model into today's cex JSON", kind: rect, cluster: simplicity, owner: simplicity}
  s_gate: {label: "Skipped gate: unmodelled op, effect, recursion, sibling-branch read", kind: diamond, cluster: simplicity, owner: simplicity}
  s_run: {label: "process_run bitwuzla: one .smt2 per claim", kind: rect, cluster: simplicity, owner: simplicity}
  s_skip: {label: "Status: Skipped (fail-closed)", kind: rect, cluster: simplicity, owner: simplicity}
  s_smt: {label: "SMT-LIB writer: BV + array&len, no caps", kind: rect, cluster: simplicity, owner: simplicity}
  s_symex: {label: "Symex: inline callees, unroll to k", kind: rect, cluster: simplicity, owner: simplicity}
edges:
  - {id: e_cmds->s_smt, from: e_cmds, to: s_smt, label: null, owner: extensibility}
  - {id: e_models->s_skip, from: e_models, to: s_skip, label: null, owner: extensibility}
  - {id: s_gate->s_skip, from: s_gate, to: s_skip, label: "no", owner: simplicity}
  - {id: s_gate->s_symex, from: s_gate, to: s_symex, label: "yes", owner: simplicity}
  - {id: s_run->s_cex, from: s_run, to: s_cex, label: "sat + get-value", owner: simplicity}
  - {id: s_smt->s_run, from: s_smt, to: s_run, label: "query.smt2", owner: simplicity}
  - {id: s_symex->s_smt, from: s_symex, to: s_smt, label: null, owner: simplicity}
clusters:
  extensibility: {label: "Extensibility", type: frame, members: [e_cmds, e_models], owner: extensibility}
  simplicity: {label: "Simplicity", type: frame, members: [s_cex, s_gate, s_run, s_skip, s_smt, s_symex], owner: simplicity}
notes:
  - {id: s_note_arg, text: "Change one variable at a time. D9 makes ESBMC the oracle: native must match its verdicts on tests/verify*. Inlining (c_emitter.rs:1159-1183) and BMC-only (contracts.md:36) are today's semantics. Modular calls (D4) and k-induction (D5) change verdicts, so a diff could not tell a native bug from a semantics change. Swap the backend first; change semantics later, each with its own ADR.", owner: simplicity}
  - {id: s_note_lock, text: "LOCKED now: D3 one-shot .smt2 (no runtime change; verifier.vow:283 already uses process_run). D4 inline. D5 BMC only, --max-k-step. D6 Vec = SMT array + len, no capacity caps; String = len only, content ops Skipped. D10 fail-closed gate, opt-in --backend native. Assumes D1(b): checker in compiler/ only, no Rust twin. DEFERRED: stdin pipe (G3), Rust shim, modular calls, k-induction, exact strings, recursion, hash-consing (G4).", owner: simplicity}
```
