// The ordered event feed (PRD 6 P1-1, C-161). Pure: no clock, no database.
//
// `OrderEvent.seq` is a BIGSERIAL, and a sequence hands out numbers at INSERT,
// not at COMMIT. Two writers can take 41 and 42, and 42 can commit first. A
// consumer that read 42 and then asked for "after 42" would never see 41. That
// is the whole difficulty of a durable ordered stream, and this function is the
// answer to it: the feed stops at a gap until the gap is old enough to be a
// rolled-back transaction rather than one still in flight.
//
// ponytail: "old enough" is judged by the event's own `at`, which the writer
// stamps just before inserting. A transaction that holds its seq open longer
// than `settleMs` before committing is skipped. Nothing in this product holds
// a transaction for seconds; if something ever does, the upgrade is to record
// `pg_current_xact_id()` per row and hold back past the oldest open one.

export type FeedRow = { seq: number; at: Date };

/** Contiguous from `after + 1`, stopping at a gap younger than `settleMs`. */
export function feedPage<T extends FeedRow>(
  rows: readonly T[],
  after: number,
  now: Date,
  settleMs = 5_000,
): { events: T[]; next: number } {
  const events: T[] = [];
  let expected = after + 1;
  for (const row of rows) {
    // A missing number below this row may still be committing. Wait for it,
    // unless this row is old enough that the missing one never will.
    if (row.seq !== expected && now.getTime() - row.at.getTime() < settleMs) break;
    events.push(row);
    expected = row.seq + 1;
  }
  return { events, next: events.at(-1)?.seq ?? after };
}
