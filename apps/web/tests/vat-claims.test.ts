import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
/* Not from '@wewin/i18n' — that root is types-only and the import would throw at run time. */
import { LOCALES } from '@wewin/i18n/locales';

/**
 * Any digit seven, in any script these catalogues use, followed by a per-cent sign.
 *
 * `my.ts:43` writes `VAT ၇%` with U+107F, the Burmese seven. A regex matching only ASCII `7`
 * passes that file while the claim is still there — the vacuous-green failure this suite exists
 * to prevent. `de.ts` writes `7 %` with a space before the sign, which is the German
 * convention, so the space is optional rather than absent.
 */
const RATE_CLAIM = /[7๗၇७७७７]\s*%/u;

/** Entry lines only, so a translator note explaining a convention is not treated as a claim. */
const entryLines = (source: string) =>
  source.split('\n').filter((line) => /^\s*'[a-z]/iu.test(line.trimStart()) || /':\s/u.test(line));

describe('the storefront makes no VAT-rate claim', () => {
  it('has no catalogue entry naming a rate, in any locale', () => {
    for (const locale of LOCALES) {
      /* Relative to the vitest root, which for apps/web is the app directory — not the repo
         root. Check `apps/web/vitest.config.ts`'s `root` before trusting a bare path. */
      const source = readFileSync(`src/i18n/catalogues/${locale}.ts`, 'utf8');

      /* A rate baked into a prerendered page is a claim that goes stale the first time an admin
         edits tax_countries, and nothing would fail. */
      for (const line of entryLines(source)) {
        expect(line, `${locale}: ${line.trim()}`).not.toMatch(RATE_CLAIM);
      }
    }
  });

  it('has removed the four exclusivity keys from the key table', () => {
    const keys = readFileSync('src/i18n/keys.ts', 'utf8');
    for (const key of [
      'price.vatExcluded',
      'price.vatExcludedShort',
      'home.pricing.excluded.vat',
      'about.fact.startingPrice.note',
    ]) {
      expect(keys, key).not.toContain(`'${key}'`);
    }
  });

  it('keeps the keys that are data-driven or still true', () => {
    const keys = readFileSync('src/i18n/keys.ts', 'utf8');
    expect(keys).toContain(`'quotation.vat'`);
    expect(keys).toContain(`'home.pricing.excluded.title'`);
    expect(keys).toContain(`'summary.area'`);
  });
});
