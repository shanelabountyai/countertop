// The staff boundary (C-037).
//
// ONE guard, at the routing layer, rather than a check repeated at the top of
// fifteen server actions. Every kitchen write is a server action rendered on a
// /kitchen page, and a server action POSTs to the path it was rendered on — so
// matching the route matches the writes too, and adding a sixteenth action
// cannot forget to be protected.
//
// Not the ONLY guard any more (SEC-04, scorecard K3): a route-layer matcher
// is only as good as the routing layer, and a server action is addressed by
// its id rather than by the path it was rendered on. Every kitchen page,
// route handler and 'use server' export now also calls `lib/require-staff.ts`
// itself, and `lib/require-staff.test.ts` fails the suite if one does not.
// This file stays the first line: it is what sends a browser to the login
// page and re-issues a cookie mid-rotation.
import { NextResponse, type NextRequest } from 'next/server';
import {
  STAFF_COOKIE,
  STAFF_COOKIE_MAX_AGE,
  staffCookieGeneration,
  staffPasscode,
  staffToken,
} from '@/lib/staff-auth';

const LOGIN = '/kitchen/login';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (pathname === LOGIN) return NextResponse.next();
  const generation = await staffCookieGeneration(request.cookies.get(STAFF_COOKIE)?.value);
  if (generation === 'current') return NextResponse.next();
  if (generation === 'previous') {
    // Mid-rotation (C-158): let this tablet in and move its cookie to the new
    // passcode, so it is still signed in after the old one is retired.
    const response = NextResponse.next();
    response.cookies.set(STAFF_COOKIE, await staffToken(staffPasscode()), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/kitchen',
      maxAge: STAFF_COOKIE_MAX_AGE,
      secure: process.env.NODE_ENV === 'production',
    });
    return response;
  }

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
