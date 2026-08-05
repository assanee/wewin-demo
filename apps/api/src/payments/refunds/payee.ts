/**
 * Where a refund goes, and whether that is where the money came from.
 *
 * ── The sentence this file exists for ────────────────────────────────────────────
 *
 * Plan 7.12 names it exactly: *"คืนเข้าบัญชีที่จ่ายมาเป็นค่าตั้งต้น — 'ขอคืนเข้าอีกบัญชีหนึ่ง'
 * คือประโยคที่มิจฉาชีพพูด"*. The path exists, because a real customer really does close a bank
 * account; it is separately approved and it is reported.
 *
 * ── `payee_is_original_account` is DERIVED, never read from the body ─────────────
 *
 * This is the same rule as `fault`, for the same reason, and it is worth stating as a rule
 * because both were nearly built the other way. A flag the requester sets is a flag the
 * requester sets to `yes`, and then the separate approval never fires and the report is empty
 * — the control is present, documented, and switched off by the party it is a control against.
 *
 * So the comparison is against the accepted slips on the order, here, and the caller's body has
 * no field for it. `deriveOriginalAccount` returns the flag *and* the reason it decided, so the
 * response can say which account it matched and a reviewer is not asked to trust a boolean.
 *
 * ── What "the same account" can and cannot mean here ─────────────────────────────
 *
 * ⚠️ A limitation, written down rather than papered over. `payment_slips` records
 * `payer_name` and `payer_account_last4` and **no bank code** — so "the same account" is proved
 * on the name and the last four digits, and the bank code on a refund is a field somebody
 * typed that nothing can check. Two accounts at two banks sharing a name and four digits would
 * compare equal.
 *
 * That is a narrower claim than "the money is going back where it came from", and the fix is a
 * column on the slip, which is `packages/db`'s to add. Until then the honest reading of
 * `payeeIsOriginalAccount: 'yes'` is *"the name and the last four digits match a slip we
 * accepted"*, and `matchedSlipId` is in the response so a reviewer can open the slip and look.
 */

/** The identifying half of an accepted slip — the columns PDPA lets us keep when the image goes. */
export interface PayerOnRecord {
  readonly slipId: string;
  readonly payerName: string | null;
  readonly payerAccountLast4: string | null;
}

export interface PayeeRequest {
  readonly name: string;
  readonly bankCode: string;
  readonly accountLast4: string;
}

export interface DerivedPayee {
  readonly name: string;
  readonly bankCode: string;
  readonly accountLast4: string;
  readonly isOriginalAccount: 'yes' | 'no';
  /** The slip it matched, when it matched one. Null is the whole reason for the separate approval. */
  readonly matchedSlipId: string | null;
}

/**
 * Case- and space-insensitive, and nothing more clever than that.
 *
 * A bank statement writes a name in capitals, a customer types it in mixed case, and staff
 * re-key it with a double space. Normalising those three is the difference between a control
 * that fires on real deviations and one that fires on everything and is therefore clicked
 * through. Anything beyond it — transliteration, initials, honorifics — would start *accepting*
 * differences, and accepting differences is the failure this comparison exists to prevent.
 */
function sameName(left: string, right: string): boolean {
  const normalise = (value: string): string => value.trim().replace(/\s+/gu, ' ').toLocaleUpperCase('th-TH');
  return normalise(left).length > 0 && normalise(left) === normalise(right);
}

/**
 * Decide the payee and the flag together, from the slips and (optionally) what was asked for.
 *
 * Two shapes of call, and they are not symmetrical on purpose:
 *
 *   no `requested`   the default path. The payee IS the account on record, so there is nothing
 *                    to compare and nothing to approve separately. If there is no usable account
 *                    on record this returns `undefined` — the caller must then supply a payee
 *                    and a reason, and it will be flagged. Failing closed, not guessing.
 *
 *   a `requested`    somebody typed an account. It is compared against every accepted slip, and
 *                    matching *any* of them is enough: a customer who paid a deposit from one
 *                    account and the balance from another is entitled to a refund to either.
 */
export function deriveOriginalAccount(input: {
  readonly onRecord: readonly PayerOnRecord[];
  readonly requested?: PayeeRequest | undefined;
  /** Only used on the default path; a slip has no bank code to offer. See the note above. */
  readonly defaultBankCode?: string | undefined;
}): DerivedPayee | undefined {
  const usable = input.onRecord.filter(
    (slip): slip is PayerOnRecord & { payerName: string; payerAccountLast4: string } =>
      slip.payerName !== null && slip.payerAccountLast4 !== null,
  );

  if (input.requested === undefined) {
    /*
     * The default: refund to the account that paid. The most recent usable slip wins, which is
     * the account the customer used last and therefore the one most likely to still be open.
     */
    const [latest] = usable;
    if (latest === undefined) return undefined;

    return {
      name: latest.payerName,
      bankCode: input.defaultBankCode ?? '',
      accountLast4: latest.payerAccountLast4,
      isOriginalAccount: 'yes',
      matchedSlipId: latest.slipId,
    };
  }

  const requested = input.requested;
  const matched = usable.find(
    (slip) =>
      slip.payerAccountLast4 === requested.accountLast4 && sameName(slip.payerName, requested.name),
  );

  return {
    name: requested.name,
    bankCode: requested.bankCode,
    accountLast4: requested.accountLast4,
    isOriginalAccount: matched === undefined ? 'no' : 'yes',
    matchedSlipId: matched?.slipId ?? null,
  };
}
