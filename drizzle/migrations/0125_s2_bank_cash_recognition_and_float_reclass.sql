-- S2 Cash & Bank accounting correction (approved 2026-09-15).
--
-- 1. Resolver: manual balance corrections whose counterpart is an agent float
--    leg are float restatements, not bank cash. They move from A1 to X6
--    (Float Restatement Adjustments). The leg keeps the exact side it already
--    sits on, so total debits and total credits are unchanged.
-- 2. Recognition of independently verified banked cash that is float-backed:
--    DR A1 Cash and Bank / CR A8 Agent and Merchant Float Cycle Control,
--    one balanced entry per verified banking declaration, keyed on the
--    verification id so it can never post twice.
-- 3. Custody-backed declarations (A5) are NOT posted. They are disclosed in a
--    reconciliation schedule for Financial Ops, itemised, never plugged.

CREATE OR REPLACE FUNCTION public.sofp_ledger_legs(p_as_at timestamp with time zone)
 RETURNS TABLE(transaction_group_id uuid, ledger_scope text, category text, source_table text, account_code text, dr numeric, cr numeric, group_one_sided boolean, is_legacy_counterpart boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- Reporting-layer resolver for the statement of financial position.
  -- Every general_ledger leg is turned into a debit or a credit against the
  -- reporting chart of accounts (ledger_account_catalog). The base mapping comes
  -- from ledger_account_map; the rules below correct cases where a single ledger
  -- category carries two opposite economics depending on the originating
  -- workflow, which previously placed both legs of a balanced entry on the same
  -- side of the trial balance. NO amount is invented and no ledger row is
  -- touched: only the account and the debit/credit side of existing legs.
  WITH grp_class AS MATERIALIZED (
    SELECT gl.transaction_group_id,
           bool_or(gl.classification IN ('production','legacy_real')
                   OR (gl.classification = 'admin_correction'
                       AND gl.source_table = 'merchant_float_reconciliations')) AS has_reportable
    FROM general_ledger gl
    WHERE gl.transaction_group_id IS NOT NULL
    GROUP BY gl.transaction_group_id
  ), base AS MATERIALIZED (
    SELECT gl.id,
           gl.transaction_group_id AS real_gid,
           COALESCE(gl.transaction_group_id, gl.id) AS gid,
           gl.ledger_scope AS sc,
           gl.category AS cat,
           gl.source_table AS src,
           gl.direction AS dir,
           gl.amount AS amt,
           COALESCE(mb.account_code, mw.account_code,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float'   THEN 'A2'
                  WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'advance' THEN 'A4'
                  WHEN gl.ledger_scope = 'wallet'                                  THEN 'L1'
                  ELSE 'A9' END) AS acct0,
           COALESCE(mb.debit_when, mw.debit_when,
             CASE WHEN gl.ledger_scope = 'wallet' AND gl.wallet_bucket IN ('float','advance') THEN 'cash_in'
                  WHEN gl.ledger_scope = 'wallet'                                             THEN 'cash_out'
                  ELSE 'cash_in' END) AS dw0
    FROM general_ledger gl
    LEFT JOIN grp_class g ON g.transaction_group_id = gl.transaction_group_id
    LEFT JOIN ledger_account_map mb
           ON mb.ledger_scope = gl.ledger_scope
          AND mb.category     = gl.category
          AND mb.wallet_bucket IS NOT NULL
          AND mb.wallet_bucket = gl.wallet_bucket
    LEFT JOIN ledger_account_map mw
           ON mw.ledger_scope = gl.ledger_scope
          AND mw.category     = gl.category
          AND mw.wallet_bucket IS NULL
    WHERE gl.transaction_date <= p_as_at
      AND CASE
            WHEN gl.transaction_group_id IS NULL
              THEN gl.classification IN ('production','legacy_real')
            ELSE COALESCE(g.has_reportable, false)
          END
  ), shape AS MATERIALIZED (
    SELECT b.gid,
           count(*) AS n_legs,
           count(*) FILTER (WHERE b.sc = 'wallet') AS n_wallet,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'A2') AS n_a2,
           count(*) FILTER (WHERE b.sc = 'wallet' AND b.acct0 = 'L1') AS n_l1,
           count(*) FILTER (WHERE b.sc = 'platform') AS n_plat,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'system_balance_correction') AS n_plat_sbc,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment')) AS n_repay,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.acct0 = 'R1') AS n_rev,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'landlord_receivable_collected') AS n_land_recv,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'cash_custody_payable') AS n_custody,
           count(*) FILTER (WHERE b.sc = 'platform' AND b.cat = 'wallet_deposit' AND b.dir = 'cash_out') AS n_bank_receipt,
           sum(CASE WHEN b.dir = 'cash_in' THEN b.amt ELSE -b.amt END) AS raw_net
    FROM base b
    GROUP BY b.gid
  ), adj AS MATERIALIZED (
    SELECT b.real_gid, b.gid, b.sc, b.cat, b.src, b.dir, b.amt, s.raw_net,
      CASE
        -- R1  Manual balance corrections: a correction whose counterpart is an
        --     agent float leg is a FLOAT RESTATEMENT, not bank cash. No bank
        --     money moves when a desk float is re-set to an evidenced figure,
        --     so the counterpart is the openly disclosed expense account X6
        --     (was A1, which drove Cash and Bank to an impossible credit
        --     balance). Otherwise it stays an equity adjustment (E3).
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'X6'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'E3'
        -- R2  Advances disbursed into agent wallets are receivables, not bank cash.
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'A4'
        -- R3  Float swept back to the platform to settle a wallet deduction.
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'A1'
        -- R3b Wallet deduction taken from a user's own withdrawable balance
        --     (CFO Direct Debit). No cash moved and no advance receivable exists.
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'E3'
        -- R4  Withdrawal settled out of agent float.
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN 'L1'
        -- R5  Float <-> withdrawable reclass.
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'X4'
        -- R8  Physical cash deposit credited to a user's WITHDRAWABLE balance.
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset'
             AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN 'L1'
        ELSE b.acct0
      END AS acct,
      CASE
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction' AND s.n_a2 > 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat = 'system_balance_correction'                THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'rent_disbursement' AND b.src = 'agent_advance_requests' THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_a2 > 0 AND s.n_l1 = 0 THEN 'cash_in'
        WHEN b.sc = 'platform' AND b.cat LIKE 'wallet_deduction%' AND s.n_l1 > 0 THEN 'cash_out'
        WHEN b.sc = 'platform' AND b.cat = 'wallet_withdrawal' AND s.n_wallet > 0 AND s.n_l1 = 0 THEN b.dir
        WHEN b.sc = 'platform' AND b.cat = 'agent_float_cash_offset'
             AND s.n_custody > 0 AND s.n_wallet > 0 AND s.n_a2 = 0 THEN b.dir
        -- R6  Rent collected by an agent is cash received into float.
        WHEN b.sc = 'platform'
             AND b.cat IN ('tenant_repayment','tenant_repayment_collected','rent_repayment',
                           'landlord_receivable_collected')
             AND s.n_a2 > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2'
             AND (s.n_repay > 0 OR s.n_land_recv > 0) THEN b.dir
        -- R8b Float top-up settled into the company bank.
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_bank_receipt > 0
             THEN CASE WHEN b.dir = 'cash_in' THEN 'cash_out' ELSE 'cash_in' END
        -- R7  Platform fees paid out of float.
        WHEN b.sc = 'wallet' AND b.acct0 = 'A2' AND s.n_rev > 0 THEN b.dir
        WHEN b.sc = 'wallet' AND b.acct0 = 'L1'
             AND s.n_wallet = 2 AND s.n_a2 = 1 AND s.n_l1 = 1
             AND (s.n_plat = 0 OR s.n_plat = s.n_plat_sbc) THEN 'cash_in'
        ELSE b.dw0
      END AS dw
    FROM base b
    JOIN shape s ON s.gid = b.gid
  ), mapped AS MATERIALIZED (
    SELECT a.real_gid, a.gid, a.sc, a.cat, a.src, a.acct, a.raw_net,
           CASE WHEN a.dir = a.dw THEN a.amt ELSE 0 END AS dr,
           CASE WHEN a.dir = a.dw THEN 0 ELSE a.amt END AS cr
    FROM adj a
  ), one_sided AS (
    SELECT m.gid, SUM(m.dr) - SUM(m.cr) AS resid
    FROM mapped m
    GROUP BY m.gid
    HAVING abs(MAX(m.raw_net)) > 0.5 AND abs(SUM(m.dr) - SUM(m.cr)) > 0.5
  )
  SELECT m.real_gid, m.sc, m.cat, m.src, m.acct, m.dr, m.cr,
         (o.gid IS NOT NULL) AS group_one_sided,
         false AS is_legacy_counterpart
  FROM mapped m
  LEFT JOIN one_sided o ON o.gid = m.gid
  UNION ALL
  SELECT NULL::uuid, 'reconciliation', 'legacy_one_sided_counterpart', NULL, 'E4',
         CASE WHEN o.resid < 0 THEN -o.resid ELSE 0 END,
         CASE WHEN o.resid > 0 THEN  o.resid ELSE 0 END,
         true, true
  FROM one_sided o;
