-- ═════════════════════════════════════════════════════════════════════════════
-- ⛔ `next_document_no` could not run: its own OUT columns shadowed the table's
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `RETURNS TABLE (series_code text, series_year smallint, …)` declares those names as plpgsql
-- variables. Inside the body, `ON CONFLICT (series_code, series_year)` then refers to *either*
-- the variable or the column and Postgres refuses to guess:
--
--     ERROR:  column reference "series_code" is ambiguous
--     DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- Found by calling the function once, which is the only way it could have been found: the
-- migration applies cleanly, because a plpgsql body is not parsed until it runs.
--
-- `#variable_conflict use_column` is the declaration meant for exactly this: inside this
-- function, an ambiguous name is the column. Every deliberate use of a variable here is either a
-- parameter (`p_series_code`) or a local with no column of that name (`year_be`, `seq`), so
-- nothing else changes meaning.
--
-- ⚠️ Renaming the OUT columns was the alternative and would have been worse: they are the names
-- every caller destructures, and picking `series_code_out` to work around a scoping rule puts
-- the workaround in the API rather than in the function that needs it.
-- ═════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION next_document_no(p_series_code text, p_at timestamptz)
RETURNS TABLE (series_code text, series_year smallint, series_seq integer, document_no text) AS $$
#variable_conflict use_column
DECLARE
  series  document_series%ROWTYPE;
  year_be smallint;
  seq     integer;
BEGIN
  SELECT * INTO series FROM document_series s WHERE s.series_code = p_series_code;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'document series % does not exist', p_series_code
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  year_be := extract(year from p_at at time zone 'Asia/Bangkok')::smallint
             + CASE WHEN series.year_era = 'BE' THEN 543 ELSE 0 END;

  IF NOT series.resets_yearly THEN
    year_be := 0;
  END IF;

  INSERT INTO document_series_counters (series_code, series_year, next_seq)
  VALUES (p_series_code, year_be, 1)
  ON CONFLICT (series_code, series_year) DO NOTHING;

  SELECT c.next_seq INTO seq
    FROM document_series_counters c
   WHERE c.series_code = p_series_code AND c.series_year = year_be
   FOR UPDATE;

  UPDATE document_series_counters c
     SET next_seq = seq + 1
   WHERE c.series_code = p_series_code AND c.series_year = year_be;

  RETURN QUERY SELECT
    p_series_code,
    year_be,
    seq,
    series.prefix || '-' || year_be::text || '-' || lpad(seq::text, series.pad_width, '0');
END;
$$ LANGUAGE plpgsql;
