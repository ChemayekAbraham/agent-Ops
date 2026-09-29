-- Every movement on an agent advance is recorded on its statement.
--
-- Josh, 2026-09-29: "whenever any deduction takes place it should be recorded
-- very well". Docs 150/154/155 found statements with balance moves and no row,
-- +0/-0 rows that changed the balance, and CFO external payments labelled as
-- wallet deductions. Fourteen functions change agent_advances.outstanding_balance
-- and seven of them (apply_advance_topup, cancel_agent_advance, pause/resume,
-- reconcile_advance_statuses, reverse_agent_advance, update_agent_advance_terms)
-- never write a statement row.
--
-- Rather than patch each writer, three commit-time (DEFERRED) guarantees:
--   1. Balance changed but the statement's last closing doesn't match
--      -> an adjustment row is written with the signed amount and the cause
--         (the audit_logs action of the same transaction when there is one),
--         and an exception is logged for the CFO.
--   2. A deduction row (amount_deducted > 0) is linked to the wallet debit
--      that paid it (wallet_entry_id), or to the platform receipt of a CFO
--      external payment (ledger_group_id). Neither found -> exception.
--   3. cfo_record_advance_payment labels its rows (external_* / wallet_offset)
--      and stores the payment reference instead of defaulting to 'wallet_daily'.
-- Deferred so writers that update the balance before inserting the row (or
-- the other way round) are judged on the final state of the transaction.
-- Nothing here moves money or blocks a deduction.

-- ── columns ────────────────────────────────────────────────────────────────
ALTER TABLE public.agent_advance_ledger
  ADD COLUMN IF NOT EXISTS adjustment_amount numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wallet_entry_id uuid,
  ADD COLUMN IF NOT EXISTS ledger_group_id uuid,
  ADD COLUMN IF NOT EXISTS note text;

COMMENT ON COLUMN public.agent_advance_ledger.adjustment_amount IS
  'Signed balance change that is neither penalty nor deduction (top-up, write-off, terms edit, correction). closing = opening + interest_accrued - amount_deducted + adjustment_amount.';
COMMENT ON COLUMN public.agent_advance_ledger.wallet_entry_id IS
  'general_ledger wallet debit that paid this deduction. Linked at commit by zz_advance_deduction_link_payment.';
COMMENT ON COLUMN public.agent_advance_ledger.ledger_group_id IS
  'general_ledger transaction group of a CFO external payment (bank / mobile money / cash) that paid this deduction outside the wallet.';

CREATE INDEX IF NOT EXISTS idx_agent_advance_ledger_advance_created
  ON public.agent_advance_ledger (advance_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_advance_ledger_wallet_entry
  ON public.agent_advance_ledger (wallet_entry_id) WHERE wallet_entry_id IS NOT NULL;

-- ── exceptions the CFO reviews ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.advance_statement_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id uuid NOT NULL REFERENCES public.agent_advances(id) ON DELETE CASCADE,
  statement_row_id uuid,
  kind text NOT NULL CHECK (kind IN ('unrecorded_balance_change', 'deduction_without_wallet_debit')),
  amount numeric NOT NULL,
  detail text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_note text
);
CREATE INDEX IF NOT EXISTS idx_advance_statement_exceptions_open
  ON public.advance_statement_exceptions (advance_id) WHERE resolved_at IS NULL;

ALTER TABLE public.advance_statement_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS advance_statement_exceptions_exec_read ON public.advance_statement_exceptions;
CREATE POLICY advance_statement_exceptions_exec_read ON public.advance_statement_exceptions
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'cfo'::app_role) OR public.has_role(auth.uid(), 'ceo'::app_role)
      OR public.has_role(auth.uid(), 'coo'::app_role) OR public.has_role(auth.uid(), 'manager'::app_role));

-- ── 1. balance changed without a statement row ─────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_advance_balance_must_be_on_statement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_outstanding numeric;
  v_last record;
  v_diff numeric;
  v_cause text;
  v_row_id uuid;
