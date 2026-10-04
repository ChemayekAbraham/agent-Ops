-- PHASE 1 (5/5): mapped DR/CR group balance control.
--
-- The existing enforce_ledger_group_balance() sums raw `direction` only and
-- never consults ledger_account_map. It therefore PASSES a group whose legs
-- both resolve to debits - exactly the live deposit defect (both legs DR,
-- raw cash_in/cash_out netting to zero).
--
-- STAGED ROLLOUT, and why. Measured against live data, ~5% of current
-- production groups already fail a mapped test (301 in Sep, 1,465 in Aug),
-- dominated by single-leg payroll interest accruals and cfo_direct_credit.
-- Switching straight to a hard global reject would break those live processes.
-- So:
--   * mode 'log'     (default) - violations recorded, nothing blocked
--   * mode 'enforce'           - hard reject, flip once the legacy sources are fixed
--   * Landlord Flow -> Treasury categories are ALWAYS hard-enforced regardless
--     of mode, because they have no legacy population to break.
-- The legacy cutoff (ledger_integrity_config.enforce_from) is honoured exactly
-- as the existing control does: historical groups are never re-judged and never
-- silently repaired.
--
-- Mirrors the existing control's shape: DEFERRABLE INITIALLY DEFERRED constraint
-- trigger, so it evaluates at commit when every leg of the group is present.

ALTER TABLE public.ledger_integrity_config
  ADD COLUMN IF NOT EXISTS mapped_balance_mode text NOT NULL DEFAULT 'log';
ALTER TABLE public.ledger_integrity_config DROP CONSTRAINT IF EXISTS chk_mapped_balance_mode;
ALTER TABLE public.ledger_integrity_config
  ADD CONSTRAINT chk_mapped_balance_mode CHECK (mapped_balance_mode IN ('log','enforce'));

CREATE TABLE IF NOT EXISTS public.ledger_mapped_balance_violations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_group_id uuid NOT NULL,
  detected_at          timestamptz NOT NULL DEFAULT now(),
  mapped_debits        numeric(20,2) NOT NULL,
  mapped_credits       numeric(20,2) NOT NULL,
  residual             numeric(20,2) NOT NULL,
  source_table         text,
  leg_shape            text
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_mapped_balance_violation_group
  ON public.ledger_mapped_balance_violations(transaction_group_id);
CREATE INDEX IF NOT EXISTS idx_mapped_balance_violation_time
  ON public.ledger_mapped_balance_violations(detected_at);

CREATE OR REPLACE FUNCTION public.enforce_ledger_group_mapped_balance()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE
  v_cutoff timestamptz; v_first timestamptz; v_mode text;
  v_dr numeric := 0; v_cr numeric := 0; v_resid numeric;
  v_has_treasury boolean := false; v_shape text; v_src text;
BEGIN
  IF NEW.transaction_group_id IS NULL THEN RETURN NEW; END IF;

  SELECT enforce_from, COALESCE(mapped_balance_mode,'log')
    INTO v_cutoff, v_mode FROM public.ledger_integrity_config WHERE id = true;
  IF v_cutoff IS NULL THEN v_cutoff := now(); END IF;

  SELECT MIN(created_at) INTO v_first FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;
  IF v_first IS NULL OR v_first < v_cutoff THEN RETURN NEW; END IF;

  WITH legs AS (
    SELECT gl.direction dir, gl.amount amt, gl.source_table st,
           gl.ledger_scope||'.'||gl.category AS posting,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='float'   THEN 'A2'
                  WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket='advance' THEN 'A4'
                  WHEN gl.ledger_scope='wallet'                                THEN 'L1'
                  ELSE 'A9' END) AS acct,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope='wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope='wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS dw,
           gl.category
    FROM public.general_ledger gl
    LEFT JOIN public.ledger_account_map mb ON mb.ledger_scope=gl.ledger_scope AND mb.category=gl.category
          AND mb.wallet_bucket IS NOT NULL AND mb.wallet_bucket=gl.wallet_bucket
    LEFT JOIN public.ledger_account_map mw ON mw.ledger_scope=gl.ledger_scope AND mw.category=gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_group_id = NEW.transaction_group_id
  )
  SELECT COALESCE(SUM(CASE WHEN dir=dw THEN amt ELSE 0 END),0),
         COALESCE(SUM(CASE WHEN dir=dw THEN 0 ELSE amt END),0),
         bool_or(category IN ('treasury_fee_recognised','treasury_allocated','fee_receivable_created',
                              'partner_reward_accrued','agent_commission_accrued','treasury_net_revenue')),
         string_agg(DISTINCT posting||'->'||acct||'/'||CASE WHEN dir=dw THEN 'DR' ELSE 'CR' END, ' + '),
         MIN(st)
    INTO v_dr, v_cr, v_has_treasury, v_shape, v_src
  FROM legs;

  v_resid := v_dr - v_cr;
  IF abs(v_resid) <= 0.5 THEN RETURN NEW; END IF;

  IF v_has_treasury OR v_mode = 'enforce' THEN
    RAISE EXCEPTION 'Ledger group % fails mapped double-entry: debits % <> credits % (residual %). Shape: %',
      NEW.transaction_group_id, v_dr, v_cr, v_resid, v_shape
      USING HINT = 'Every group must balance on MAPPED accounting treatment, not just raw cash_in/cash_out.';
  END IF;

  INSERT INTO public.ledger_mapped_balance_violations
    (transaction_group_id, mapped_debits, mapped_credits, residual, source_table, leg_shape)
  VALUES (NEW.transaction_group_id, v_dr, v_cr, v_resid, v_src, v_shape)
  ON CONFLICT (transaction_group_id) DO UPDATE
    SET mapped_debits=EXCLUDED.mapped_debits, mapped_credits=EXCLUDED.mapped_credits,
        residual=EXCLUDED.residual, leg_shape=EXCLUDED.leg_shape, detected_at=now();
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_enforce_ledger_group_mapped_balance ON public.general_ledger;
CREATE CONSTRAINT TRIGGER trg_enforce_ledger_group_mapped_balance
  AFTER INSERT ON public.general_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ledger_group_mapped_balance();
