/**
 * Reading a localised number back, so that "the locale did not move the value" is a
 * property that can be *checked* rather than eyeballed.
 *
 * Written against `Intl` directly instead of importing `src/numerals.ts`, on purpose: a
 * decoder built from the same table as the encoder agrees with it by construction and
 * would pass even if both were wrong. This one asks ICU what the glyphs are and works
 * backwards from that.
 */

const digitsOf = (tag: string): readonly string[] => {
  const format = new Intl.NumberFormat(tag, { useGrouping: false, maximumFractionDigits: 0 });
  return Array.from({ length: 10 }, (_unused, digit) => format.format(digit));
};

const partOf = (tag: string, type: 'decimal' | 'group'): string => {
  const format = new Intl.NumberFormat(tag, {
    useGrouping: true,
    minimumFractionDigits: 1,
  });
  return format.formatToParts(12345.5).find((part) => part.type === type)?.value ?? '';
};

/** Locale glyphs back to ASCII digits and an ASCII point. Grouping is left alone. */
export function deLocalise(tag: string, text: string): string {
  const digits = digitsOf(tag);
  const decimal = partOf(tag, 'decimal');

  let out = '';
  for (const character of text) {
    const index = digits.indexOf(character);
    if (index >= 0) {
      out += String(index);
    } else if (character === decimal && decimal !== '') {
      out += '.';
    } else {
      out += character;
    }
  }
  return out;
}

/**
 * The integer inside a rendered amount, whatever the locale wrapped around it.
 *
 * Grouping separators are dropped and a leading minus is honoured, so `-฿8,791`,
 * `8.791 ฿` and `၈,၇၉၁ ฿` all come back as the same `bigint` — which is the only way to
 * compare eight renderings of one amount without trusting any of them.
 */
export function decodeInteger(tag: string, text: string): bigint {
  const ascii = deLocalise(tag, text);
  const group = partOf(tag, 'group');
  const stripped = group === '' ? ascii : ascii.split(group).join('');

  const match = /-?\d+(?:\.\d+)?/.exec(stripped);
  if (!match) throw new Error(`no number in ${text}`);

  const [whole = '0', fraction = ''] = match[0].split('.');
  // Kept as an integer count of the smallest unit shown, so a formatter that silently
  // dropped or gained a decimal place cannot compare equal to one that did not.
  return BigInt(`${whole}${fraction}`);
}
