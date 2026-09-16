-- Balance the books against the duplicate collections.
--
-- WHY THIS IS NEEDED
-- 20260916180000 marks the 1,210 duplicate rows reversed and recovers what
-- commission is still in the wallets. Neither of those touches the ledger legs
-- the duplicates posted. Those legs are real rows in `general_ledger`, they
-- cannot be deleted (`trg_prevent_ledger_delete` blocks it, deliberately), and
-- until they are contra'd the financial statements carry UGX 92,656,683 of
-- custody that was never received and the same amount of tenant receivable
-- that was never settled.
--
-- The reports come right once `reversed_at` is set. The BOOKS only come right
-- here.
--
-- WHY IT IS ONE AGGREGATE PAIR AND NOT 1,210 OF THEM
-- Collection ledger legs key on `source_id = rent_request_id`, not on the
-- collection's own id (a known wart - a plan collected 169 times has 169 sets
-- of legs that are indistinguishable from each other). There is therefore no
-- way to point at "the legs belonging to duplicate #74". The honest correction
-- is a single balanced pair carrying the total, with the derivation recorded
-- here so anyone can re-derive it.
--
-- WHICH SHAPE, AND WHY ONLY ONE
-- Every one of the 1,210 duplicates falls inside the 0114 era, which posted:
--     DR A5  cash_receipt_in_transit    cash_in   platform
--     CR A3  tenant_repayment_collected cash_out  platform
-- Zero duplicates pre-date the 2026-09-15 15:12:23 UTC cutoff, so the older
-- float-leg shape needs no contra at all. This reverses exactly that pair.
--
-- NO WALLET IS TOUCHED. Both legs are platform scope. Per the product owner's
-- decision on 2026-09-16, no float is clawed back from any agent: the float
-- reconstruction showed 38 agents would need UGX 57,133,270 consumed against
-- UGX 8,974,187 actually held, and aggregate raw float was already negative
-- (-3,066,884) before the incident began. The money to take is not there.
--
-- CLASSIFICATION IS 'production', NOT 'admin_correction', ON PURPOSE.
-- `get_treasury_cash_position` and the SOFP resolver count only
-- classification IN ('production','legacy_real'). An admin_correction contra
-- would sit in the table looking correct and change no reported figure.
--
-- Verified on a rolled-back transaction against live production:
--   A5 custody          888,024,817 -> 795,368,134  (-92,656,683)
--   A3 receivable       -137,573,554 -> -44,916,871 (+92,656,683)

DO $contra$
DECLARE
  v_amt numeric;
  v_rows int;
  v_grp uuid := gen_random_uuid();
BEGIN
  IF EXISTS (SELECT 1 FROM public.general_ledger
              WHERE description LIKE 'Contra: custody posted by duplicate rent collections%') THEN
    RAISE NOTICE 'Already applied - duplicate-collection contra exists. Nothing done.';
    RETURN;
  END IF;

  -- Re-derive rather than trusting the constant in the header.
  WITH c AS (
    SELECT ac.amount, ac.created_at,
           (lag(ac.created_at) OVER (PARTITION BY ac.agent_id, ac.rent_request_id, ac.amount
                                     ORDER BY ac.created_at)
            > ac.created_at - interval '2 minutes') AS is_dup
      FROM public.agent_collections ac
     WHERE (ac.created_at AT TIME ZONE 'Africa/Kampala')::date
           IN (date '2026-09-15', date '2026-09-16')
  )
  SELECT coalesce(sum(amount), 0), count(*)
    INTO v_amt, v_rows
    FROM c
   WHERE is_dup AND created_at >= timestamptz '2026-09-15 15:12:23+00';

  IF v_amt <= 0 THEN
    RAISE EXCEPTION 'no duplicate value found to contra - re-check before proceeding';
  END IF;

  IF v_rows <> 1210 THEN
    RAISE WARNING 'expected 1210 duplicate rows in the 0114 era, found % - figure is % ', v_rows, v_amt;
  END IF;

  PERFORM set_config('ledger.authorized', 'true', true);

  INSERT INTO public.general_ledger
    (user_id, amount, direction, category, classification, source_table, source_id,
     description, ledger_scope, transaction_group_id)
  VALUES
    (NULL, v_amt, 'cash_out', 'cash_receipt_in_transit', 'production',
     'agent_collections', gen_random_uuid(),
     'Contra: custody posted by duplicate rent collections, 2026-09-15/16 float-gate defect',
     'platform', v_grp),
    (NULL, v_amt, 'cash_in', 'tenant_repayment_collected', 'production',
     'agent_collections', gen_random_uuid(),
     'Contra: tenant receivable wrongly reduced by duplicate rent collections, 2026-09-15/16',
     'platform', v_grp);

  INSERT INTO public.audit_logs (action_type, table_name, record_id, reason, metadata)
  VALUES ('duplicate_collection_ledger_contra', 'general_ledger', v_grp::text,
          'Neutralised the ledger effect of duplicate rent collections recorded 2026-09-15/16',
          jsonb_build_object('duplicate_rows', v_rows, 'amount', v_amt,
                             'transaction_group_id', v_grp,
                             'rule', 'same agent+tenant+plan+amount within 2 minutes'));

  RAISE NOTICE 'contra posted: % rows, UGX %', v_rows, v_amt;
END $contra$;

-- The pair must balance, or the group-balance constraint would have fired.
DO $verify$
DECLARE v_in numeric; v_out numeric;
BEGIN
  SELECT coalesce(sum(amount) FILTER (WHERE direction='cash_in'), 0),
         coalesce(sum(amount) FILTER (WHERE direction='cash_out'), 0)
    INTO v_in, v_out
    FROM public.general_ledger
   WHERE description LIKE 'Contra: %duplicate rent collections%';
  IF v_in IS DISTINCT FROM v_out THEN
    RAISE EXCEPTION 'contra does not balance: cash_in % vs cash_out %', v_in, v_out;
  END IF;
  RAISE NOTICE 'contra balances: % each way', v_in;
END $verify$;
