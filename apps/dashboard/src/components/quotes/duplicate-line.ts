import { decodeUm, encodeUm, type LengthWire } from '@wewin/contract/measure';

/**
 * ⭐ เพิ่มรายการเข้าใบเสนอราคา — by copying a line that is already on it.
 *
 * ── Why copy, when the endpoint takes a whole configuration ──────────────────────
 *
 * `POST /orders/:orderId/quote/lines` has existed since the quote editor did, and no screen
 * has ever called it: the editor can revise, re-present, remove, charge, override and verify
 * lines, and has no way to create one. Every line on every quotation in this system arrived
 * through the storefront's configurator, which means a salesperson taking an order by phone
 * cannot put a second window on it.
 *
 * The obvious repair is to bring the configurator into the dashboard — every option group,
 * every rule, live pricing, the lot. That is the storefront's whole `ConfiguratorIsland`
 * rebuilt against a second set of screens, and it is a feature rather than the missing wire.
 *
 * What a phone order actually looks like is *"the same window as that one, but 180 wide"*.
 * So this takes a line that is already priced and correct — the customer configured it, the
 * catalogue validated it, `priceLine` accepted it — and changes only the dimensions and the
 * quantity. The selections, the product version and the document hash come across untouched,
 * which means the copy cannot be a configuration the configurator would have refused.
 *
 * ⚠️ It is deliberately not a way to add a *different* product. That still needs the
 * configurator, and pretending otherwise would put a half-built one on this screen.
 */

/** Micrometres per centimetre. The catalogue's measures are µm; people speak cm. */
const UM_PER_CM = 10_000n;

/** What the dialog holds while somebody is typing: centimetres, as text. */
export interface MeasureEntry {
  readonly groupCode: string;
  readonly labelTh: string;
  readonly cm: string;
}

export type DuplicateResult =
  | {
      readonly ok: true;
      readonly measures: Readonly<Record<string, LengthWire>>;
      readonly qty: number;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Centimetres as typed → the µm the wire carries.
 *
 * ⚠️ **Scaled with `bigint`, and the honest reason is not the one first written here.** That
 * comment claimed `Number(cm) * 10000` loses precision — 180.05 becoming 1800499.9999…  — and
 * a mutation test disproved it: every value these boxes accept multiplies exactly, because the
 * products are small integers well inside a double's range. The float path passes all seven
 * tests. It was left in only long enough to check.
 *
 * The `bigint` path stays because it is exact *by construction* rather than by the input
 * happening to be small. Nothing here has to be re-derived if the box ever takes millimetres,
 * or five decimal places, or a dimension in the tens of metres — and the day one of those
 * changes, nobody has to rediscover which values a double stops being exact for.
 *
 * ⛔ What actually guards the wire is the regex below, not the arithmetic: `1e3`, `1,800` and
 * `-5` are the inputs that reach the server as something nobody typed, and rejecting them is
 * what the tests bite on.
 */
export function cmToUm(cm: string): bigint | null {
  const text = cm.trim();
  if (!/^\d+(\.\d{1,4})?$/u.test(text)) return null;

  const [whole = '0', fraction = ''] = text.split('.');
  /* Four decimal places is exactly µm precision at cm scale: 0.0001 cm = 1 µm. */
  const scaled = fraction.padEnd(4, '0');
  return BigInt(whole) * UM_PER_CM + BigInt(scaled);
}

/** The µm on an existing line → the centimetres to show in the box. */
export function umToCm(length: LengthWire): string {
  const um = decodeUm(length);
  const whole = um / UM_PER_CM;
  const fraction = um % UM_PER_CM;
  if (fraction === 0n) return whole.toString();

  /* Trailing zeros removed: 180.5000 reads as 180.5, which is what somebody would type. */
  return `${whole.toString()}.${fraction.toString().padStart(4, '0').replace(/0+$/u, '')}`;
}

/**
 * The measures and quantity for the copy, or every reason it cannot be made.
 *
 * All the problems rather than the first, for the same reason the product form gives all of
 * its: a dialog that reveals one at a time is a dialog somebody fills in three times.
 */
export function duplicateRequest(
  entries: readonly MeasureEntry[],
  qtyText: string,
): DuplicateResult {
  const problems: string[] = [];
  const measures: Record<string, LengthWire> = {};

  for (const entry of entries) {
    const um = cmToUm(entry.cm);
    if (um === null) {
      problems.push(`${entry.labelTh}: กรอกเป็นตัวเลข เช่น 180 หรือ 180.5`);
      continue;
    }
    if (um <= 0n) {
      problems.push(`${entry.labelTh}: ต้องมากกว่า 0`);
      continue;
    }
    measures[entry.groupCode] = encodeUm(um);
  }

  const qty = Number(qtyText.trim());
  if (!Number.isInteger(qty) || qty < 1) {
    problems.push('จำนวนต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป');
  }

  if (problems.length > 0) return { ok: false, problems };

  return { ok: true, measures, qty };
}
