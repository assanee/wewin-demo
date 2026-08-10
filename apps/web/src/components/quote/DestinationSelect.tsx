import type { ReactElement } from 'react';

import type { Destination } from '../../lib/quote/destinations';

/**
 * ⭐ A plain, controlled `<select>` — `options`, `value` and `onChange`, nothing else.
 *
 * No fetch, no state, no failure handling of its own: `RequestQuotationForm` owns all three,
 * populating `options` from `../../lib/quote/destinations` and degrading to Thailand alone when
 * that read fails. Keeping this component to three props is what lets it render with
 * `renderToStaticMarkup` and no DOM (`apps/web/tests/quote-destinations.test.ts`) — the app has
 * deliberately no `@testing-library/*`, no `jsdom`, no msw.
 *
 * `options` is rendered in the order it arrives — `sort_order`, already applied by the API —
 * and never re-sorted here.
 */
export function DestinationSelect({
  options,
  value,
  onChange,
  label,
  disabled = false,
}: {
  readonly options: readonly Destination[];
  readonly value: string;
  readonly onChange: (code: string) => void;
  /** A real `<label>`'s text. Optional only so a caller-less render (a test) still has one. */
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-caption text-chalk-2">{label ?? 'ปลายทางสินค้า'}</span>
      <select
        className="w-full border border-line bg-panel-2 px-3 py-2 text-body text-chalk"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      >
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.nameTh}
          </option>
        ))}
      </select>
    </label>
  );
}
