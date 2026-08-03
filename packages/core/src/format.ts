/**
 * Display formatters. Spec section 1 requires every on-screen number to pass
 * through one of these, and section 11 forbids NaN and -0 from ever appearing.
 *
 * Each formatter degrades to a sane zero rather than throwing: a pricing bug
 * should show a wrong price, not blank the page mid-configuration.
 */

const THAI_LOCALE = 'th-TH';

/** Replace non-finite input with 0 and collapse -0 to 0. */
const safe = (value: number): number => (Number.isFinite(value) ? value + 0 : 0);

/** Thai baht, whole units. Quotes are never issued in satang. */
export function formatBaht(value: number): string {
  const rounded = Math.round(safe(value));
  const magnitude = Math.abs(rounded).toLocaleString(THAI_LOCALE, {
    maximumFractionDigits: 0,
  });

  return rounded < 0 ? `-฿${magnitude}` : `฿${magnitude}`;
}

/** Square metres, always two decimals (spec section 5). */
export function formatSqm(value: number): string {
  return safe(value).toFixed(2);
}

/** Centimetres to at most one decimal, with a trailing .0 trimmed. */
export function formatCm(value: number): string {
  const rounded = Math.round(safe(value) * 10) / 10;
  return String(rounded + 0);
}

/** Plain counts and day ranges. */
export function formatInteger(value: number): string {
  return Math.round(safe(value)).toLocaleString(THAI_LOCALE, { maximumFractionDigits: 0 });
}

/** Lead time as a range, e.g. "10–14 วัน". */
export function formatLeadTime([min, max]: [number, number]): string {
  return `${formatInteger(min)}–${formatInteger(max)} วัน`;
}

/** Dimensions as the configurator titles them, e.g. "320 × 160 cm". */
export function formatDimensions(width: number, height: number, unit: string): string {
  return `${formatCm(width)} × ${formatCm(height)} ${unit}`;
}
