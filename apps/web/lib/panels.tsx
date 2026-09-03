// The two shapes every operator report is built from (C-016, shared at C-106).
//
// Lifted out of the sales report the moment the loyalty screen wanted the same
// tile. Not a component library and not a design system — two functions that
// were already written, moved one file over so the second screen reads as the
// same product rather than as a near-miss of it.

export function Stat({
  label,
  value,
  note,
  testId,
}: {
  label: string;
  value: string;
  note?: string;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border-2 border-neutral-300 p-3">
      <p className="text-base text-neutral-700">{label}</p>
      <p className="text-3xl font-bold tabular-nums" {...(testId && { 'data-testid': testId })}>
        {value}
      </p>
      {note && <p className="mt-1 text-base text-neutral-600">{note}</p>}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}
