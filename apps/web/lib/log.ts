// The log sink (C-084, PRD 6 P0-1).
//
// Deliberately three lines. Everything that DECIDES what a log line says — and
// what it may never say — is pure and tested in `packages/core`
// (`observability.ts`); this file only writes it. That split is why the no-PII
// rule is a test rather than a habit: a sink cannot be unit-tested, and a rule
// that only lives in an untested file is a rule that drifts.
//
// NO DEPENDENCY, on purpose. The deployment target captures stdout and parses
// JSON lines into structured, queryable logs — that IS the platform's own
// reporter, which is what PRD 6 P0-1 asks for ("a small dependency, or the
// platform's own — this is not a place to hand-roll"). A logging library here
// would buy transports nothing in this product sends to.
//
// One line per event, JSON, no interpolation: a log line split across two
// physical lines is a log line the platform indexes as two events, and a
// stack trace in the middle of a message is how that happens.
import { placementLogLine, type PlacementLogInput } from '@countertop/core';

export function logPlacement(input: PlacementLogInput): void {
  console.log(JSON.stringify(placementLogLine(input)));
}