$function$;

-- Audit trail of every recognition posting made, one row per declaration.
CREATE TABLE IF NOT EXISTS public.bank_cash_recognition_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id uuid NOT NULL UNIQUE,
  deposit_request_id uuid NOT NULL,
  amount numeric NOT NULL,
  backing text NOT NULL,
  transaction_group_id uuid,
  posted_by uuid,
  posted_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

GRANT SELECT ON public.bank_cash_recognition_log TO authenticated;
GRANT ALL ON public.bank_cash_recognition_log TO service_role;
ALTER TABLE public.bank_cash_recognition_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance staff read bank cash recognition log" ON public.bank_cash_recognition_log;
CREATE POLICY "Finance staff read bank cash recognition log"
ON public.bank_cash_recognition_log
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- Record of each execution, for the CFO run history.
CREATE TABLE IF NOT EXISTS public.bank_cash_recognition_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at timestamptz NOT NULL DEFAULT now(),
  run_by uuid,
  dry_run boolean NOT NULL DEFAULT true,
  result jsonb NOT NULL
);

GRANT SELECT ON public.bank_cash_recognition_runs TO authenticated;
GRANT ALL ON public.bank_cash_recognition_runs TO service_role;
ALTER TABLE public.bank_cash_recognition_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Finance staff read bank cash recognition runs" ON public.bank_cash_recognition_runs;
CREATE POLICY "Finance staff read bank cash recognition runs"
ON public.bank_cash_recognition_runs
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'financial_ops')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- Classification of every verified banking declaration against its own ledger
-- legs. Nothing is inferred: the backing is read from the legs the deposit
-- already posted.
CREATE OR REPLACE VIEW public.v_verified_bank_declarations AS
WITH d AS (
  SELECT v.id AS verification_id,
         dr.id AS deposit_request_id,
         dr.user_id,
         dr.amount,
         dr.approved_at,
         dr.transaction_id
  FROM public.deposit_requests dr
  JOIN public.cash_deposit_verifications v ON v.deposit_request_id = dr.id
  WHERE dr.purpose_audit->>'cash_location' = 'bank'
    AND dr.status = 'approved'
    AND v.status = 'verified'
), legs AS (
  SELECT d.*,
    bool_or(gl.category IN ('treasury_bank_deposit','cash_in_transit_banked')) AS already_banked,
    bool_or(gl.ledger_scope = 'platform' AND gl.category = 'wallet_deposit' AND gl.direction = 'cash_out') AS already_debited_to_bank,
    bool_or(gl.ledger_scope = 'platform' AND gl.category = 'cash_receipt_in_transit') AS custody_leg,
    bool_or(gl.ledger_scope = 'wallet' AND gl.wallet_bucket = 'float') AS float_leg,
    count(gl.id) AS leg_count
  FROM d
  LEFT JOIN public.general_ledger gl
         ON gl.source_id = d.deposit_request_id
        AND gl.classification IN ('production','legacy_real')
  GROUP BY d.verification_id, d.deposit_request_id, d.user_id, d.amount, d.approved_at, d.transaction_id
)
SELECT l.*,
  CASE
    WHEN l.already_banked            THEN 'already_banked'
    WHEN l.already_debited_to_bank   THEN 'already_debited_to_bank'
    WHEN l.custody_leg               THEN 'custody_backed'
    WHEN l.float_leg                 THEN 'float_backed'
    WHEN l.leg_count = 0             THEN 'no_ledger_legs'
    ELSE 'counterpart_unidentified'
  END AS backing
