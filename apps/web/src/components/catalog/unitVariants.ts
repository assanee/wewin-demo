import type { LengthUnit } from '@wewin/core/units';

/**
 * Plan 8.2's third cache trap, and the shape of this project's answer to it.
 *
 * > "Currency and display unit are per-user preferences and are in no cache key, while
 * > `ProductCard` already renders `formatBaht` on the server."
 *
 * The failure being avoided is precise: **one visitor's preference, cached, and served to
 * another.** A page rendered `in` for the first reader through the CDN is a page rendered
 * `in` for everybody behind them, and nothing errors — the numbers are all correct, they
 * are just answers to a question the second reader did not ask.
 *
 * The scaffold's README settles the three preferences three different ways, because they
 * are not alike. **Language** is a path segment, so it is in every cache key structurally.
 * **Currency** is fixed per locale (all eight resolve to THB today), so money renders on
 * the server and a crawler sees what a customer sees. The **display unit** is the one left,
 * and it is the one this module is about.
 *
 * ## Why a variant map rather than the two obvious alternatives
 *
 * *Put it in the URL* — `?unit=in` — multiplies 648 pages by five and splits the crawl
 * budget five ways over pages whose text is identical. It also makes a preference into a
 * canonicalisation problem, which is what a path segment was chosen for language to avoid.
 *
 * *Render it in the island* — pass the micrometres to the client and format there —
 * cannot be done without crossing the boundary with a `bigint`, which does not serialise;
 * converting to `number` at the boundary is precisely the "one division on the way to the
 * screen" that plan 4.6 spent a phase removing. And it re-runs `Intl` in the browser,
 * which is where the README's `my` finding bites: Node writes `၈,၇၉၁` and Chromium writes
 * `8,791` for the same call, so a value formatted on both sides of the boundary is a
 * hydration mismatch in exactly one of the eight locales.
 *
 * So: **the server formats all five, the island picks one.** Every string in the cached
 * HTML was produced by Node, once, from `bigint` micrometres, and the browser only ever
 * chooses between them. The cached page always carries the `cm` default — the unit the
 * catalogue is authored in — so no reader is served another reader's preference, and the
 * upgrade after hydration is a display change over an immutable canonical (plan 4.7).
 *
 * The cost is five short strings per measurement in the HTML instead of one. That is the
 * price of the property, and it is written down here rather than discovered later.
 */
export type UnitVariants = Readonly<Record<LengthUnit, string>>;

/**
 * Render one measurement in all five units, on the server, from exact micrometres.
 *
 * Written out rather than mapped over `LENGTH_UNITS`, which would need an assertion to
 * get back from `Record<string, string>`: an object literal is checked against
 * `UnitVariants` field by field, so a sixth unit added to core is a compile error here
 * instead of a `undefined` in an `aria-label` on whichever card is drawn first.
 */
export const unitVariants = (render: (unit: LengthUnit) => string): UnitVariants => ({
  mm: render('mm'),
  cm: render('cm'),
  m: render('m'),
  in: render('in'),
  ft: render('ft'),
});
