// The staff boundary (C-037).
//
// ONE guard, at the routing layer, rather than a check repeated at the top of
// fifteen server actions. Every kitchen write is a server action rendered on a
// /kitchen page, and a server action POSTs to the path it was rendered on — so
// matching the route matches the writes too, and adding a sixteenth action
// cannot forget to be protected.
//
// ponytail: route-layer, so an action imported into a page OUTSIDE /kitchen
// would bypass it. Nothing does today (`grep "from './actions'"` is the
// check, and auth.spec.ts asserts the POST is refused). If a kitchen action
// ever needs to be called from a customer surface, the upgrade is a
// requireStaff() at the top of that action — not a second matcher.
import { NextResponse, type NextRequest } from 'next/server';
import { isStaff, STAFF_COOKIE } from '@/lib/staff-auth';

const LOGIN = '/kitchen/login';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (pathname === LOGIN) return NextResponse.next();
  if (await isStaff(request.cookies.get(STAFF_COOKIE)?.value)) return NextResponse.next();

  // A GET is a person who navigated: send them somewhere they can do something
  // about it. Anything else is a server action, and a 307 would make the
  // browser re-POST the action's payload at the login page; 401 is the honest
  // answer and surfaces as the action's error rather than as a mystery.
  if (request.method !== 'GET') {
    return new NextResponse('Not signed in.', { status: 401 });
  }

  const login = new URL(LOGIN, request.url);
  login.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(login);
}

// `:path*` makes the segment optional, so this matches /kitchen itself as well
// as everything beneath it. Customer surfaces and /api/updates — which returns
// a cursor and a boolean, never order data — are deliberately outside it.
export const config = { matcher: '/kitchen/:path*' };
