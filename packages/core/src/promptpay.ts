import { satangField } from './money.js';

/**
 * ⭐ A PromptPay QR payload, built as a string.
 *
 * EMVCo's format is nested TLV in ASCII: a two-digit tag, a two-digit length, then that many
 * characters. Nothing here is base64 or binary, which is why this module needs no dependency
 * and can be tested without rendering anything.
 *
 * ⚠️ **The only failure this can have is silent.** A malformed payload does not scan and is
 * found immediately; a well-formed payload with the wrong amount scans perfectly and moves
 * the wrong money. That is why the tests assert against published vectors rather than
 * against a second implementation of the same arithmetic, and why the last step before
 * shipping this is scanning one with a real banking app.
 */

const ID_APPLICATION = 'A000000677010111';

export type PromptPayTarget =
  | { readonly kind: 'mobile'; readonly digits: string }
  | { readonly kind: 'taxId'; readonly digits: string };

/** `29` sub-tag: `01` for a mobile number, `02` for a tax id or national id. */
const SUB_TAG: Readonly<Record<PromptPayTarget['kind'], string>> = {
  mobile: '01',
  taxId: '02',
};

/** One TLV field. Length is characters, always two digits, so a 100-char value is illegal. */
function field(tag: string, value: string): string {
  if (value.length > 99) throw new RangeError(`promptpay: value for tag ${tag} is too long`);
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE — polynomial 0x1021, initial value 0xFFFF, no reflection, no final xor.
 *
 * This is the parameterisation EMVCo names, and it is not the same as the CRC-16 most
 * libraries default to. `crc16ccitt('123456789') === '29B1'` is the check value that tells
 * the two apart, which is why it is the first assertion in the test.
 */
export function crc16ccitt(input: string): string {
  let crc = 0xffff;

  for (const character of input) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) === 0 ? crc << 1 : (crc << 1) ^ 0x1021;
      crc &= 0xffff;
    }
  }

  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Read a stored `promptpay_id`, which the CHECK constraint has already limited to ten or
 * thirteen digits. Returns `null` rather than throwing, so a bad row shows the account
 * without a QR instead of taking the page down.
 *
 * ⚠️ **Ten digits is refused unless the first is `0` — `accountValue` is not the place that
 * decides this.** Every Thai mobile number is ten digits starting with `0` (the numbering
 * plan's `06`/`08`/`09` prefixes); a ten-digit id that does not is not a mobile number missing
 * a formality, it is not a mobile number, full stop. `bank_accounts_promptpay_shape` only
 * checks `^([0-9]{10}|[0-9]{13})$`, so `1812345678` reaches this function looking exactly like
 * a real one, and there is no second form for `accountValue` to detect and handle — accepting
 * it here would mean *guessing* which nine digits to keep, and a QR built on a guess is this
 * module's stated worst case: well-formed, scans fine, moves money to a number nobody asked
 * for. Refusing it is the same choice `accountValue`'s slice already assumed and this is where
 * that assumption gets checked, rather than trusted.
 */
export function promptPayTarget(id: string): PromptPayTarget | null {
  if (/^0[0-9]{9}$/u.test(id)) return { kind: 'mobile', digits: id };
  if (/^[0-9]{13}$/u.test(id)) return { kind: 'taxId', digits: id };
  return null;
}

/**
 * A mobile number as EMVCo wants it: country code, no leading zero, padded to thirteen.
 *
 * The `slice(1)` is safe only because `promptPayTarget` already refused any `mobile` target
 * whose first digit is not `0` — this function trusts that refusal rather than re-checking it,
 * the same division of labour `field()` and `promptPayPayload` keep everywhere else in this
 * module (shape checked once, on the way in).
 */
function accountValue(target: PromptPayTarget): string {
  if (target.kind === 'taxId') return target.digits;
  return `0066${target.digits.slice(1)}`;
}

/**
 * The payload for one transfer of a known amount.
 *
 * ⚠️ Point-of-initiation is `12` (dynamic), not `11` (static). A static QR means "any
 * amount", and one that also names an amount is a contradiction some banking apps resolve by
 * ignoring the amount — which is the failure that looks like it worked.
 */
export function promptPayPayload(target: PromptPayTarget, amountMinor: bigint): string {
  if (amountMinor <= 0n) {
    throw new RangeError(`promptpay: amount must be positive, got ${amountMinor.toString()}`);
  }

  const merchant = field('00', ID_APPLICATION) + field(SUB_TAG[target.kind], accountValue(target));

  const body =
    field('00', '01') +
    field('01', '12') +
    field('29', merchant) +
    field('53', '764') +
    field('54', satangField(amountMinor)) +
    field('58', 'TH');

  return `${body}6304${crc16ccitt(`${body}6304`)}`;
}
