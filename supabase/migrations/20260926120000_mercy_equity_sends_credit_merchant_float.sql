-- Money sent from Mercy's Equity account to a merchant agent credits MAF
-- automatically, the same way company MTN/Airtel sends already do.
--
-- CEO directive 2026-09-26: Actual = company MTN line + Airtel line + Mercy's
-- Equity account. "Any money moving out should automatically reduce actual to
-- increase Merchant Agents float MAF."
--
-- BEFORE
-- ------
-- MTN/Airtel sends to a merchant agent's float phone are credited to MAF by
-- record_merchant_float_delivery within about a minute. Equity sends from Bayo
-- Mercy's account were only written to merchant_desk_external_funding as
-- 'suggested' rows (suggest_merchant_desk_external_funding, every 15 min) and
-- never reached MAF. 54 rows / UGX 581,263,706 for 1-25 Sep sit there.
--
-- NOW
-- ---
-- For rules of kind 'equity_outgoing_to_account' (Mercy's Equity -> a named
-- account attributed to one desk), every send ON OR AFTER the rule's new
-- auto_credit_from timestamp is credited through record_merchant_float_delivery
-- (same ledger legs as MTN/Airtel: wallet float cash_in DR A2 / platform
-- cash_out CR A8, TID consumed in ledger_reconciled_tids) and the row is marked
-- 'confirmed'.
--
-- NOT CHANGED, ON INSTRUCTION
-- ---------------------------
-- * The 581M already sent is NOT credited ("DON'T CREDIT THE 581M TO THAT FLOAT
--   DESK", 2026-09-26). auto_credit_from is set to the moment this migration is
--   applied, so every earlier row stays 'suggested' for Finance.
-- * 'mtn_to_equity' rules are not auto-credited: the MTN SMS does not name the
--   destination account, so it may be company MTN -> Mercy (Actual -> Actual),
--   not a send to a merchant agent.
--
-- Once the desk holds MAF, its bank payouts consume it like any other payout
-- (classify_merchant_payout_funding reads the float-consume legs), so the
-- float does not accumulate.

ALTER TABLE public.merchant_desk_funding_rules
  ADD COLUMN IF NOT EXISTS auto_credit_from timestamptz;

COMMENT ON COLUMN public.merchant_desk_funding_rules.auto_credit_from IS
  'When set, sends matched by this rule on/after this time are credited to the desk''s MAF automatically (equity_outgoing_to_account only). NULL = suggest only.';

-- Forward-only from the moment this is applied. Never back-dated.
UPDATE public.merchant_desk_funding_rules
   SET auto_credit_from = now()
 WHERE rule_kind = 'equity_outgoing_to_account'
   AND active
   AND auto_credit_from IS NULL;

CREATE OR REPLACE FUNCTION public.auto_credit_merchant_desk_external_funding()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  f   record;
  v_res jsonb;
  v_n integer := 0;
BEGIN
  FOR f IN
    SELECT e.*
      FROM merchant_desk_external_funding e
      JOIN merchant_desk_funding_rules r ON r.id = e.rule_id
     WHERE r.rule_kind = 'equity_outgoing_to_account'
       AND r.active
       AND r.auto_credit_from IS NOT NULL
       AND e.funded_at >= r.auto_credit_from
       AND e.status = 'suggested'
       AND e.gmail_transaction_id IS NOT NULL
     ORDER BY e.funded_at
     FOR UPDATE OF e SKIP LOCKED
  LOOP
    BEGIN
      -- TID = 'EQ' + gmail row id: Equity references are only ~4 characters
      -- and repeat, so they cannot be the idempotency key.
      v_res := public.record_merchant_float_delivery(
        'EQ' || replace(f.gmail_transaction_id::text, '-', ''),
        f.agent_id,
        f.amount,
        'Equity bank (Bayo Mercy)',
        f.gmail_transaction_id,
        f.funded_at
      );

      IF coalesce((v_res->>'ok')::boolean, false) THEN
        UPDATE merchant_desk_external_funding
           SET status = 'confirmed',
               decided_at = now(),
               note = coalesce(note, '') || ' | Auto-credited to merchant float ('
                      || coalesce(v_res->>'reason', 'credited') || ', ledger '
                      || coalesce(v_res->>'ledger_group_id', v_res->>'tid', '-') || ')',
               updated_at = now()
         WHERE id = f.id;
        v_n := v_n + 1;
      ELSE
        UPDATE merchant_desk_external_funding
           SET note = coalesce(note, '') || ' | Auto-credit refused: ' || coalesce(v_res->>'reason', 'unknown'),
               updated_at = now()
         WHERE id = f.id
           AND coalesce(note, '') NOT LIKE '%Auto-credit refused%';
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- One bad row must not block the others; it stays 'suggested'.
      UPDATE merchant_desk_external_funding
         SET note = coalesce(note, '') || ' | Auto-credit error: ' || left(sqlerrm, 200),
             updated_at = now()
       WHERE id = f.id
         AND coalesce(note, '') NOT LIKE '%Auto-credit error%';
    END;
  END LOOP;
  RETURN v_n;
END;
$function$;

REVOKE ALL ON FUNCTION public.auto_credit_merchant_desk_external_funding() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auto_credit_merchant_desk_external_funding() TO service_role;

-- Re-created from the live definition (2026-09-26); the only change is the
-- auto-credit call at the end, so new suggestions are credited in the same run.
CREATE OR REPLACE FUNCTION public.suggest_merchant_desk_external_funding()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_n integer := 0;
  v_rows integer;
  r record;
BEGIN
  FOR r IN SELECT * FROM public.merchant_desk_funding_rules WHERE active LOOP
    IF r.rule_kind = 'equity_outgoing_to_account' THEN
      INSERT INTO public.merchant_desk_external_funding
        (agent_id, amount, funded_at, channel, reference, source_account, destination_account,
         gmail_transaction_id, status, rule_id, note)
      SELECT r.agent_id, t.amount, t.internal_date, 'bank_transfer',
             substring(coalesce(t.raw_body, t.snippet) from 'Reference:\s*([A-Z0-9]+)'),
             'Equity (sender per email salutation)',
             substring(coalesce(t.raw_body, t.snippet) from 'sent to (.+?) at Equity'),
             t.id, 'suggested', r.id, 'Auto-suggested from Equity email by rule ' || r.id::text
      FROM public.gmail_transactions t
      WHERE t.from_email ILIKE '%equity%'
        AND t.internal_date >= r.active_from
        AND t.amount IS NOT NULL AND t.amount > 0
        AND coalesce(t.raw_body, t.snippet) ~* 'transaction was successful'
        AND coalesce(t.raw_body, t.snippet) ~* r.body_pattern
      ON CONFLICT (gmail_transaction_id) DO NOTHING;
    ELSIF r.rule_kind = 'mtn_to_equity' THEN
      INSERT INTO public.merchant_desk_external_funding
        (agent_id, amount, funded_at, channel, reference, source_account, destination_account,
         gmail_transaction_id, status, rule_id, note)
      SELECT r.agent_id, t.amount, t.internal_date, 'mtn_to_bank', t.transaction_id,
             'Company MTN line', 'EQUITY BANK LIMITED (account not shown in SMS)',
             t.id, 'suggested', r.id, 'Auto-suggested from MTN SMS by rule ' || r.id::text
      FROM public.gmail_transactions t
      WHERE t.parsed AND t.channel = 'mtn_momo' AND t.direction IN ('out','charge')
        AND t.counterparty ILIKE 'EQUITY BANK%'
        AND t.internal_date >= r.active_from
        AND t.amount IS NOT NULL AND t.amount > 0
      ON CONFLICT (gmail_transaction_id) DO NOTHING;
    END IF;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_n := v_n + v_rows;
  END LOOP;

  -- 2026-09-26: Mercy's Equity -> merchant agent credits MAF automatically.
  PERFORM public.auto_credit_merchant_desk_external_funding();

  RETURN v_n;
END;
$function$;
