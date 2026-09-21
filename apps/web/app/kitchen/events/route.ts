// The ordered event feed (PRD 6 P1-1, C-161).
//
// `GET /kitchen/events?after=N` returns the events after position N, in order,
// and the position to ask from next. The substrate a ticket printer or a KDS
// bridge reads forward from — which `/api/updates` deliberately is not: that
// answers "has anything changed", this answers "what, in order, since N".
//
// Under /kitchen, so the middleware's staff check guards it (C-037). A bridge
// authenticates the way a tablet does, with the passcode cookie.
import { loadFeed } from '@countertop/db/queue';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('after') ?? '0';
  // A cursor is a non-negative integer or it is a bad request — never guessed.
  if (!/^\d{1,15}$/.test(raw)) {
    return Response.json({ error: 'after must be a non-negative integer' }, { status: 400 });
  }
  const page = await loadFeed(Number(raw), new Date());
  return Response.json(page, { headers: { 'Cache-Control': 'no-store' } });
}
