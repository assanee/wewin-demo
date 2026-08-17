-- ═════════════════════════════════════════════════════════════════════════════
-- DOES THE SERIES HAVE HOLES, AND WHICH NUMBERS ARE MISSING
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `next_document_no()` is a public function. Anything that calls it and then does not insert a
-- document — a `psql` session, a probe, a test pointed at the wrong database, a future caller
-- written by somebody who did not read 0060's header — takes a number out of the series for
-- ever. The counter row makes a ROLLED-BACK issue give its number back, which is the case it was
-- built for; it cannot help with a COMMITTED call that simply never wrote a row.
--
-- This developer's database is the proof that the case is real rather than theoretical:
--
--     series  next_seq  documents  missing
--     TAX            4          1        2      ← TAX-2569-00001 and -00002 do not exist
--     CN             3          1        1      ← CN-2569-00001 does not exist
--
-- ⛔ And `tax_documents` is append-only — `tax_documents_freeze()` refuses DELETE outright — so
-- a hole cannot be tidied away afterwards. The only remedies are to start a series clean, or to
-- be able to explain the gap. An auditor walking a numbered series and finding one missing asks
-- about it; "I do not know" is the answer nobody wants to give, and this view is what makes the
-- other answer possible.
--
-- ⚠️ A VIEW and not a report in the application, because the question is asked *of the data* and
-- often by somebody who is not holding a browser — the company's accountant, at year end, over
-- psql or a spreadsheet export. It reads nothing the application owns and grants nothing.

CREATE VIEW document_series_health AS
WITH taken AS (
  SELECT
    c.series_code,
    c.series_year,
    c.next_seq,
    /*
     * Every number handed out this year: 1 .. next_seq - 1. `next_seq` is what the NEXT caller
     * will receive, so the last one issued is one below it.
     */
    generate_series(1, GREATEST(c.next_seq - 1, 0)) AS seq
  FROM document_series_counters c
)
SELECT
  t.series_code,
  t.series_year,
  t.next_seq,
  count(d.id)                                             AS documents,
  count(d.id) FILTER (WHERE d.status = 'issued')          AS live_documents,
  count(d.id) FILTER (WHERE d.status = 'voided')          AS voided_documents,
  /*
   * ⚠️ A voided document is NOT a hole. It was issued, it has a number, it is on the series and
   * a credit note explains it. The numbers below are the ones that belong to no document at all.
   */
  array_remove(array_agg(t.seq ORDER BY t.seq) FILTER (WHERE d.id IS NULL), NULL)
                                                          AS missing_seqs,
  count(*) FILTER (WHERE d.id IS NULL)                    AS missing_count
FROM taken t
LEFT JOIN tax_documents d
  ON d.series_code = t.series_code
 AND d.series_year = t.series_year
 AND d.series_seq  = t.seq
GROUP BY t.series_code, t.series_year, t.next_seq;
--> statement-breakpoint

COMMENT ON VIEW document_series_health IS
  'Numbers handed out by next_document_no() that belong to no tax_documents row. A voided document is not a hole — it has a number and a credit note explaining it. See 0063.';
