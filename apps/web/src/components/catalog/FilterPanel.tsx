import { Check } from 'lucide-react';
import type { Category } from '@wewin/core';
import type { CatalogFilters, ProfileColorFacet } from '@wewin/core/filters';
import { isFilterActive } from '@wewin/core/filters';
import { formatBaht } from '@wewin/core/format';
import { bahtToMinor } from '@wewin/core/money';
import { Button } from '../common/Button';

interface FilterPanelProps {
  filters: CatalogFilters;
  onChange: (next: CatalogFilters) => void;
  categories: Category[];
  colorFacets: ProfileColorFacet[];
  bounds: { min: number; max: number };
}

const toggle = (list: string[], value: string): string[] =>
  list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

function Section({ titleTh, children }: { titleTh: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-4 first:border-t-0 first:pt-0">
      <h3 className="mb-3 text-small tracking-[0.08em] text-chalk-3 uppercase">{titleTh}</h3>
      {children}
    </section>
  );
}

/**
 * One panel, two homes: the lg sidebar and the mobile bottom sheet both render this.
 * Keeping it a single controlled component means the two modes cannot drift apart —
 * a facet added here appears in both without a second edit.
 */
export function FilterPanel({ filters, onChange, categories, colorFacets, bounds }: FilterPanelProps) {
  const active = isFilterActive(filters);

  return (
    <div className="flex flex-col">
      {active ? (
        <div className="mb-4 flex justify-end">
          <Button variant="ghost" onClick={() => onChange({ ...filters, categoryIds: [], profileColorCodes: [], minPricePerSqm: null, maxPricePerSqm: null })}>
            ล้างตัวกรอง
          </Button>
        </div>
      ) : null}

      <Section titleTh="หมวดหมู่">
        <ul className="flex flex-col gap-1">
          {categories.map((category) => {
            const checked = filters.categoryIds.includes(category.id);
            return (
              <li key={category.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xs px-2 transition-colors duration-180 ease-out hover:bg-panel-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onChange({ ...filters, categoryIds: toggle(filters.categoryIds, category.id) })}
                    className="peer sr-only"
                  />
                  {/* A colour swap alone is not a state indicator: at these contrast
                      levels it is easy to miss, and impossible to read for anyone with
                      a colour vision deficiency. The tick carries the meaning. */}
                  <span
                    aria-hidden
                    className={`flex h-4.5 w-4.5 shrink-0 items-center justify-center rounded-xs border transition-colors duration-180 ease-out peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-sel-line ${
                      checked
                        ? 'border-sel-line bg-sel-bg text-chalk'
                        : 'border-line-2 bg-panel-2 text-transparent'
                    }`}
                  >
                    <Check size={12} strokeWidth={3} />
                  </span>
                  <span className={`min-w-0 truncate text-body ${checked ? 'text-chalk' : 'text-chalk-2'}`}>
                    {category.labelTh}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section titleTh="สีโปรไฟล์">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
          {colorFacets.map((facet) => {
            const checked = filters.profileColorCodes.includes(facet.code);
            return (
              <label
                key={facet.code}
                className={`flex min-h-11 min-w-0 cursor-pointer items-center gap-2 rounded-xs border px-2 transition-colors duration-180 ease-out ${
                  checked ? 'border-sel-line bg-sel-bg text-chalk' : 'border-line bg-panel-2 text-chalk-2 hover:border-line-2'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange({ ...filters, profileColorCodes: toggle(filters.profileColorCodes, facet.code) })
                  }
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className="h-4 w-4 shrink-0 rounded-xs border border-line"
                  style={{ backgroundColor: facet.swatchHex }}
                />
                <span className="min-w-0 truncate text-small">{facet.labelTh}</span>
              </label>
            );
          })}
        </div>
      </Section>

      <Section titleTh="ราคาต่อ ตร.ม.">
        <div className="flex flex-col gap-3">
          <div className="numeric flex items-baseline justify-between text-small text-chalk-2">
            <span>{formatBaht(bahtToMinor(filters.minPricePerSqm ?? bounds.min))}</span>
            <span className="text-chalk-3">ถึง</span>
            <span>{formatBaht(bahtToMinor(filters.maxPricePerSqm ?? bounds.max))}</span>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-caption text-chalk-3">ไม่เกิน</span>
            <input
              type="range"
              min={bounds.min}
              max={bounds.max}
              step={100}
              value={filters.maxPricePerSqm ?? bounds.max}
              onChange={(event) => {
                const next = Number(event.target.value);
                onChange({ ...filters, maxPricePerSqm: next >= bounds.max ? null : next });
              }}
              className="h-11 w-full accent-sel-line"
            />
          </label>
        </div>
      </Section>
    </div>
  );
}
