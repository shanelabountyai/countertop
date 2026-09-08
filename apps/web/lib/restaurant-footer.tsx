// The restaurant, findable and callable from every customer screen
// (PRD 5 P0-1, C-077).
//
// The product's founding premise is that phone orders tie up staff, and it
// resolved two of its worst customer moments — "come to the counter" and
// "call the restaurant if that is wrong" — with a phone call it did not
// enable. There was no number, no address and no hours on any customer route.
// This is that, in one server component, on all five of them.
//
// A server component with its own read rather than a prop threaded through
// five pages: the alternative is five pages each remembering to fetch and
// pass the same three columns, which is five places to forget it.
//
// ponytail: added by hand to each of the five customer routes rather than by
// a `(customer)` route group with a layout. A sixth customer route can forget
// it — the composer at /menu/[itemId] is exactly that route today, left out
// because P0-1 names five. Moving six directories to make it structural is
// the change to make when a second thing belongs on every customer screen.
import { loadRestaurantContact } from '@countertop/db/gate';

/**
 * A dialable href. Everything but digits and a leading `+` comes out, because
 * a dialler wants the number and a human wants the parentheses — and the
 * stored string is written for the human (see the schema).
 */
export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '');
  return `tel:${digits}`;
}

/**
 * The phone number as a link, sized to be tapped with one hand. Exported
 * because the cancelled and abandoned status views carry it a second time,
 * prominently and outside the footer — those are the two screens whose copy
 * already tells the customer to call (P0-1, second bullet).
 */
export function CallLink({ phone, className = '' }: { phone: string; className?: string }) {
  return (
    <a
      href={telHref(phone)}
      data-testid="call-restaurant"
      className={`inline-flex min-h-12 items-center font-semibold underline underline-offset-4 ${className}`}
    >
      {phone}
    </a>
  );
}

export async function RestaurantFooter() {
  const { name, addressLine, phone, hoursToday } = await loadRestaurantContact();

  return (
    <footer
      data-testid="restaurant-footer"
      className="mx-auto mt-12 max-w-2xl border-t border-neutral-300 px-6 py-6 text-sm text-neutral-700"
    >
      {/* Each line renders only if the column is filled: a restaurant that has
          not typed an address gets a footer without one, never a blank line
          where an address should be. */}
      {name && <p className="text-base font-semibold text-neutral-900">{name}</p>}
      {addressLine && <p className="mt-1">{addressLine}</p>}
      {phone && (
        <p className="mt-1">
          <CallLink phone={phone} />
        </p>
      )}
      <p className="mt-1" data-testid="hours-today">
        Today: {hoursToday}
      </p>
    </footer>
  );
}
