import { useId, type ReactElement } from 'react';
import { LENGTH_UNITS, type LengthUnit } from '@wewin/core/units';
import { useDisplayUnit } from '../../state/displayUnitContext';
import { useLocale } from '../../state/localeContext';
import type { PlainKey } from '../../i18n/keys';

/**
 * Spoken names, because `mm` and `m` are one character apart and a screen reader
 * announcing "em" twice tells the customer nothing. The visible label stays the
 * abbreviation the sizes themselves are written with — `cm` is `cm` in all eight, and
 * translating an SI symbol would be a mistake, not a feature.
 *
 * Keys rather than Thai, so the announcement follows the page. This table is the map
 * from a unit to its key; the words are in the catalogues.
 */
const UNIT_NAME_KEYS: Record<LengthUnit, PlainKey> = {
  mm: 'unit.name.mm',
  cm: 'unit.name.cm',
  m: 'unit.name.m',
  in: 'unit.name.in',
  ft: 'unit.name.ft',
};

/**
 * The five display units, as the segmented control ToggleOption already uses — same
 * hairline frame, same selected fill — because this is the same question with more
 * answers, and a third control language for it would only make the header noisier.
 *
 * Native radios rather than buttons with `role="radio"`: the platform then supplies the
 * arrow-key behaviour OptionGroupBase hand-rolls, and this control has no blocked states
 * to keep focusable, which is the reason that file exists at all.
 *
 * Not lime. The accent is spent on the price and the primary action (spec section 2);
 * a control that only changes how a number is written has no claim on it.
 */
export function UnitPicker(): ReactElement {
  const { unit, setUnit } = useDisplayUnit();
  const { t } = useLocale();
  // Radios group by `name` across the whole document, so a second picker sharing a
  // literal would let an arrow key jump from one to the other.
  const groupName = useId();

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* The abbreviations name themselves once you know it is a unit picker; the word
          says so where there is room for it, and the group carries the same meaning to
          assistive tech at every width. */}
      <span aria-hidden className="hidden shrink-0 text-caption text-chalk-2 md:inline">
        {t('unit.pickerLabel')}
      </span>

      <div
        role="radiogroup"
        aria-label={t('unit.groupLabel')}
        // Sized by its content at base so it cannot push the wordmark or the cart off a
        // 360px header, and pinned to 224px from md up — 44px a segment, the touch target
        // the narrow viewport is the only place we cannot afford.
        className="grid min-w-0 shrink grid-cols-5 overflow-hidden rounded-xs border border-line md:w-56"
      >
        {LENGTH_UNITS.map((candidate) => {
          const isSelected = candidate === unit;

          return (
            <label
              key={candidate}
              className="flex min-h-11 min-w-0 items-center justify-center"
            >
              <input
                type="radio"
                name={groupName}
                value={candidate}
                checked={isSelected}
                onChange={() => setUnit(candidate)}
                aria-label={t(UNIT_NAME_KEYS[candidate])}
                className="peer sr-only"
              />
              {/* The fill alone would leave the current unit legible only to someone who
                  can separate #33421f from #202519, so the rule under the label carries
                  the state as a shape. Both states reserve it, or picking one would
                  shift the row by two pixels.

                  No transition: the stored preference is applied a commit after the first
                  paint, and a highlight sliding from cm to in on load reads as the page
                  correcting itself rather than as where it always was.

                  The focus ring is offset inwards — the frame clips its overflow, and an
                  outset ring would lose its outer edge on the first and last segment. */}
              <span
                className={`flex h-full w-full items-center justify-center border-b-2 px-1 text-small peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2 peer-focus-visible:outline-sel-line ${
                  isSelected
                    ? 'border-sel-line bg-sel-bg text-chalk'
                    : 'border-transparent bg-panel-2 text-chalk-2 hover:text-chalk'
                }`}
              >
                {candidate}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
