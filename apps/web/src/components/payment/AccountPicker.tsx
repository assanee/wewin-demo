'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { promptPayPayload, promptPayTarget } from '@wewin/core/promptpay';

import type { PaymentAccount } from '../../lib/payment/api';
import { useLocale } from '../../state/localeContext';
import type { Translate } from '../../i18n/translate';
import { QrCode } from '../configurator/QrCode';
import { PaymentFieldset } from './PaymentFieldset';

/**
 * ⭐ Which of the company's accounts, and the QR for the amount actually being sent.
 *
 * ── The QR encodes the amount, and the amount is not fixed ──────────────────────
 *
 * `PaymentInstructionsWire` carries `promptpayId`, never a ready-made payload — the API's
 * own note on the type explains why: a server-built payload would freeze the outstanding
 * figure at the moment the page loaded, and this screen lets the customer transfer
 * something else (a partial payment, a rounded one). So the payload is rebuilt here, from
 * `@wewin/core/promptpay`, every time `amountThbMinor` changes — `useMemo`'s dependency
 * array *is* that "rebuild on every amount change" rule, not a decoration on it.
 *
 * ⚠️ **A bad stored id degrades to "account without a QR", never to a broken page.**
 * `promptPayTarget` already returns `null` rather than throwing for a row the ten/thirteen
 * digit CHECK let through in some other shape; `promptPayPayload` throws for a non-positive
 * amount, which a customer mid-edit of the amount field passes through constantly. Both are
 * caught here and both render the same way: the account's own details stay visible, and the
 * QR block simply is not there.
 */
export interface AccountPickerProps {
  readonly accounts: readonly PaymentAccount[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  /** `null` while the amount field does not currently parse to a positive figure. */
  readonly amountThbMinor: bigint | null;
}

export function AccountPicker({
  accounts,
  selectedId,
  onSelect,
  amountThbMinor,
}: AccountPickerProps): ReactElement {
  const { t } = useLocale();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    if (copiedId === null) return;
    const timer = setTimeout(() => setCopiedId(null), 1600);
    return () => clearTimeout(timer);
  }, [copiedId]);

  return (
    <PaymentFieldset legend={t('payment.account.legend')}>
      <div className="flex flex-col gap-3">
        {accounts.map((account) => {
          const selected = account.id === selectedId;

          return (
            /*
             * ⚠️ The accent is the **border**, not a fill.
             *
             * This card was `border-sel-line bg-sel-bg`, which is the app's own selected-state
             * pair — but everywhere else it is spent on something small: a 4.5×4.5 checkbox in
             * `FilterPanel`, a 140px colour chip, a cart badge. Flooding a full-width card with
             * `--color-sel-bg` made a third accent area on a screen that already spends its two
             * on the outstanding figure (`text-lime`) and the submit button, which is the cap
             * spec section 2 puts on it. The border and the filled radio carry the state; the
             * card keeps `bg-panel-2` whether it is chosen or not.
             */
            <label
              key={account.id}
              className={`flex cursor-pointer flex-col gap-3 rounded-xs border bg-panel-2 p-3 transition-colors duration-180 ease-out ${
                selected ? 'border-sel-line' : 'border-line hover:border-line-2'
              }`}
            >
              <span className="flex items-start gap-3">
                {/*
                 * The app's own control, following `FilterPanel.tsx:79-97`: the real input is
                 * `sr-only` — focusable and announced, merely not painted — and a `peer`, so
                 * the drawn dot can carry both the checked state and the focus ring. The
                 * browser's default radio was the only one in the storefront, and it ignores
                 * the palette entirely (it renders system blue on a near-black panel).
                 */}
                <input
                  type="radio"
                  name="payment-account"
                  checked={selected}
                  onChange={() => onSelect(account.id)}
                  className="peer sr-only"
                />
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-full border transition-colors duration-180 ease-out peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-sel-line ${
                    selected ? 'border-sel-line bg-sel-bg' : 'border-line-2 bg-panel'
                  }`}
                >
                  {/* The dot, not a colour swap alone — `FilterPanel` makes the same point
                      about state that is invisible to a colour vision deficiency. */}
                  <span className={`h-2 w-2 rounded-full ${selected ? 'bg-lime' : 'bg-transparent'}`} />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-body text-chalk">
                    {account.bankCode} · {account.accountName}
                  </span>
                  <span className="numeric text-small text-chalk-2">{account.accountNumber}</span>
                </span>
              </span>

              {selected ? (
                <div className="flex flex-col items-start gap-3 pl-7">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard?.writeText(account.accountNumber).then(() => {
                        setCopiedId(account.id);
                      });
                    }}
                    /* `min-h-11` is spec section 8's floor on every touch target — this one is
                     * pressed with a thumb, standing at a banking app, and was 26px tall. */
                    className="inline-flex min-h-11 items-center rounded-xs border border-line bg-panel px-3 text-caption text-chalk transition-colors duration-180 ease-out hover:border-line-2"
                  >
                    {copiedId === account.id
                      ? t('payment.account.copied')
                      : t('payment.account.copy', { accountDigits: account.accountNumber })}
                  </button>

                  <Qr account={account} amountThbMinor={amountThbMinor} t={t} />
                </div>
              ) : null}
            </label>
          );
        })}
      </div>
    </PaymentFieldset>
  );
}

function Qr({
  account,
  amountThbMinor,
  t,
}: {
  readonly account: PaymentAccount;
  readonly amountThbMinor: bigint | null;
  readonly t: Translate;
}): ReactElement | null {
  const payload = useMemo(() => {
    if (amountThbMinor === null || amountThbMinor <= 0n) return null;
    if (account.promptpayId === null) return null;

    const target = promptPayTarget(account.promptpayId);
    if (target === null) return null;

    try {
      return promptPayPayload(target, amountThbMinor);
    } catch {
      // `promptPayPayload` throws for a non-positive amount, which is already excluded
      // above; the catch stays as the second, cheaper line of the same defence.
      return null;
    }
  }, [account.promptpayId, amountThbMinor]);

  if (payload === null) return null;

  return (
    <div className="flex flex-col items-start gap-1">
      <QrCode value={payload} size={180} alt={t('payment.account.qrAlt')} />
      <p className="text-caption text-chalk-3">{t('payment.account.qrHint')}</p>
    </div>
  );
}
