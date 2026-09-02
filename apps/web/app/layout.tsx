import type { Metadata } from 'next';
import { Archivo, Zilla_Slab } from 'next/font/google';
import './globals.css';

// The brand's two faces, and the split is load-bearing: Zilla Slab is the
// wordmark and display copy, Archivo is everything else. Both are loaded here
// as CSS variables and wired to `--font-sans` / `--font-display` in
// globals.css, so a component asks for `font-display` and never for a family
// name. Weights are the ones the sheet lists — Archivo is variable (400–900),
// Zilla Slab is not, so its three are named.
const archivo = Archivo({ subsets: ['latin'], variable: '--font-archivo', display: 'swap' });
const zillaSlab = Zilla_Slab({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-zilla-slab',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Countertop',
  description: 'Pickup ordering for Firebird Kitchen.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${zillaSlab.variable}`}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