FROM legs l;

GRANT SELECT ON public.v_verified_bank_declarations TO authenticated, service_role;

-- Disclosure schedule: what is recognised, what is deliberately not, and the
-- residual variance against the independently verified bank position. Itemised,
-- never plugged.
CREATE OR REPLACE FUNCTION public.bank_cash_recognition_schedule()
RETURNS TABLE(backing text, declarations bigint, amount numeric, treatment text)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT d.backing,
         count(*)::bigint,
         sum(d.amount),
         CASE d.backing
           WHEN 'already_banked'          THEN 'No entry — already posted as a bank event'
           WHEN 'already_debited_to_bank' THEN 'No entry — already debited to Cash and Bank as a wallet deposit'
           WHEN 'float_backed'            THEN 'Recognised: DR A1 Cash and Bank / CR A8 Agent and Merchant Float Cycle Control'
           WHEN 'custody_backed'          THEN 'NOT posted (S2 decision) — custody (A5) left exactly as reconciled; disclosed for Financial Ops review'
           ELSE 'NOT posted — counterpart cannot be identified leg by leg; referred to Financial Ops'
         END
  FROM v_verified_bank_declarations d
  GROUP BY d.backing
  ORDER BY d.backing;
$$;

REVOKE ALL ON FUNCTION public.bank_cash_recognition_schedule() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_cash_recognition_schedule() TO authenticated, service_role;

