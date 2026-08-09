'use client';

import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { promptPayPayload, promptPayTarget } from '@wewin/core/promptpay';

import type { PaymentAccount } from '../../lib/payment/api';
import { useLocale } from '../../state/localeContext';
import type { Translate } from '../../i18n/translate';
import { QrCode } from '../configurator/QrCode';

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
    <fieldset className="border border-line bg-panel p-4">
      <legend className="px-1 text-lead text-chalk">{t('payment.account.legend')}</legend>

      <div className="mt-3 flex flex-col gap-3">
        {accounts.map((account) => {
          const selected = account.id === selectedId;

          return (
            <label
              key={account.id}
              className={`flex flex-col gap-3 border p-3 ${
                selected ? 'border-sel-line bg-sel-bg' : 'border-line bg-panel-2'
              }`}
            >
              <span className="flex items-start gap-3">
                <input
                  type="radio"
                  name="payment-account"
                  checked={selected}
                  onChange={() => onSelect(account.id)}
                />
                <span className="flex flex-col">
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
                    className="border border-line px-3 py-1 text-caption text-chalk"
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
    </fieldset>
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
