'use client';

import { type ChangeEvent, type ReactElement, type ReactNode } from 'react';

import { useLocale } from '../../state/localeContext';

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
    <fieldset className="border border-line bg-panel p-4">
      <legend className="px-1 text-lead text-chalk">{t('payment.form.legend')}</legend>

      <div className="mt-3 flex flex-col gap-3">
        {phase.kind === 'failed' ? (
          <p className="border border-line bg-panel-2 p-3 text-small text-danger">{phase.message}</p>
        ) : null}

        {phase.kind === 'done' ? (
          <p className="border border-line bg-panel-2 p-3 text-small text-chalk">{t('payment.done')}</p>
        ) : null}

        <Field label={t('payment.form.image')}>
          <input
            type="file"
            accept="image/*"
            onChange={onFile}
            disabled={busy}
            className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
          />
          <span className="text-caption text-chalk-3">
            {file === null ? t('payment.form.imageHint') : file.name}
          </span>
        </Field>

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

        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="w-fit border border-lime bg-lime px-4 py-2 text-body text-ink disabled:opacity-60"
        >
          {phase.kind === 'uploading'
            ? t('payment.phase.uploading')
            : phase.kind === 'creating'
              ? t('payment.phase.creating')
              : t('payment.form.submit')}
        </button>
      </div>
    </fieldset>
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