-- Step 3 (S2): recognise ONLY the float-backed verified banked cash.
-- One balanced entry per declaration, idempotency key = the verification id,
-- so a second run posts nothing. Custody-backed declarations are skipped.
CREATE OR REPLACE FUNCTION public.recognise_verified_bank_cash(p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_rec record;
  v_group uuid;
  v_posted integer := 0;
  v_skipped integer := 0;
  v_amount numeric := 0;
  v_key text;
BEGIN
  IF auth.uid() IS NOT NULL
     AND NOT (public.has_role(auth.uid(), 'cfo')
              OR public.has_role(auth.uid(), 'ceo')
              OR public.has_role(auth.uid(), 'super_admin')) THEN
    RAISE EXCEPTION 'Only the CFO, CEO or a super admin may recognise verified bank cash';
  END IF;

  FOR v_rec IN
    SELECT d.verification_id, d.deposit_request_id, d.amount, d.approved_at
    FROM v_verified_bank_declarations d
    WHERE d.backing = 'float_backed'
    ORDER BY d.approved_at
  LOOP
    v_key := 'bank-cash-recognition-v1:' || v_rec.verification_id::text;

    IF EXISTS (SELECT 1 FROM bank_cash_recognition_log l
               WHERE l.verification_id = v_rec.verification_id)
       OR EXISTS (SELECT 1 FROM general_ledger gl WHERE gl.idempotency_key = v_key) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_amount := v_amount + v_rec.amount;

    IF p_dry_run THEN
      v_posted := v_posted + 1;
      CONTINUE;
    END IF;

    v_group := public.create_ledger_transaction(
      entries => jsonb_build_array(
        jsonb_build_object(
          'ledger_scope','platform',
          'category','verified_bank_cash_recognised',
          'direction','cash_in',
          'amount', v_rec.amount,
          'description','Verified banked cash recognised into Cash and Bank (float-backed declaration)',
          'source_table','cash_deposit_verifications',
          'source_id', v_rec.verification_id,
          'reference_id','BANKREC-' || left(v_rec.verification_id::text, 8),
          'classification','production'
        ),
        jsonb_build_object(
          'ledger_scope','platform',
          'category','agent_float_cycle_settled_to_bank',
          'direction','cash_out',
          'amount', v_rec.amount,
          'description','Agent float cycle control credited: float-backed cash confirmed banked',
          'source_table','cash_deposit_verifications',
          'source_id', v_rec.verification_id,
          'reference_id','BANKREC-' || left(v_rec.verification_id::text, 8),
          'classification','production'
        )
      ),
      idempotency_key => v_key
    );

    INSERT INTO bank_cash_recognition_log (
      verification_id, deposit_request_id, amount, backing, transaction_group_id, posted_by, notes
    ) VALUES (
      v_rec.verification_id, v_rec.deposit_request_id, v_rec.amount, 'float_backed', v_group, auth.uid(),
      'S2 correction: DR A1 Cash and Bank / CR A8 Agent and Merchant Float Cycle Control'
    );

    v_posted := v_posted + 1;
  END LOOP;

  RETURN jsonb_build_object(
    'dry_run', p_dry_run,
    'declarations_posted', v_posted,
    'declarations_skipped_already_posted', v_skipped,
    'amount_recognised', v_amount,
    'schedule', (SELECT jsonb_agg(to_jsonb(s)) FROM bank_cash_recognition_schedule() s)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.recognise_verified_bank_cash(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recognise_verified_bank_cash(boolean) TO service_role;