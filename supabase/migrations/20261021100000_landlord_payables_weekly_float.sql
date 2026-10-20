-- 2026-10-21: landlord payables under the CFO's weekly-float rule (payables part 3).
--
-- Decided by the CFO (2026-10-20/21):
--   * A landlord payout is a PAYABLE once it has been PAID OUT (its withdrawal request completed, or FinOps
--     recorded a disbursement with a reference) and stays payable until a PROVIDER STATEMENT LINE confirms it:
--     the same transaction ID and amount (up to 5,000 above, for the provider fee). Approval alone, the
--     'completed' status, the agent's receipt code, a FinOps screenshot and the ledger funding entry are NOT
--     evidence. Approved but not yet paid payouts are not payables (shown as float committed).
--   * Payouts are grouped by the CFO weekly landlord float (landlord_float_budget_allocations, by rent request);
--     payouts without a weekly float (before 19 Oct 2026) are grouped by the week they were paid.
--   * A match on phone number + amount within 3 days, without a transaction ID, is only "probable": it does
--     not clear the payable. A screenshot match is shown as a label. An evidence line that matches more than
--     one payout confirms none of them.
--   * Exceptions for CFO review (a payout can carry several; 'exception' is the most serious): failed_but_paid,
--     completed_without_payout, paid_amount_differs (the withdrawal paid another amount than the payout records),
--     reference_unusable (not an 11-digit MTN or 12-digit Airtel transaction ID), shared_evidence, shared_reference (another payout has the same
--     reference). probable_match is a hint, not an exception. Exceptions never change an amount or a state.
--   * Evidence: provider statements imported by FinOps/CFO (import_provider_statement; each line carries the
--     provider's status and only successful outgoing lines count, a reversed line cancels them; immutable lines, a
--     wrong file can be voided by the CFO, never deleted) plus the existing provider e-mail feed.
--
-- REPORTING AND EVIDENCE ONLY. No ledger entry, wallet, payout, withdrawal or status is written. The ledger
-- still posts rent at CFO funding; recording a landlord payable balance in the ledger is a separate decision.
-- Requires 20261020210000_budget_payables (its v_payables_lines / v_payables_payment_history bodies are pinned).
-- The two status-based landlord branches of v_payables_lines (landlord_payouts, agent_landlord_payouts) and the
-- two ledger-based landlord branches of v_payables_payment_history are replaced; every other branch is verbatim.
-- Rollback: supabase/rollbacks/20261021100000_landlord_payables_weekly_float.rollback.sql
-- Verification (rolled back): supabase/tests/landlord_payables_weekly_float.sql

-- 0. Safety: fail fast on locks; refuse unless Part 2's definitions are exactly the ones embedded below.
SET lock_timeout = '5s';
DO $pre$
BEGIN
  IF md5(pg_get_viewdef('public.v_payables_lines'::regclass)) <> '9839b8fa221452125d384782c6444801' THEN
    RAISE EXCEPTION 'precondition failed: v_payables_lines is not the definition 20261020210000 created (md5 %); regenerate this migration', md5(pg_get_viewdef('public.v_payables_lines'::regclass));
  END IF;
  IF md5(pg_get_viewdef('public.v_payables_payment_history'::regclass)) <> '3535fea07816f4dbec42b1a259e38835' THEN
    RAISE EXCEPTION 'precondition failed: v_payables_payment_history is not the definition 20261020210000 created (md5 %); regenerate this migration', md5(pg_get_viewdef('public.v_payables_payment_history'::regclass));
  END IF;
  IF to_regclass('public.landlord_payouts') IS NULL OR to_regclass('public.withdrawal_requests') IS NULL
     OR to_regclass('public.gmail_transactions') IS NULL OR to_regclass('public.landlord_float_budget_allocations') IS NULL
     OR to_regclass('public.landlord_float_budgets') IS NULL OR to_regclass('public.payout_proof_ocr_log') IS NULL
     OR to_regclass('public.audit_logs') IS NULL
     OR to_regprocedure('public.landlord_float_week_start(date)') IS NULL OR to_regprocedure('public.payables_guard()') IS NULL
     OR to_regprocedure('public.is_financial_ops_staff(uuid)') IS NULL OR to_regprocedure('public.has_role(uuid,app_role)') IS NULL
     OR to_regprocedure('public.is_cfo_approver(uuid)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = 'withdrawal_requests' AND column_name = 'landlord_payout_id') THEN
    RAISE EXCEPTION 'precondition failed: a table, column or function this migration depends on is missing';
  END IF;
END
$pre$;

-- 1. Provider evidence store. Lines are immutable; a wrong import is voided (with its lines), never deleted.
CREATE TABLE IF NOT EXISTS public.provider_statement_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('mtn_momo', 'airtel_money', 'bank')),
  account_ref     text NOT NULL CHECK (length(btrim(account_ref)) > 0),
  file_name       text,
  file_sha256     text NOT NULL UNIQUE CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  period_from     date,
  period_to       date,
  line_count      integer NOT NULL DEFAULT 0,
  inserted_count  integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  rejected_count  integer NOT NULL DEFAULT 0,
  not_successful_count integer NOT NULL DEFAULT 0,
  notes           text,
  imported_by     uuid NOT NULL,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid,
  void_reason     text
);

