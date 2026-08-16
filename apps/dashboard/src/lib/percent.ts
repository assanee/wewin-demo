/**
 * ─────────────────────────────────────────────────────────────────────────────
 * A percentage somebody typed, as basis points. The parsing only — never the words.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Two screens take a percentage and send basis points: the deposit on one order, and the
 * forfeit rates on the company's policy. The *reading* is identical — trim, drop a trailing
 * `%`, accept Thai digits, refuse more precision than a basis point can carry — and the
 * *sentences* are not, because they give different advice: a deposit of 0 is a policy mistake
 * with a fix ("charge 100% once"), while a forfeit of 0 is the normal, generous answer.
 *
 * So this returns a **kind** and never a message. A shared parser that also owned the Thai
 * would push both callers towards one vague sentence covering both, which is how "invalid"
 * gets written.
 *
 * ⚠️ Thai digits are accepted because a Thai keyboard produces them. Refusing them refuses the
 * person, not the input.
 */

export type PercentReading =
  | { readonly ok: true; readonly bp: number }
  | { readonly ok: false; readonly kind: 'empty' | 'shape' | 'precision' };

export function parsePercentBp(raw: string): PercentReading {
  const typed = raw.trim().replace(/%$/u, '').trim();
  if (typed === '') return { ok: false, kind: 'empty' };

  const normalised = typed.replace(/[๐-๙]/gu, (digit) => String(digit.charCodeAt(0) - 0x0e50));
  if (!/^\d+(\.\d+)?$/u.test(normalised)) return { ok: false, kind: 'shape' };

  /*
   * A basis point is one hundredth of a percent, so 30.555% is a number the wire cannot carry.
   * Rounding it silently would send a figure nobody typed and show it back as though they had.
   */
  const [, fraction = ''] = normalised.split('.');
  if (fraction.length > 2) return { ok: false, kind: 'precision' };

  return { ok: true, bp: Math.round(Number(normalised) * 100) };
}

/** Basis points as a person reads them back: `3000` → `'30'`, `3025` → `'30.25'`. */
export function percentTextOf(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const fraction = bp % 100;
  if (fraction === 0) return String(whole);
  return `${String(whole)}.${String(fraction).padStart(2, '0').replace(/0$/u, '')}`;
}
