// Cents → "$10.95". The one place money becomes a string.
//
// Display only. Nothing here is ever parsed back into a number — the server
// recomputes every price from the menu, so a formatted string has no way to
// become an input to a total (CLAUDE.md, "Server is the price authority").
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

/**
 * A modifier's price delta as the menu says it: "+$2.50", "−$1.00", or nothing
 * at all when it is free. A "+$0.00" beside every salsa is noise that trains
 * customers to stop reading the prices that do matter.
 *
 * Minus sign U+2212, not a hyphen: "-$1.00" at 14px reads as a dash.
 */
export function formatDeltaCents(cents: number): string {
  if (cents === 0) return '';
  return cents > 0 ? `+${formatCents(cents)}` : `−${formatCents(-cents)}`;
}