CREATE TABLE IF NOT EXISTS public.provider_statement_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id         uuid NOT NULL REFERENCES public.provider_statement_imports(id),
  channel           text NOT NULL,
  account_ref       text NOT NULL,
  direction         text NOT NULL CHECK (direction IN ('out', 'in')),
  -- Only 'successful' lines are evidence. Failed/pending lines are kept as record; a 'reversed' line cancels
  -- the evidence of the same transaction ID.
  status            text NOT NULL CHECK (status IN ('successful', 'failed', 'reversed', 'pending')),
  transaction_id    text NOT NULL CHECK (length(regexp_replace(transaction_id, '[^0-9]', '', 'g')) >= 6),
  tid_normalized    text GENERATED ALWAYS AS (regexp_replace(transaction_id, '[^0-9]', '', 'g')) STORED,
  amount            numeric NOT NULL CHECK (amount > 0),
  fee               numeric,
  counterparty      text,
  counterparty_name text,
  counterparty9     text GENERATED ALWAYS AS (right(regexp_replace(COALESCE(counterparty, ''), '[^0-9]', '', 'g'), 9)) STORED,
  tx_at             timestamptz NOT NULL,
  raw               jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  voided_at         timestamptz
);
-- One live line per provider transaction and status (a voided import's lines can be imported again from the
-- right file; a reversal of a transaction is its own line).
CREATE UNIQUE INDEX IF NOT EXISTS provider_statement_lines_live_tid_uq
  ON public.provider_statement_lines (channel, direction, tid_normalized, status) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS provider_statement_lines_tid_idx ON public.provider_statement_lines (tid_normalized);
CREATE INDEX IF NOT EXISTS provider_statement_lines_cp9_idx ON public.provider_statement_lines (counterparty9);
CREATE INDEX IF NOT EXISTS provider_statement_lines_import_idx ON public.provider_statement_lines (import_id);

CREATE OR REPLACE FUNCTION public.trg_provider_statement_lines_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Provider statement lines are evidence and cannot be deleted; void the import instead.' USING ERRCODE = 'check_violation';
  END IF;
  -- The only permitted change: voiding (voided_at NULL -> a timestamp), everything else stays as imported.
  -- (Generated columns are not yet computed in NEW inside a BEFORE trigger; they derive from compared columns.)
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
     AND (to_jsonb(NEW) - 'voided_at' - 'tid_normalized' - 'counterparty9')
       = (to_jsonb(OLD) - 'voided_at' - 'tid_normalized' - 'counterparty9') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Provider statement lines are evidence and cannot be changed; void the import instead.' USING ERRCODE = 'check_violation';
END;
$$;
DROP TRIGGER IF EXISTS trg_provider_statement_lines_immutable ON public.provider_statement_lines;
CREATE TRIGGER trg_provider_statement_lines_immutable
  BEFORE UPDATE OR DELETE ON public.provider_statement_lines
  FOR EACH ROW EXECUTE FUNCTION public.trg_provider_statement_lines_immutable();

ALTER TABLE public.provider_statement_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_statement_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_statement_imports, public.provider_statement_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.provider_statement_imports, public.provider_statement_lines TO service_role;

