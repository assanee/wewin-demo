import type { PartialCatalogue } from './types';

/**
 * English — deliberately, visibly partial.
 *
 * ── What is here and what is not ─────────────────────────────────────────────────
 *
 * Only the sentences that are **code-owned prose**: the two infrastructure answers, and the
 * generic refusals each translator falls back to when a constraint has no name. Those are
 * written by whoever writes the error handling, they say nothing about aluminium, and they
 * are the same four sentences repeated across four vocabularies.
 *
 * Everything else is absent on purpose. The constraint explanations describe catalogue
 * rules, deposits and slips in a business's own vocabulary — 'ผู้ตรวจสลิปต้องไม่ใช่ผู้อัปโหลด
 * สลิปใบเดียวกัน' is a sentence about a control that exists because plan 7.7 says a human
 * reviewer is this system's only real safeguard, and getting it *nearly* right in English
 * is worse than leaving it in Thai, where the person who wrote the rule can read it.
 *
 * ── Why ship a partial catalogue at all ──────────────────────────────────────────
 *
 * Because the alternative is that the fallback path is exercised only by tests. With this
 * file in place, an `Accept-Language: en` request to a busy server gets English, an
 * `Accept-Language: en` request that trips `payment_slips_reviewer_is_not_submitter` gets
 * Thai *and* `degraded: true` in the envelope — both behaviours are live, both are
 * observable through `/meta/locales`, and neither is a promise about the other 88 keys.
 *
 * ⚠️ Adding a key here is adding a translation. It is not a formatting change and it is not
 * refactoring: every entry is a claim that somebody who speaks the language checked it.
 */
export const EN: PartialCatalogue = {
  /* Infrastructure — no domain vocabulary, identical meaning in every language. */
  'error.http.payload_too_large': 'The request body is larger than this endpoint accepts.',
  'error.http.busy': 'The service is handling a lot of requests right now. Please try again.',
  'error.internal.unexpected':
    'Something went wrong on our side. Please contact us quoting the request id below.',

  /* The four generic refusals, one per vocabulary. Same four sentences, four audiences. */
  'error.catalog.duplicate': 'This already exists.',
  'error.catalog.missing_reference': 'This refers to something that does not exist.',
  'error.order.duplicate': 'This already exists.',
  'error.order.missing_reference': 'This refers to something that does not exist.',
  'error.quote.duplicate': 'This already exists.',
  'error.quote.missing_reference': 'This refers to something that does not exist.',
  'error.money.duplicate': 'This entry already exists.',
  'error.money.missing_reference': 'This refers to something that does not exist.',
  'error.slip.duplicate': 'This already exists.',
  'error.order.document_link_unusable':
    'No quotation was found for this link — it may have expired. Please contact the sales team.',
};
