/**
 * Which reading of these payloads is in force.
 *
 * `quote.ts` learned this the expensive way twice: a v1 entry held `total: 8791`
 * meaning baht and a v2 entry held `totalMinor: "879100"` meaning satang, same field
 * names, same JSON shape, different arithmetic — so `QUOTE_SCHEMA_VERSION` had to
 * travel *inside* the payload rather than only in the storage key (quote.ts:216-226).
 *
 * The same hazard exists here, but the answer is not the same. A stored payload has no
 * envelope, so its version has to be a field. An HTTP response has one, and burying a
 * version in every body would put it inside the very JSON whose reading is in question
 * — a client that misreads the body misreads the version with it. It goes in a header,
 * where a proxy, a log and a client that cannot parse the body can all still see it.
 *
 * A change that alters what a number *means* under an unchanged field name — another
 * baht-to-satang, another centimetre-to-micrometre — must bump this and must not reuse
 * the old field name.
 */
export const CONTRACT_VERSION = 1;

export const CONTRACT_VERSION_HEADER = 'x-wewin-contract-version';