-- 2. Import (FinOps or CFO). Idempotent per file (SHA-256); a transaction already on file is skipped, not
--    duplicated. Bad lines are rejected and reported, the rest are kept. Writes evidence only.
CREATE OR REPLACE FUNCTION public.import_provider_statement(
  p_channel text, p_account_ref text, p_file_name text, p_file_sha256 text, p_lines jsonb,
  p_period_from date DEFAULT NULL, p_period_to date DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_sha text := lower(btrim(COALESCE(p_file_sha256, '')));
  v_imp public.provider_statement_imports%ROWTYPE;
  v_line jsonb;
  v_idx int := 0;
  v_tid text; v_dir text; v_status text; v_amt numeric; v_fee numeric; v_at timestamptz;
  v_n int;
  v_ins int := 0; v_dup int := 0; v_notok int := 0;
  v_rej jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT (public.is_financial_ops_staff(v_uid) OR public.has_role(v_uid, 'financial_ops')) THEN
    RAISE EXCEPTION 'Only Financial Operations or the CFO can import provider statements' USING ERRCODE = '42501';
  END IF;
  IF p_channel IS NULL OR p_channel NOT IN ('mtn_momo', 'airtel_money', 'bank') THEN
    RAISE EXCEPTION 'Channel must be mtn_momo, airtel_money or bank';
  END IF;
  IF NULLIF(btrim(COALESCE(p_account_ref, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Name the account this statement belongs to';
  END IF;
  IF v_sha !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'The file fingerprint (SHA-256) is missing or malformed';
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'The statement has no lines';
  END IF;
  IF jsonb_array_length(p_lines) > 20000 THEN
    RAISE EXCEPTION 'A statement may carry at most 20,000 lines; split the period';
  END IF;

  SELECT * INTO v_imp FROM public.provider_statement_imports WHERE file_sha256 = v_sha;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'already_imported', true, 'import_id', v_imp.id, 'voided', v_imp.voided_at IS NOT NULL,
                              'lines', v_imp.line_count, 'inserted', v_imp.inserted_count, 'not_successful', v_imp.not_successful_count,
                              'duplicates', v_imp.duplicate_count, 'rejected', v_imp.rejected_count);
  END IF;

  INSERT INTO public.provider_statement_imports (channel, account_ref, file_name, file_sha256, period_from, period_to, notes, imported_by)
  VALUES (p_channel, btrim(p_account_ref), NULLIF(btrim(COALESCE(p_file_name, '')), ''), v_sha, p_period_from, p_period_to,
          NULLIF(btrim(COALESCE(p_notes, '')), ''), v_uid)
  RETURNING * INTO v_imp;

  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    v_idx := v_idx + 1;
    v_tid := btrim(COALESCE(v_line->>'transaction_id', ''));
    v_dir := lower(btrim(COALESCE(v_line->>'direction', '')));
    IF v_dir NOT IN ('out', 'in') THEN
      v_rej := v_rej || jsonb_build_object('line', v_idx, 'reason', 'direction must be out or in'); CONTINUE;
    END IF;
    IF length(regexp_replace(v_tid, '[^0-9]', '', 'g')) < 6 THEN
      v_rej := v_rej || jsonb_build_object('line', v_idx, 'reason', 'transaction ID missing or too short'); CONTINUE;
    END IF;
    -- The provider's own status wording, mapped; anything unrecognised is rejected rather than guessed.
    v_status := CASE lower(btrim(COALESCE(v_line->>'status', '')))
                  WHEN 'successful' THEN 'successful' WHEN 'success' THEN 'successful' WHEN 'succeeded' THEN 'successful'
                  WHEN 'completed' THEN 'successful' WHEN 'complete' THEN 'successful'
                  WHEN 'failed' THEN 'failed' WHEN 'failure' THEN 'failed' WHEN 'declined' THEN 'failed' WHEN 'rejected' THEN 'failed'
                  WHEN 'reversed' THEN 'reversed' WHEN 'reversal' THEN 'reversed' WHEN 'refunded' THEN 'reversed'
                  WHEN 'pending' THEN 'pending' WHEN 'processing' THEN 'pending' WHEN 'initiated' THEN 'pending'
                END;
    IF v_status IS NULL THEN
      v_rej := v_rej || jsonb_build_object('line', v_idx, 'reason',
                 CASE WHEN NULLIF(btrim(COALESCE(v_line->>'status', '')), '') IS NULL THEN 'status missing'
                      ELSE 'status not recognised: ' || left(v_line->>'status', 40) END); CONTINUE;
    END IF;
    BEGIN
      v_amt := (v_line->>'amount')::numeric;
      v_fee := NULLIF(v_line->>'fee', '')::numeric;
      v_at := (v_line->>'tx_at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      v_rej := v_rej || jsonb_build_object('line', v_idx, 'reason', 'unreadable amount, fee or date'); CONTINUE;
    END;
    IF v_amt IS NULL OR v_amt <= 0 THEN
      v_rej := v_rej || jsonb_build_object('line', v_idx, 'reason', 'amount must be above zero'); CONTINUE;
    END IF;
    IF v_at IS NULL THEN
      v_rej := v_rej || jsonb_build_object('line', v_idx, 'reason', 'date missing'); CONTINUE;
    END IF;
    INSERT INTO public.provider_statement_lines (import_id, channel, account_ref, direction, status, transaction_id, amount, fee,
                                                 counterparty, counterparty_name, tx_at, raw)
    VALUES (v_imp.id, p_channel, btrim(p_account_ref), v_dir, v_status, v_tid, v_amt, v_fee,
            NULLIF(btrim(COALESCE(v_line->>'counterparty', '')), ''), NULLIF(btrim(COALESCE(v_line->>'counterparty_name', '')), ''),
            v_at, v_line)
    ON CONFLICT (channel, direction, tid_normalized, status) WHERE voided_at IS NULL DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n = 1 THEN
      v_ins := v_ins + 1;
      IF v_status <> 'successful' THEN v_notok := v_notok + 1; END IF;
    ELSE
      v_dup := v_dup + 1;
    END IF;
  END LOOP;

  UPDATE public.provider_statement_imports
     SET line_count = v_idx, inserted_count = v_ins, duplicate_count = v_dup, rejected_count = jsonb_array_length(v_rej),
         not_successful_count = v_notok
   WHERE id = v_imp.id;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_uid, 'provider_statement_imported', 'provider_statement_imports', v_imp.id::text,
          jsonb_build_object('channel', p_channel, 'account_ref', btrim(p_account_ref), 'file_sha256', v_sha,
                             'lines', v_idx, 'inserted', v_ins, 'not_successful', v_notok, 'duplicates', v_dup,
                             'rejected', jsonb_array_length(v_rej)));
  RETURN jsonb_build_object('ok', true, 'already_imported', false, 'import_id', v_imp.id, 'lines', v_idx,
                            'inserted', v_ins, 'not_successful', v_notok, 'duplicates', v_dup, 'rejected', jsonb_array_length(v_rej),
                            'rejected_lines', (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (SELECT x FROM jsonb_array_elements(v_rej) x LIMIT 200) s));
END;
$$;

-- 3. Void a wrong import (CFO only). Its lines stop counting as evidence; nothing is deleted.
CREATE OR REPLACE FUNCTION public.void_provider_statement_import(p_import_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_imp public.provider_statement_imports%ROWTYPE;
  v_n int;
BEGIN
  IF v_uid IS NULL OR NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the CFO can void a provider statement import' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters';
  END IF;
  SELECT * INTO v_imp FROM public.provider_statement_imports WHERE id = p_import_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Import not found'; END IF;
  IF v_imp.voided_at IS NOT NULL THEN RAISE EXCEPTION 'This import is already void'; END IF;
  UPDATE public.provider_statement_imports SET voided_at = now(), voided_by = v_uid, void_reason = btrim(p_reason) WHERE id = p_import_id;
  UPDATE public.provider_statement_lines SET voided_at = now() WHERE import_id = p_import_id AND voided_at IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  VALUES (v_uid, 'provider_statement_voided', 'provider_statement_imports', p_import_id::text,
          jsonb_build_object('reason', btrim(p_reason), 'lines_voided', v_n));
  RETURN jsonb_build_object('ok', true, 'import_id', p_import_id, 'lines_voided', v_n);
END;
$$;

-- 4. One row per landlord payout: paid out?, which weekly float, provider confirmation, labels, exceptions.
CREATE OR REPLACE VIEW public.v_landlord_payout_settlement AS
WITH wr AS (                     -- the completed withdrawal that paid the landlord (the route since July 2026)
  SELECT DISTINCT ON (w.landlord_payout_id)
         w.landlord_payout_id, w.id AS withdrawal_id, w.processed_at, w.amount AS paid_amount,
         NULLIF(regexp_replace(COALESCE(NULLIF(w.transaction_id, ''), w.fin_ops_reference, ''), '[^0-9]', '', 'g'), '') AS ref
    FROM public.withdrawal_requests w
   WHERE w.landlord_payout_id IS NOT NULL AND w.status = 'completed'
   ORDER BY w.landlord_payout_id, w.processed_at DESC NULLS LAST
),
alloc AS (                       -- the CFO weekly landlord float that approved the rent request
  SELECT DISTINCT ON (a.rent_request_id) a.rent_request_id, a.week_start, a.weekly_budget_id, a.kind
    FROM public.landlord_float_budget_allocations a
   WHERE a.released_at IS NULL AND a.rent_request_id IS NOT NULL
   ORDER BY a.rent_request_id, a.approved_at DESC NULLS LAST
),
base AS (
  SELECT lp.id AS payout_id, lp.rent_request_id, lp.landlord_id,
         COALESCE(NULLIF(lp.landlord_name, ''), pr.full_name) AS landlord_name,
         lp.landlord_phone, lp.mobile_money_provider, lp.amount, lp.status AS payout_status, lp.created_at,
         wr.withdrawal_id, wr.ref AS ref_withdrawal, wr.paid_amount,
         NULLIF(regexp_replace(COALESCE(lp.finops_momo_reference, ''), '[^0-9]', '', 'g'), '') AS ref_finops,
         right(regexp_replace(COALESCE(lp.landlord_phone, ''), '[^0-9]', '', 'g'), 9) AS phone9,
         (wr.withdrawal_id IS NOT NULL
          OR (NULLIF(regexp_replace(COALESCE(lp.finops_momo_reference, ''), '[^0-9]', '', 'g'), '') IS NOT NULL
              AND lp.finops_disbursed_at IS NOT NULL)) AS paid_out,
         COALESCE(wr.processed_at, lp.finops_disbursed_at) AS paid_at,
         al.week_start AS float_week_start, al.weekly_budget_id, al.kind AS allocation_kind
    FROM public.landlord_payouts lp
    LEFT JOIN wr ON wr.landlord_payout_id = lp.id
    LEFT JOIN alloc al ON al.rent_request_id = lp.rent_request_id
    LEFT JOIN public.profiles pr ON pr.id = lp.landlord_id
),
ev AS (                          -- provider evidence: imported statement lines (not voided) and provider e-mails
  SELECT 'statement'::text AS source, l.id AS source_id, l.tid_normalized AS tid, l.amount, l.counterparty9 AS cp9, l.tx_at
    FROM public.provider_statement_lines l
   WHERE l.direction = 'out' AND l.voided_at IS NULL AND l.status = 'successful'
     AND NOT EXISTS (SELECT 1 FROM public.provider_statement_lines r      -- a reversal cancels the evidence
                      WHERE r.voided_at IS NULL AND r.status = 'reversed'
                        AND r.channel = l.channel AND r.tid_normalized = l.tid_normalized)
  UNION ALL
  SELECT 'provider_email'::text, g.id, regexp_replace(COALESCE(g.transaction_id, ''), '[^0-9]', '', 'g'), g.amount,
         right(regexp_replace(COALESCE(g.counterparty, ''), '[^0-9]', '', 'g'), 9),
         COALESCE(g.tx_date::timestamp AT TIME ZONE 'Africa/Kampala', g.internal_date)
    FROM public.gmail_transactions g
   WHERE g.direction = 'out' AND g.amount > 0
),
refs AS (                        -- each paid-out payout's provider reference(s)
  SELECT payout_id, amount, ref_withdrawal AS ref FROM base WHERE paid_out AND ref_withdrawal IS NOT NULL
  UNION
  SELECT payout_id, amount, ref_finops FROM base WHERE paid_out AND ref_finops IS NOT NULL
),
tid_match AS (                   -- same transaction ID and amount (up to 5,000 above, for the provider fee)
  SELECT r.payout_id, e.source, e.source_id, e.tx_at,
         count(*) OVER (PARTITION BY e.source, e.source_id) AS payouts_on_line
    FROM refs r
    JOIN ev e ON e.tid = r.ref AND length(e.tid) >= 6
   WHERE e.amount BETWEEN r.amount AND r.amount + 5000
),
confirmed AS (                   -- an evidence line that matches more than one payout confirms none of them
  SELECT DISTINCT ON (t.payout_id) t.payout_id, t.source, t.source_id, t.tx_at
    FROM tid_match t WHERE t.payouts_on_line = 1
   ORDER BY t.payout_id, (t.source = 'statement') DESC, t.tx_at
),
shared AS (SELECT DISTINCT t.payout_id FROM tid_match t WHERE t.payouts_on_line > 1),
phone_match AS (                 -- same number and amount within 3 days, but no transaction ID: probable only
  SELECT DISTINCT ON (b.payout_id) b.payout_id, e.source_id
    FROM base b
    JOIN ev e ON e.cp9 = b.phone9 AND length(b.phone9) = 9
   WHERE b.paid_out AND e.amount BETWEEN b.amount AND b.amount + 5000
     AND abs((e.tx_at AT TIME ZONE 'Africa/Kampala')::date - (b.paid_at AT TIME ZONE 'Africa/Kampala')::date) <= 3
   ORDER BY b.payout_id, abs(extract(epoch FROM e.tx_at - b.paid_at))
),
shot AS (                        -- FinOps screenshot check (Welile-side capture: a label, never evidence)
  SELECT DISTINCT ON (o.withdrawal_request_id) o.withdrawal_request_id, o.validation_result
    FROM public.payout_proof_ocr_log o
   ORDER BY o.withdrawal_request_id, o.created_at DESC
),
ref_use AS (                     -- how many payouts carry the same provider reference
  SELECT COALESCE(ref_withdrawal, ref_finops) AS ref, count(*) AS payouts
    FROM base WHERE COALESCE(ref_withdrawal, ref_finops) IS NOT NULL
   GROUP BY 1
),
fin AS (
SELECT b.payout_id, b.rent_request_id, b.landlord_id, b.landlord_name, b.landlord_phone, b.mobile_money_provider,
       b.amount, b.payout_status, b.created_at, b.withdrawal_id,
       COALESCE(b.ref_withdrawal, b.ref_finops) AS payout_reference,
       b.paid_out, b.paid_at,
       (b.float_week_start IS NOT NULL) AS has_weekly_float,
       b.float_week_start, b.weekly_budget_id, b.allocation_kind,
       COALESCE(b.float_week_start,
                public.landlord_float_week_start((COALESCE(b.paid_at, b.created_at) AT TIME ZONE 'Africa/Kampala')::date)) AS report_week_start,
       c.payout_id IS NOT NULL AS provider_confirmed,
       c.tx_at AS confirmed_at, c.source AS evidence_source, c.source_id AS evidence_id,
       pm.source_id AS probable_evidence_id,
       sh.validation_result AS screenshot_result,
       CASE WHEN b.paid_out AND c.payout_id IS NOT NULL THEN 'confirmed'
            WHEN b.paid_out THEN 'paid_unconfirmed'
            WHEN b.payout_status = 'failed' THEN 'failed'
            ELSE 'not_paid' END AS state,
       b.paid_amount,
       -- Every exception that applies, most serious first; 'exception' (below) is the first one.
       --   paid_amount_differs  the completed withdrawal paid a different amount than the payout records
       --   reference_unusable   paid out, unconfirmed, and its reference is not an MTN (11-digit) or Airtel (12-digit)
       --                        transaction ID, so it can never match a provider line exactly
       --   shared_reference     paid out, unconfirmed, and another payout carries the same reference
       array_remove(ARRAY[
         CASE WHEN b.paid_out AND b.payout_status = 'failed' THEN 'failed_but_paid' END,
         CASE WHEN NOT b.paid_out AND b.payout_status = 'completed' THEN 'completed_without_payout' END,
         CASE WHEN b.paid_out AND b.paid_amount IS NOT NULL AND b.paid_amount <> b.amount THEN 'paid_amount_differs' END,
         CASE WHEN b.paid_out AND c.payout_id IS NULL
               AND length(COALESCE(b.ref_withdrawal, b.ref_finops, '')) NOT IN (11, 12) THEN 'reference_unusable' END,
         CASE WHEN b.paid_out AND c.payout_id IS NULL AND s.payout_id IS NOT NULL THEN 'shared_evidence' END,
         CASE WHEN b.paid_out AND c.payout_id IS NULL AND ru.payouts > 1 THEN 'shared_reference' END,
         CASE WHEN b.paid_out AND c.payout_id IS NULL AND pm.payout_id IS NOT NULL THEN 'probable_match' END
       ]::text[], NULL) AS exceptions
  FROM base b
  LEFT JOIN confirmed c ON c.payout_id = b.payout_id
  LEFT JOIN shared s ON s.payout_id = b.payout_id
  LEFT JOIN phone_match pm ON pm.payout_id = b.payout_id
  LEFT JOIN shot sh ON sh.withdrawal_request_id = b.withdrawal_id
  LEFT JOIN ref_use ru ON ru.ref = COALESCE(b.ref_withdrawal, b.ref_finops)
)
SELECT fin.*, fin.exceptions[1] AS exception FROM fin;

-- 5. The payables list: every non-landlord branch verbatim (incl. Part 2's budget branch); the two
--    status-based landlord branches become one rule-based branch.
CREATE OR REPLACE VIEW public.v_payables_lines AS
SELECT 'user'::text AS category_key,
    'User Wallets & Withdrawals'::text AS category_label,
    'withdrawal_request'::text AS product_key,
    'Withdrawal Requests In Flight'::text AS product_label,
    'withdrawal_requests'::text AS source_table,
    w.id AS item_id,
    w.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown user'::text) AS counterparty_name,
    GREATEST(COALESCE(w.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (w.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    w.status,
    w.created_at
   FROM withdrawal_requests w
     LEFT JOIN profiles p ON p.id = w.user_id
  WHERE (w.status = ANY (ARRAY['pending'::text, 'approved'::text, 'processing'::text, 're_approved_for_recovery'::text])) AND COALESCE(w.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'user'::text AS category_key,
    'User Wallets & Withdrawals'::text AS category_label,
    'wallet_balance'::text AS product_key,
    'Withdrawable Wallet Balances'::text AS product_label,
    'wallets'::text AS source_table,
    wl.id AS item_id,
    wl.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown user'::text) AS counterparty_name,
    GREATEST(COALESCE(wl.withdrawable_balance, 0::numeric), 0::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    0::numeric AS daily_amount,
    'available'::text AS status,
    wl.created_at
   FROM wallets wl
     LEFT JOIN profiles p ON p.id = wl.user_id
  WHERE COALESCE(wl.withdrawable_balance, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Supporter Returns & Capital'::text AS category_label,
    'supporter_returns'::text AS product_key,
    'Supporter Returns Due'::text AS product_label,
    'investor_portfolios'::text AS source_table,
    ip.id AS item_id,
    ip.investor_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown supporter'::text) AS counterparty_name,
    GREATEST(round(COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric) / 100.0, 2), 0::numeric) AS outstanding_amount,
    ip.next_roi_date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    ip.status,
    ip.created_at
   FROM investor_portfolios ip
     LEFT JOIN profiles p ON p.id = ip.investor_id
  WHERE ip.status = 'active'::text AND ip.next_roi_date IS NOT NULL AND (COALESCE(ip.investment_amount, 0::numeric) * COALESCE(ip.roi_percentage, 0::numeric)) > 0::numeric
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Rent Payouts'::text AS category_label,
    'landlord_payout'::text AS product_key,
    'Landlord Payouts — paid out, receipt not yet provider-confirmed'::text AS product_label,
    'landlord_payouts'::text AS source_table,
    s.payout_id AS item_id,
    s.landlord_id AS counterparty_id,
    COALESCE(NULLIF(s.landlord_name, ''::text), 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(s.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (s.paid_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    COALESCE(s.exception, 'paid_unconfirmed'::text) AS status,
    s.created_at
   FROM public.v_landlord_payout_settlement s
  -- Paid out and not yet confirmed by a provider statement line: the CFO's landlord payable rule.
  WHERE s.state = 'paid_unconfirmed'::text AND COALESCE(s.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Payables'::text AS category_label,
    'agent_commission_payout'::text AS product_key,
    'Agent Commission Payouts'::text AS product_label,
    'agent_commission_payouts'::text AS source_table,
    cp.id AS item_id,
    cp.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(cp.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (cp.requested_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    cp.status,
    cp.created_at
   FROM agent_commission_payouts cp
     LEFT JOIN profiles p ON p.id = cp.agent_id
  WHERE (cp.status = ANY (ARRAY['pending'::text, 'approved'::text])) AND COALESCE(cp.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Payables'::text AS category_label,
    'agent_float_withdrawal'::text AS product_key,
    'Agent Float Withdrawals In Flight'::text AS product_label,
    'agent_float_withdrawals'::text AS source_table,
    fw.id AS item_id,
    fw.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(fw.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (fw.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    fw.status,
    fw.created_at
   FROM agent_float_withdrawals fw
     LEFT JOIN profiles p ON p.id = fw.agent_id
  WHERE (fw.status = ANY (ARRAY['pending'::text, 'agent_ops_approved'::text, 'manager_approved'::text, 'processing'::text])) AND COALESCE(fw.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'staff'::text AS category_key,
    'Payroll & Staff'::text AS category_label,
    'payroll_disbursement'::text AS product_key,
    'Payroll Disbursements Pending'::text AS product_label,
    'hr_pay_disbursements'::text AS source_table,
    d.id AS item_id,
    d.user_id AS counterparty_id,
    COALESCE(p.full_name, 'Staff member'::text) AS counterparty_name,
    GREATEST(COALESCE(d.amount, 0::numeric), 0::numeric) AS outstanding_amount,
    (d.created_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    d.status,
    d.created_at
   FROM hr_pay_disbursements d
     LEFT JOIN profiles p ON p.id = d.user_id
  WHERE (COALESCE(d.status, ''::text) <> ALL (ARRAY['posted'::text, 'cancelled'::text, 'reversed'::text])) AND COALESCE(d.amount, 0::numeric) > 0::numeric
UNION ALL
 SELECT 'budget'::text AS category_key,
    'Departmental Budgets'::text AS category_label,
    CASE WHEN b.overspent THEN 'department_budget_overspent'::text ELSE 'department_budget'::text END AS product_key,
    CASE WHEN b.overspent THEN 'Departmental Budgets — overspent (credited above budget)'::text
         ELSE 'Departmental Weekly Budgets'::text END AS product_label,
    'budget_submission_lines'::text AS source_table,
    b.line_id AS item_id,
    b.department_id AS counterparty_id,
    COALESCE(b.department_name, 'Unknown department'::text) AS counterparty_name,
    b.outstanding_amount,
    b.period_end AS due_date,
    'scheduled'::text AS due_kind,
    0::numeric AS daily_amount,
    CASE WHEN b.overspent THEN 'overspent'::text
         WHEN b.unproven_credit_amount > 0::numeric THEN 'credit_unproven'::text
         ELSE b.submission_status END AS status,
    b.line_created_at AS created_at
   FROM public.v_budget_payables_lines b
  -- B3: an overspent line stays on the report (amount 0, its own product and status) instead of vanishing.
  WHERE b.outstanding_amount > 0::numeric OR b.overspent;

-- 6. Paid history: landlord payments are dated by the provider statement line, not by CFO funding.
CREATE OR REPLACE VIEW public.v_payables_payment_history AS
SELECT 'user'::text AS category_key,
    'withdrawal_request'::text AS product_key,
    (COALESCE(w.processed_at, w.updated_at) AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(w.amount, 0::numeric) AS amount
   FROM withdrawal_requests w
  WHERE (w.status = ANY (ARRAY['completed'::text, 'paid'::text])) AND COALESCE(w.processed_at, w.updated_at) IS NOT NULL
UNION ALL
 SELECT 'partner'::text AS category_key,
    'supporter_returns'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'roi_expense'::text
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'landlord_payout'::text AS product_key,
    (s.confirmed_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(s.amount, 0::numeric) AS amount
   FROM public.v_landlord_payout_settlement s
  -- Paid = confirmed by the provider, dated by the provider's statement line (not by CFO funding).
  WHERE s.state = 'confirmed'::text
UNION ALL
 SELECT 'agent'::text AS category_key,
    'agent_commission_payout'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'agent_commission_payable'::text
UNION ALL
 SELECT 'staff'::text AS category_key,
    'payroll_disbursement'::text AS product_key,
    (g.transaction_date AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(g.amount, 0::numeric) AS amount
   FROM general_ledger g
  WHERE g.direction = 'cash_out'::text AND g.ledger_scope = 'platform'::text AND g.category = 'salary_payout'::text
UNION ALL
 SELECT 'budget'::text AS category_key,
    'department_budget'::text AS product_key,
    (w.credited_at AT TIME ZONE 'Africa/Nairobi'::text)::date AS d,
    COALESCE(w.amount, 0::numeric) AS amount
   FROM public.requisition_wallet_credits w
  WHERE w.status = 'credited'::text AND w.credited_at IS NOT NULL
    -- B1: only credits the wallet ledger proves count as paid
    AND NULLIF(w.wallet_transaction_id, ''::text) IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.general_ledger g
                 WHERE g.reference_id = w.wallet_transaction_id AND g.ledger_scope = 'wallet'::text
                   AND g.direction = 'cash_in'::text AND g.user_id = w.user_id AND abs(g.amount - w.amount) < 1::numeric)
    AND EXISTS (SELECT 1 FROM public.v_budget_payables_lines b
                 WHERE b.line_id = CASE w.source_table
                   WHEN 'staff_requisitions'    THEN (SELECT s.budget_line_id FROM public.staff_requisitions s    WHERE s.id = w.requisition_id)
                   WHEN 'employee_requisitions' THEN (SELECT e.budget_line_id FROM public.employee_requisitions e WHERE e.id = w.requisition_id)
                   WHEN 'director_requisitions' THEN (SELECT d.budget_line_id FROM public.director_requisitions d WHERE d.id = w.requisition_id)
                 END);

-- 7. The CFO weekly view (and, with p_week_start, that week's payouts).
CREATE OR REPLACE FUNCTION public.get_landlord_payables_by_week(p_week_start date DEFAULT NULL, p_weekly_float boolean DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v jsonb;
BEGIN
  PERFORM public.payables_guard();
  WITH s0 AS MATERIALIZED (SELECT * FROM public.v_landlord_payout_settlement),
  al AS (
    SELECT a.week_start, sum(a.amount) AS allocated, count(*) AS allocated_count,
           COALESCE(sum(a.amount) FILTER (WHERE NOT EXISTS (SELECT 1 FROM s0 s WHERE s.rent_request_id = a.rent_request_id AND s.paid_out)), 0) AS approved_not_paid,
           count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM s0 s WHERE s.rent_request_id = a.rent_request_id AND s.paid_out)) AS approved_not_paid_count
      FROM public.landlord_float_budget_allocations a
     WHERE a.released_at IS NULL
     GROUP BY a.week_start),
  fl AS (
    SELECT DISTINCT ON (b.period_start) b.period_start, b.amount
      FROM public.landlord_float_budgets b
     WHERE b.period_type = 'weekly' AND b.superseded_at IS NULL
     ORDER BY b.period_start, b.created_at DESC),
  pw AS (
    SELECT s.report_week_start AS week_start, s.has_weekly_float,
           COALESCE(sum(s.amount) FILTER (WHERE s.paid_out), 0)                  AS paid_out,
           count(*) FILTER (WHERE s.paid_out)                                    AS paid_out_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.state = 'confirmed'), 0)        AS confirmed,
           count(*) FILTER (WHERE s.state = 'confirmed')                          AS confirmed_count,
           COALESCE(sum(s.amount) FILTER (WHERE s.state = 'paid_unconfirmed'), 0) AS payable,
           count(*) FILTER (WHERE s.state = 'paid_unconfirmed')                   AS payable_count,
           count(*) FILTER (WHERE s.state = 'paid_unconfirmed' AND 'probable_match' = ANY (s.exceptions)) AS probable_count,
           count(*) FILTER (WHERE s.state = 'paid_unconfirmed' AND s.screenshot_result = 'match') AS screenshot_matched_count
      FROM s0 s
     WHERE s.paid_out
     GROUP BY 1, 2),
  wk AS (
    SELECT week_start, true AS has_weekly_float FROM al
    UNION SELECT period_start, true FROM fl
    UNION SELECT week_start, has_weekly_float FROM pw),
  rows AS (
    SELECT w.week_start, w.has_weekly_float,
           CASE WHEN w.has_weekly_float THEN f.amount END AS float_set,
           CASE WHEN w.has_weekly_float THEN COALESCE(a.allocated, 0) END AS approved,
           CASE WHEN w.has_weekly_float THEN COALESCE(a.approved_not_paid, 0) END AS approved_not_paid,
           CASE WHEN w.has_weekly_float THEN COALESCE(a.approved_not_paid_count, 0) END AS approved_not_paid_count,
           COALESCE(p.paid_out, 0) AS paid_out, COALESCE(p.paid_out_count, 0) AS paid_out_count,
           COALESCE(p.confirmed, 0) AS confirmed, COALESCE(p.confirmed_count, 0) AS confirmed_count,
           COALESCE(p.payable, 0) AS payable, COALESCE(p.payable_count, 0) AS payable_count,
           COALESCE(p.probable_count, 0) AS probable_count, COALESCE(p.screenshot_matched_count, 0) AS screenshot_matched_count
      FROM wk w
      LEFT JOIN al a ON w.has_weekly_float AND a.week_start = w.week_start
      LEFT JOIN fl f ON w.has_weekly_float AND f.period_start = w.week_start
      LEFT JOIN pw p ON p.week_start = w.week_start AND p.has_weekly_float = w.has_weekly_float)
  SELECT jsonb_build_object(
    'as_at', now(),
    'rule', 'A landlord payout is payable once it has been paid out, until a provider statement line confirms it (same transaction ID and amount). Grouped by the CFO weekly landlord float; payouts without a weekly float are grouped by the week they were paid.',
    'totals', (SELECT jsonb_build_object(
        'payable', COALESCE(sum(amount) FILTER (WHERE state = 'paid_unconfirmed'), 0),
        'payable_count', count(*) FILTER (WHERE state = 'paid_unconfirmed'),
        'payable_with_weekly_float', COALESCE(sum(amount) FILTER (WHERE state = 'paid_unconfirmed' AND has_weekly_float), 0),
        'payable_without_weekly_float', COALESCE(sum(amount) FILTER (WHERE state = 'paid_unconfirmed' AND NOT has_weekly_float), 0),
        'confirmed', COALESCE(sum(amount) FILTER (WHERE state = 'confirmed'), 0),
        'confirmed_count', count(*) FILTER (WHERE state = 'confirmed'),
        'approved_not_paid', (SELECT COALESCE(sum(approved_not_paid), 0) FROM al),
        'probable_count', count(*) FILTER (WHERE state = 'paid_unconfirmed' AND 'probable_match' = ANY (exceptions)),
        'screenshot_matched_count', count(*) FILTER (WHERE state = 'paid_unconfirmed' AND screenshot_result = 'match'),
        'exception_count', count(*) FILTER (WHERE exceptions && ARRAY['failed_but_paid', 'completed_without_payout', 'paid_amount_differs', 'reference_unusable', 'shared_evidence', 'shared_reference']::text[]),
        'exception_amount', COALESCE(sum(amount) FILTER (WHERE exceptions && ARRAY['failed_but_paid', 'completed_without_payout', 'paid_amount_differs', 'reference_unusable', 'shared_evidence', 'shared_reference']::text[]), 0))
      FROM s0),
    'by_week', (SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY r.week_start DESC, r.has_weekly_float DESC), '[]'::jsonb) FROM rows r),
    'exceptions', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'payout_id', s.payout_id, 'landlord', s.landlord_name, 'amount', s.amount, 'paid_at', s.paid_at,
          'payout_status', s.payout_status, 'exception', s.exception, 'exceptions', to_jsonb(s.exceptions),
          'state', s.state, 'paid_amount', s.paid_amount, 'payout_reference', s.payout_reference)
          ORDER BY s.paid_at DESC NULLS LAST), '[]'::jsonb)
        FROM s0 s WHERE s.exceptions && ARRAY['failed_but_paid', 'completed_without_payout', 'paid_amount_differs', 'reference_unusable', 'shared_evidence', 'shared_reference']::text[]),
    'evidence', jsonb_build_object(
        'statement_imports', (SELECT count(*) FROM public.provider_statement_imports WHERE voided_at IS NULL),
        'last_statement_line_at', (SELECT max(tx_at) FROM public.provider_statement_lines WHERE voided_at IS NULL),
        'last_provider_email_out', (SELECT max(COALESCE(tx_date, internal_date::date)) FROM public.gmail_transactions WHERE direction = 'out')),
    'lines', CASE WHEN p_week_start IS NULL THEN NULL ELSE
        (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY s.paid_at DESC NULLS LAST), '[]'::jsonb)
           FROM s0 s
          WHERE s.report_week_start = p_week_start
            AND (p_weekly_float IS NULL OR s.has_weekly_float = p_weekly_float)) END
  ) INTO v;
  RETURN v;
END;
$function$;

-- 8. Grants. Views and evidence tables stay service_role only; the RPCs check roles themselves.
REVOKE ALL ON public.v_landlord_payout_settlement FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_landlord_payout_settlement TO service_role;
REVOKE ALL ON public.v_payables_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_lines TO service_role;
REVOKE ALL ON public.v_payables_payment_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.v_payables_payment_history TO service_role;
REVOKE ALL ON FUNCTION public.trg_provider_statement_lines_immutable() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_provider_statement(text, text, text, text, jsonb, date, date, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.void_provider_statement_import(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landlord_payables_by_week(date, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_provider_statement(text, text, text, text, jsonb, date, date, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.void_provider_statement_import(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_landlord_payables_by_week(date, boolean) TO authenticated, service_role;

RESET lock_timeout;