BEGIN
  SELECT outstanding_balance INTO v_outstanding FROM public.agent_advances WHERE id = NEW.id;
  IF v_outstanding IS NULL THEN
    RETURN NULL;
  END IF;

  -- Last statement row, following the chain within a same-instant burst.
  SELECT closing_balance INTO v_last
  FROM public.agent_advance_ledger
  WHERE advance_id = NEW.id
  ORDER BY created_at DESC, opening_balance ASC, id DESC
  LIMIT 1;

  -- No statement yet (brand-new advance): its first row will open it.
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_diff := v_outstanding - v_last.closing_balance;
  IF abs(v_diff) < 0.01 THEN
    RETURN NULL;
  END IF;

  -- Name the cause: an explicit note set by the writer, else the audit entry
  -- written in this same transaction, else say that nobody gave one.
  v_cause := nullif(current_setting('welile.advance_adjustment_note', true), '');
  IF v_cause IS NULL THEN
    SELECT action_type || coalesce(': ' || nullif(coalesce(reason, metadata->>'reason'), ''), '')
      INTO v_cause
    FROM public.audit_logs
    WHERE record_id = NEW.id AND created_at = now()
    ORDER BY id DESC
    LIMIT 1;
  END IF;
  v_cause := left(coalesce(v_cause, 'Balance changed with no statement entry and no audit reason'), 500);

  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     adjustment_amount, closing_balance, deduction_status, recovery_source, note)
  VALUES
    (NEW.id, (now() AT TIME ZONE 'Africa/Kampala')::date, v_last.closing_balance, 0, 0,
     v_diff, v_outstanding, 'none', 'balance_adjustment', v_cause)
  RETURNING id INTO v_row_id;

  INSERT INTO public.advance_statement_exceptions (advance_id, statement_row_id, kind, amount, detail)
  VALUES (NEW.id, v_row_id, 'unrecorded_balance_change', v_diff, v_cause);

  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS zz_advance_balance_must_be_on_statement ON public.agent_advances;
CREATE CONSTRAINT TRIGGER zz_advance_balance_must_be_on_statement
  AFTER UPDATE OF outstanding_balance ON public.agent_advances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.outstanding_balance IS DISTINCT FROM NEW.outstanding_balance)
  EXECUTE FUNCTION public.tg_advance_balance_must_be_on_statement();

-- ── 2. link each deduction to what paid it ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_advance_deduction_link_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid;
  v_wallet uuid;
  v_group uuid;
  v_row record;
BEGIN
  SELECT * INTO v_row FROM public.agent_advance_ledger WHERE id = NEW.id;
  IF NOT FOUND OR v_row.amount_deducted <= 0
     OR v_row.wallet_entry_id IS NOT NULL OR v_row.ledger_group_id IS NOT NULL THEN
    RETURN NULL;
  END IF;

  SELECT agent_id INTO v_agent FROM public.agent_advances WHERE id = v_row.advance_id;

  -- A wallet debit for this agent, same amount, same moment, not already
  -- claimed by another statement row.
  SELECT g.id INTO v_wallet
  FROM public.general_ledger g
  WHERE g.user_id = v_agent
    AND g.ledger_scope = 'wallet'
    AND g.direction = 'cash_out'
    AND g.category IN ('agent_repayment', 'agent_advance_repayment')
    AND g.amount = v_row.amount_deducted
    AND g.created_at BETWEEN v_row.created_at - interval '5 seconds' AND v_row.created_at + interval '5 seconds'
    AND NOT EXISTS (SELECT 1 FROM public.agent_advance_ledger x WHERE x.wallet_entry_id = g.id)
  ORDER BY abs(extract(epoch FROM g.created_at - v_row.created_at)), g.id
  LIMIT 1;

  IF v_wallet IS NOT NULL THEN
    UPDATE public.agent_advance_ledger SET wallet_entry_id = v_wallet WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  -- CFO external payment: a platform receipt booked to this advance.
  SELECT g.transaction_group_id INTO v_group
  FROM public.general_ledger g
  WHERE g.source_id = v_row.advance_id
    AND g.ledger_scope = 'platform'
    AND g.category = 'agent_advance_repayment_external'
    AND g.amount = v_row.amount_deducted
    AND g.created_at BETWEEN v_row.created_at - interval '5 seconds' AND v_row.created_at + interval '5 seconds'
  ORDER BY g.created_at DESC
  LIMIT 1;

  IF v_group IS NOT NULL THEN
    UPDATE public.agent_advance_ledger SET ledger_group_id = v_group WHERE id = NEW.id;
    RETURN NULL;
  END IF;

  INSERT INTO public.advance_statement_exceptions (advance_id, statement_row_id, kind, amount, detail)
  VALUES (v_row.advance_id, NEW.id, 'deduction_without_wallet_debit', v_row.amount_deducted,
          'Statement deduction (' || coalesce(v_row.recovery_source, '?') || ') with no wallet debit or platform receipt behind it');
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS zz_advance_deduction_link_payment ON public.agent_advance_ledger;
CREATE CONSTRAINT TRIGGER zz_advance_deduction_link_payment
  AFTER INSERT ON public.agent_advance_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.amount_deducted > 0)
  EXECUTE FUNCTION public.tg_advance_deduction_link_payment();

