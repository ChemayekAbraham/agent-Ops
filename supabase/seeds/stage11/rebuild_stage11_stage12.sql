-- Stage 11 / Stage 12 fresh-database reconstruction.
-- FOR A FRESH (NON-PRODUCTION) DATABASE ONLY. Run with psql from the repo root:
--   psql -v ON_ERROR_STOP=1 -f supabase/seeds/stage11/rebuild_stage11_stage12.sql
--
-- Source of truth: fin_collection_reconciliation_s11.csv in this folder, exported from the live
-- register on 2026-10-02 (659 rows, UGX 56,946,270, sha256 cbd81e992f20be285d13954aa6901eb98d3a3eed6b4c2d598af0def496d9801c).
-- The rows are a frozen investigation snapshot; they are loaded from the file, never recomputed
-- from ledger or collection data, so the result does not depend on current production state.
--
-- Writes ONLY fin_collection_reconciliation_s11 and fin_collection_evidence_s12.
-- Never touches general_ledger, wallets, rent_requests or agent_collections.
-- Idempotent: if Stage 11 already holds rows, it verifies them and changes nothing.
-- Prerequisite: the Stage 11 and Stage 12 migrations have been applied (tables + triggers exist).

BEGIN;

CREATE TEMP TABLE _s11_seed (LIKE public.fin_collection_reconciliation_s11) ON COMMIT DROP;
\copy _s11_seed FROM 'supabase/seeds/stage11/fin_collection_reconciliation_s11.csv' WITH (FORMAT csv, HEADER true)

DO $$
DECLARE n int; a numeric; live int;
BEGIN
  SELECT count(*), sum(amount) INTO n, a FROM _s11_seed;
  IF n <> 659 OR a <> 56946270 THEN
    RAISE EXCEPTION 'Seed file is not the Stage 11 population: % rows / UGX %', n, a;
  END IF;

  SELECT count(*) INTO live FROM public.fin_collection_reconciliation_s11;
  IF live > 0 THEN
    -- Already populated: verify only, never rewrite (Stage 11 is frozen).
    IF EXISTS (SELECT collection_id, amount, original_classification, reconciliation_result FROM _s11_seed
               EXCEPT SELECT collection_id, amount, original_classification, reconciliation_result FROM public.fin_collection_reconciliation_s11)
       OR live <> 659 THEN
      RAISE EXCEPTION 'Existing Stage 11 register differs from the seed file; refusing to change it';
    END IF;
    RAISE NOTICE 'Stage 11 already populated and matches the seed; nothing changed';
    RETURN;
  END IF;

  -- Fresh database: the freeze/population triggers exist to stop later edits, so they are
  -- suspended inside this transaction only, for the initial load.
  ALTER TABLE public.fin_collection_reconciliation_s11 DISABLE TRIGGER trg_s11_frozen;
  ALTER TABLE public.fin_collection_evidence_s12 DISABLE TRIGGER trg_s12_no_insert_delete;

  INSERT INTO public.fin_collection_reconciliation_s11 SELECT * FROM _s11_seed;
  INSERT INTO public.fin_collection_evidence_s12 (collection_id)
    SELECT collection_id FROM public.fin_collection_reconciliation_s11
    ON CONFLICT (collection_id) DO NOTHING;

  ALTER TABLE public.fin_collection_reconciliation_s11 ENABLE TRIGGER trg_s11_frozen;
  ALTER TABLE public.fin_collection_evidence_s12 ENABLE TRIGGER trg_s12_no_insert_delete;

  SELECT count(*), sum(s.amount) INTO n, a
    FROM public.fin_collection_evidence_s12 e JOIN public.fin_collection_reconciliation_s11 s USING (collection_id);
  IF n <> 659 OR a <> 56946270 THEN RAISE EXCEPTION 'Rebuild did not reconcile: % / UGX %', n, a; END IF;
  RAISE NOTICE 'Rebuilt Stage 11 and Stage 12: 659 collections / UGX 56,946,270';
END $$;

COMMIT;
