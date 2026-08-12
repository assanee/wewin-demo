'use client';

import { type ChangeEvent, type ReactElement, type ReactNode } from 'react';

import { useLocale } from '../../state/localeContext';
import { Button } from '../common/Button';
import { PaymentFieldset } from './PaymentFieldset';

/**
 * Stable ids, because two `<label>`s and an `aria-describedby` all have to name the same
 * input. Constants rather than `useId()` on purpose: there is exactly one slip form on the
 * page — `PaymentIsland` renders it or the sign-in prompt, never both — so a generated id
 * would buy nothing and would change between the server render and the client one.
 */
const FILE_INPUT_ID = 'payment-slip-image';
const FILE_HINT_ID = 'payment-slip-image-hint';

/**
 * The state of one submission attempt, following `ChangePassword.tsx:42-46`.
 *
 * ⚠️ There is no `'sessionExpired'` member here, on purpose. Trap 5 is real but it is not a
 * *phase* of a submission — it is answered by `PaymentIsland` swapping this form out for
 * `<AccountForm initialMode="sign-in">` while leaving every field in this component's props
 * exactly as it was, and by `phase` staying `'failed'` with `payment.problem.signInAgain` as
 * its message underneath that swap. Adding a sixth member here would let a future change
 * render this form *and* the sign-in prompt at once, which is the bug this shape forecloses.
 */
export type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'uploading' }
  | { readonly kind: 'creating' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done' };

export interface SlipFormProps {
  readonly file: File | null;
  readonly onFileChange: (file: File | null) => void;
  readonly amountText: string;
  readonly onAmountChange: (value: string) => void;
  readonly transferredAtLocal: string;
  readonly onTransferredAtChange: (value: string) => void;
  readonly bankReference: string;
  readonly onBankReferenceChange: (value: string) => void;
  readonly phase: Phase;
  readonly onSubmit: () => void;
}

/**
 * The form itself: one photograph, the amount and time it names, an optional reference.
 *
 * ⚠️ **Uploads only ever happen from inside `onSubmit`, in the caller.** This component
 * never calls `uploadSlipImage` or `createSlip` — it only reports which file is chosen and
 * when the button was pressed. That is what makes trap 3 (the 15-minute upload handle TTL)
 * closable at all: the caller controls exactly when the upload fires, which is "the form is
 * complete", not "a file was picked".
 */
export function SlipForm({
  file,
  onFileChange,
  amountText,
  onAmountChange,
  transferredAtLocal,
  onTransferredAtChange,
  bankReference,
  onBankReferenceChange,
  phase,
  onSubmit,
}: SlipFormProps): ReactElement {
  const { t } = useLocale();
  const busy = phase.kind === 'uploading' || phase.kind === 'creating';

  const onFile = (event: ChangeEvent<HTMLInputElement>): void => {
    onFileChange(event.target.files?.[0] ?? null);
  };

  return (
    <PaymentFieldset legend={t('payment.form.legend')}>
      <div className="flex flex-col gap-3">
        {phase.kind === 'failed' ? (
          <p className="border border-line bg-panel-2 p-3 text-small text-danger">{phase.message}</p>
        ) : null}

        {phase.kind === 'done' ? (
          <p className="border border-line bg-panel-2 p-3 text-small text-chalk">{t('payment.done')}</p>
        ) : null}

        {/*
         * ─────────────────────────────────────────────────────────────────────
         * ⭐ THE FILE INPUT, WHICH WAS WRITING ENGLISH ONTO AN ALL-THAI PAGE.
         * ─────────────────────────────────────────────────────────────────────
         *
         * A bare `<input type="file">` renders `Choose File  No file chosen` — drawn by the
         * browser, in the *browser's* language, and unreachable from CSS. On a storefront
         * whose whole point is eight locales, the one control a customer must press to pay
         * was hard-coded English on a Thai page.
         *
         * ⚠️ The input is still the input. `sr-only` hides it visually while leaving it in
         * the accessibility tree, focusable and operable exactly as before — the same
         * technique `FilterPanel` uses for its checkboxes and `AppShell` for its skip link.
         * `display: none` or `hidden` would have taken it out of the tree and broken keyboard
         * and screen-reader access, which is the usual way this fix goes wrong.
         *
         * The `<label htmlFor>` is a real label, so clicking it opens the picker with no
         * JavaScript and no `ref.click()`; and because the input is a `peer`, the label can
         * show the focus ring the hidden input is receiving. Without that last part a
         * keyboard user would tab onto an invisible control and see nothing at all.
         *
         * Two labels point at one input, which is valid and deliberate: the field caption
         * names it for assistive technology, the button is what a sighted user presses.
         */}
        <div className="flex flex-col gap-1">
          <label htmlFor={FILE_INPUT_ID} className="text-caption text-chalk-2">
            {t('payment.form.image')}
          </label>

          <input
            id={FILE_INPUT_ID}
            type="file"
            accept="image/*"
            onChange={onFile}
            disabled={busy}
            aria-describedby={FILE_HINT_ID}
            className="peer sr-only"
          />

          <label
            htmlFor={FILE_INPUT_ID}
            className="inline-flex min-h-11 w-fit cursor-pointer items-center rounded-xs border border-line bg-panel-2 px-4 text-body text-chalk transition-colors duration-180 ease-out hover:border-line-2 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-sel-line peer-disabled:cursor-not-allowed peer-disabled:opacity-60"
          >
            {t(file === null ? 'payment.form.imageChoose' : 'payment.form.imageChange')}
          </label>

          {/* The chosen file's name, where the browser used to print "No file chosen". */}
          <span id={FILE_HINT_ID} className="text-caption text-chalk-3">
            {file === null ? t('payment.form.imageHint') : file.name}
          </span>
        </div>

        <Field label={t('payment.form.amount')}>
          <input
            type="text"
            inputMode="decimal"
            value={amountText}
            onChange={(event) => onAmountChange(event.target.value)}
            disabled={busy}
            className="numeric w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
          />
        </Field>

        <Field label={t('payment.form.transferredAt')}>
          <input
            type="datetime-local"
            value={transferredAtLocal}
            onChange={(event) => onTransferredAtChange(event.target.value)}
            disabled={busy}
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
          />
        </Field>

        <Field label={t('payment.form.reference')}>
          <input
            type="text"
            value={bankReference}
            onChange={(event) => onBankReferenceChange(event.target.value)}
            disabled={busy}
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
          />
        </Field>

        {/*
         * ⚠️ Kept lime, and switched to the shared `Button`.
         *
         * The filled accent is right here and it is the *one* place on this screen that earns
         * it: `Button.tsx` reserves `primary` for the main action, `AccountForm` and
         * `RequestQuotationForm` both spend it on their submit, and the pay action on the
         * quotation page is the same lime. Toning this one down would have made the only
         * screen that takes money the only screen with no primary button on it — the account
         * card's flood was the surplus, not this.
         *
         * Going through the component rather than restating its classes is the point of the
         * round: hover, active, the 44px floor and the disabled treatment now come from the
         * same place as every other button in the storefront.
         */}
        <Button variant="primary" onClick={onSubmit} disabled={busy} className="w-fit">
          {phase.kind === 'uploading'
            ? t('payment.phase.uploading')
            : phase.kind === 'creating'
              ? t('payment.phase.creating')
              : t('payment.form.submit')}
        </Button>
      </div>
    </PaymentFieldset>
  );
}

function Field({ label, children }: { readonly label: string; readonly children: ReactNode }): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-chalk-2">{label}</span>
      {children}
    </label>
  );
}
