import type { PartialUiCatalogue } from '../keys';

/**
 * Chinese (中文) — **empty on purpose, and empty is a state this app supports.**
 *
 * Nothing in this file was machine translated. Plan section 13 lists the translations
 * as a bottleneck that is not code, and a plausible-looking sentence nobody in the
 * company can read back is worse than a visible fallback: it cannot be reviewed, it
 * cannot be corrected, and it will be believed.
 *
 * So this locale ships working and incomplete. Choosing it today gives Chinese
 * *numbers* — grouping, separators and digits all come from CLDR through
 * `Formatters` — over Thai *words*, and `LanguagePicker` says so rather than letting
 * the visitor discover it. Every entry a translator adds here takes effect with no
 * other change anywhere.
 *
 * Add entries by key. The type checks each one against that key's params, so a
 * translation that drops an interpolated value, or writes a string where the key needs
 * a function of `(params, f)`, fails to compile.
 */
export const zh: PartialUiCatalogue = {};
