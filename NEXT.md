# Next

**PRD 3 P0-5 — a cooked order can be made whole without being cancelled.**
`docs/prds/prd-money-that-reconciles.md`, the last unchecked block (three
criteria). Everything else in PRD 3 is done; the backlog has no unchecked
items, so this one needs a `C-0xx` entry written as part of the work.

What it asks for:
- The state machine's refusal to cancel from `ready` / `picked_up` stays
  **unchanged** — it is correct and both evaluators agree. Nothing in
  `packages/core/orders/state-machine.ts` should move.
- The refusal must stop being a dead end: it names the adjustment path
  ("cooked food cannot be cancelled — comp or adjust it instead"), and the
  comp/adjust control is available in exactly the states where cancellation
  is refused.
- Test: attempt to cancel a `ready` order, assert the existing refusal **by
  reason**, and assert the refusal names the adjustment path.

Model: Opus — it is a refusal-message/authority change on the money path, and
the trap is "improving" the state machine that is deliberately strict.

Also still open, from C-067's *Left behind* (not this item, but the next money
one): a refund that can be issued **on purpose**, rather than only as the
consequence of cancelling a paid order — needs a form, a bound, and its own
refusal, plus the reversing adjustment C-065 and C-066 both deferred.
