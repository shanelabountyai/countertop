// The Firebird Kitchen mark and lockup.
//
// Redrawn as inline SVG rather than copied out of the design sheet, which
// builds both from CSS borders: a border triangle cannot be recoloured by a
// token, cannot scale with its box, and cannot be printed one-colour. The
// geometry below is that drawing, normalised to a 100-unit square — the sheet's
// 88px mark has a 44-wide, 38-tall flame centred in it and a 12-tall base bar,
// which is where every number here comes from.
//
// docs/design/README.md is the authority for the rules; this file is only
// allowed to be the authority for the coordinates.

/** The four permitted colourways, and no others (one of the sheet's four
 *  don'ts is recolouring outside them). Only FULL COLOUR carries the ink base
 *  bar — the single-colour versions knock the flame out of a solid square, so
 *  a bar would have nothing to sit against. */
const COLOURWAYS = {
  full: { square: 'var(--color-brand-red)', flame: '#ffffff', bar: 'var(--color-ink)' },
  black: { square: 'var(--color-ink)', flame: '#ffffff', bar: null },
  reversed: { square: '#ffffff', flame: 'var(--color-ink)', bar: null },
  onRed: { square: '#ffffff', flame: 'var(--color-brand-red)', bar: null },
} as const;

export type Colourway = keyof typeof COLOURWAYS;

/** Below 48px the flame drops out and only the F survives — the sheet's rule,
 *  and the reason 32 and 16 are a different drawing rather than a smaller one.
 *  A 25-unit-wide white wedge inside a 32px square is three pixels of grey. */
export const FLAME_MIN_PX = 48;

/**
 * The mark: a square, a flame, and (in full colour) a dark bar across the base.
 * Decorative by construction — every caller pairs it with the wordmark or with
 * a heading, so it is `aria-hidden` and never carries the accessible name.
 */
export function Mark({
  size = 88,
  colourway = 'full',
  className,
}: {
  size?: number;
  colourway?: Colourway;
  className?: string;
}) {
  const c = COLOURWAYS[colourway];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <rect width="100" height="100" fill={c.square} />
      {size >= FLAME_MIN_PX ? (
        <>
          <polygon points="50,28.4 75,71.6 25,71.6" fill={c.flame} />
          {c.bar ? <rect y="86.4" width="100" height="13.6" fill={c.bar} /> : null}
        </>
      ) : (
        /* The monogram. Square only, never in a circle — the first don't. */
        <text
          x="50"
          y="50"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="var(--font-display)"
          fontWeight="700"
          fontSize="62"
          fill={c.flame}
        >
          F
        </text>
      )}
    </svg>
  );
}

/**
 * The horizontal primary lockup — menu boards, site header, receipts.
 *
 * Renders inline elements only, so a caller can put it inside the `<h1>` that
 * was previously plain text and keep the heading. The wordmark is Zilla Slab
 * and the "KITCHEN" line is Archivo: setting the wordmark in the UI sans is
 * the second of the sheet's four don'ts, so the two faces are named here
 * rather than inherited.
 *
 * ponytail: one fixed size. The sheet's 120px minimum width and its clear-space
 * rule are respected by this one composition (56px mark + wordmark ≈ 200px);
 * a `size` prop appears when a second call site actually needs a second size.
 */
export function Lockup({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-4 ${className}`}>
      <Mark size={56} className="shrink-0" />
      <span className="inline-flex flex-col">
        <span className="font-display text-4xl leading-none font-bold tracking-tight">
          Firebird
        </span>
        <span className="mt-2 text-xs font-extrabold tracking-[0.42em] text-stone-700 uppercase">
          Kitchen
        </span>
      </span>
    </span>
  );
}
