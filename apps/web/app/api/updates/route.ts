// The changes-since endpoint (P0-5).
//
// The client sends back the cursor it was last given and gets two things: the
// current cursor, and whether anything has happened since. It never sends a
// clock reading — clock skew is not a bug we accept (CLAUDE.md time rules) —
// and it never gets order data here. What it does with `changed: true` is
// re-render, which keeps ONE rendering path for a queue card (the server
// component) instead of a second copy of it living in a client bundle.
//
// A WebSocket upgrade (P2) pushes this same payload. That is the point of
// putting the freshness question behind a cursor rather than behind a timer.
import { queueCursor } from '@countertop/db/queue';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const cursor = await queueCursor();
  const echoed = new URL(request.url).searchParams.get('cursor');

  return Response.json(
    // A client that sent no cursor has nothing rendered that could be stale:
    // it gets the cursor and no refresh, not a spurious one.
    { cursor, changed: echoed !== null && echoed !== cursor },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