-- ── 3. CFO Record Payment labels its rows ──────────────────────────────────
DO $$
DECLARE
  d text := pg_get_functiondef('public.cfo_record_advance_payment(uuid,numeric,text,text,text)'::regprocedure);
  v_old text := $o$  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status)
  VALUES
    (p_advance_id, v_today, v_opening, 0, v_paid, v_closing,
     CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END);$o$;
  v_new text := $n$  INSERT INTO public.agent_advance_ledger
    (advance_id, date, opening_balance, interest_accrued, amount_deducted,
     closing_balance, deduction_status, recovery_source, ledger_group_id, note)
  VALUES
    (p_advance_id, v_today, v_opening, 0, v_paid, v_closing,
     CASE WHEN v_closing <= 0 THEN 'full' ELSE 'partial' END,
     CASE WHEN p_payment_method = 'wallet_offset' THEN 'wallet_offset'
          ELSE 'external_' || coalesce(nullif(p_payment_method, ''), 'bank') END,
     CASE WHEN p_payment_method = 'wallet_offset' THEN NULL ELSE v_group_id END,
     left('CFO recorded payment, ref ' || coalesce(nullif(trim(p_reference), ''), '(none)')
          || coalesce(' - ' || nullif(trim(p_notes), ''), ''), 500));$n$;
BEGIN
  IF position(v_new IN d) > 0 THEN
    RETURN; -- already applied
  END IF;
  IF position(v_old IN d) = 0 THEN
    RAISE EXCEPTION 'cfo_record_advance_payment statement insert not found; live body changed, patch by hand';
  END IF;
  EXECUTE replace(d, v_old, v_new);
END $$;

-- ── 4. Wallet check understands the new fields ─────────────────────────────
DO $$
DECLARE
  d text := pg_get_functiondef('public.get_advance_wallet_reconciliation(uuid)'::regprocedure);
BEGIN
  IF position('adjustment_amount' IN d) > 0 THEN
    RETURN;
  END IF;
  -- External CFO payments are backed by a platform receipt, not the wallet.
  d := replace(d,
    $a$    IF v_row.amount_deducted > 0 THEN
      SELECT g.id INTO v_match$a$,
    $a$    IF v_row.amount_deducted > 0 AND v_row.ledger_group_id IS NULL THEN
      SELECT g.id INTO v_match$a$);
  -- Adjustment rows carry their amount, so they are not "+0/-0" rows.
  d := replace(d,
    $b$    IF v_row.amount_deducted > 0 AND v_match IS NULL THEN$b$,
    $b$    IF v_row.amount_deducted > 0 AND v_match IS NULL AND v_row.ledger_group_id IS NULL THEN$b$);
  d := replace(d,
    $c$    ELSIF v_row.amount_deducted = 0 AND v_row.interest_accrued = 0
          AND abs(v_row.closing_balance - v_row.opening_balance) >= 0.01 THEN$c$,
    $c$    ELSIF v_row.amount_deducted = 0 AND v_row.interest_accrued = 0 AND v_row.adjustment_amount = 0
          AND abs(v_row.closing_balance - v_row.opening_balance) >= 0.01 THEN$c$);
  d := replace(d,
    $e$    ELSIF abs(v_row.closing_balance - (v_row.opening_balance + v_row.interest_accrued - v_row.amount_deducted)) >= 0.01 THEN$e$,
    $e$    ELSIF abs(v_row.closing_balance - (v_row.opening_balance + v_row.interest_accrued - v_row.amount_deducted + v_row.adjustment_amount)) >= 0.01 THEN$e$);
  d := replace(d,
    $f$      'deducted', v_row.amount_deducted,$f$,
    $f$      'deducted', v_row.amount_deducted,
      'adjustment', v_row.adjustment_amount,
      'note', v_row.note,
      'paid_outside_wallet', v_row.ledger_group_id IS NOT NULL,$f$);
  IF position('v_row.adjustment_amount = 0' IN d) = 0
     OR position('+ v_row.adjustment_amount' IN d) = 0
     OR position('''adjustment'', v_row.adjustment_amount' IN d) = 0
     OR position('v_row.ledger_group_id IS NULL THEN
      SELECT g.id INTO v_match' IN d) = 0 THEN
    RAISE EXCEPTION 'get_advance_wallet_reconciliation patch did not apply';
  END IF;
  EXECUTE d;
END $$;
