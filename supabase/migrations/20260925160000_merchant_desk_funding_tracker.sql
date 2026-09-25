-- Merchant desk funding tracker (docs/HANDOVER/135).
--
-- Tracks, per merchant desk and per day, what the COMPANY gives the desk and
-- what the desk USES, and therefore when company funds run out and the
-- merchant starts fronting her own money (out-of-pocket).
--
--   given (ledger)   float credited to the desk in the system
--                    (agent_float_deposit / agent_float_assignment into the float bucket)
--   given (external) treasury money sent to the desk's payout bank account
--                    OUTSIDE the ledger (bank transfers) — recorded in
--                    merchant_desk_external_funding. Rows are 'suggested' by
--                    matching rules against the Equity / MTN emails and only
--                    count as 'confirmed' once Finance confirms them.
--   taken back       float removed from the desk (corrections down, float moved
--                    to other desks, float moved to the merchant's wallet)
--   used             every completed payout the desk made (principal + telecom
--                    charge), from merchant_payout_funding — MoMo and bank alike
--
-- running = given + external - taken_back - used, anchored at 0 on
-- 2026-09-01 (the 2026-08-31 fresh start settled everything before it).
-- running > 0: company money still with the desk.
-- running < 0: the merchant is fronting her own money (OOP outstanding).
-- Funding that arrives while running < 0 covers her OOP first.
--
-- Read-only with respect to money: nothing here posts to general_ledger or
-- moves a wallet balance.

-- ── External (off-ledger) funding register ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.merchant_desk_external_funding (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  funded_at timestamptz NOT NULL,
  channel text NOT NULL CHECK (channel IN ('bank_transfer','mtn_to_bank','airtel_to_bank','cash','other')),
  reference text,
  source_account text,
  destination_account text,
  gmail_transaction_id uuid UNIQUE,
  status text NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','confirmed','rejected')),
  rule_id uuid,
  note text,
  recorded_by uuid,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mdef_agent_funded ON public.merchant_desk_external_funding (agent_id, funded_at);

-- Matching rules that turn provider emails into 'suggested' funding rows.
CREATE TABLE IF NOT EXISTS public.merchant_desk_funding_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL,
  rule_kind text NOT NULL CHECK (rule_kind IN ('equity_outgoing_to_account','mtn_to_equity')),
  body_pattern text,           -- regex on the email body (equity_outgoing_to_account)
  active boolean NOT NULL DEFAULT true,
  active_from timestamptz NOT NULL DEFAULT '2026-09-01 00:00:00+03',
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.merchant_desk_external_funding ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merchant_desk_funding_rules ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_merchant_funding_reviewer(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT _uid IS NOT NULL AND (
       public.has_role(_uid, 'cfo'::app_role)
    OR public.has_role(_uid, 'financial_ops'::app_role)
    OR public.has_role(_uid, 'super_admin'::app_role)
    OR public.has_role(_uid, 'ceo'::app_role)
    OR public.has_role(_uid, 'coo'::app_role)
    OR public.has_role(_uid, 'manager'::app_role));
$$;

DROP POLICY IF EXISTS mdef_read ON public.merchant_desk_external_funding;
CREATE POLICY mdef_read ON public.merchant_desk_external_funding
  FOR SELECT TO authenticated USING (public.is_merchant_funding_reviewer(auth.uid()));
DROP POLICY IF EXISTS mdfr_read ON public.merchant_desk_funding_rules;
CREATE POLICY mdfr_read ON public.merchant_desk_funding_rules
  FOR SELECT TO authenticated USING (public.is_merchant_funding_reviewer(auth.uid()));
GRANT SELECT ON public.merchant_desk_external_funding, public.merchant_desk_funding_rules TO authenticated;
GRANT ALL ON public.merchant_desk_external_funding, public.merchant_desk_funding_rules TO service_role;

-- ── Suggest funding rows from provider emails ──────────────────────────────
CREATE OR REPLACE FUNCTION public.suggest_merchant_desk_external_funding()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
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
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION public.suggest_merchant_desk_external_funding() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.suggest_merchant_desk_external_funding() TO service_role;

-- ── Finance actions ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_merchant_desk_external_funding(
  p_agent_id uuid, p_amount numeric, p_funded_at timestamptz, p_channel text,
  p_reference text DEFAULT NULL, p_note text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid;
BEGIN
  IF NOT public.is_merchant_funding_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.merchant_desk_external_funding
    (agent_id, amount, funded_at, channel, reference, status, note, recorded_by, decided_by, decided_at)
  VALUES (p_agent_id, p_amount, p_funded_at, p_channel, p_reference, 'confirmed', p_note, auth.uid(), auth.uid(), now())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.decide_merchant_desk_external_funding(
  p_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NOT public.is_merchant_funding_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('confirmed','rejected','suggested') THEN
    RAISE EXCEPTION 'invalid status %', p_status;
  END IF;
  UPDATE public.merchant_desk_external_funding
     SET status = p_status, decided_by = auth.uid(), decided_at = now(),
         note = CASE WHEN p_note IS NULL THEN note ELSE coalesce(note || E'\n', '') || p_note END,
         updated_at = now()
   WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'funding row % not found', p_id; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_merchant_desk_external_funding(uuid,numeric,timestamptz,text,text,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.decide_merchant_desk_external_funding(uuid,text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_merchant_desk_external_funding(uuid,numeric,timestamptz,text,text,text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.decide_merchant_desk_external_funding(uuid,text,text) TO authenticated, service_role;

-- ── The tracker ─────────────────────────────────────────────────────────────
-- One row per desk per day with activity, plus a combined row per day
-- (agent_id NULL, desk_label 'ALL DESKS') when more than one desk is asked for.
CREATE OR REPLACE FUNCTION public.get_merchant_desk_funding_tracker(
  p_agent_ids uuid[],
  p_from date DEFAULT '2026-09-01',
  p_to date DEFAULT NULL)
RETURNS TABLE (
  agent_id uuid,
  desk_label text,
  day date,
  given_ledger numeric,
  given_external_confirmed numeric,
  given_external_suggested numeric,
  taken_back numeric,
  used numeric,
  payouts integer,
  bank_payouts_amount numeric,
  running_confirmed numeric,
  oop_outstanding_confirmed numeric,
  running_with_suggested numeric,
  oop_outstanding_with_suggested numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
#variable_conflict use_column
DECLARE
  c_anchor CONSTANT date := '2026-09-01';   -- 2026-08-31 fresh start
  v_to date := coalesce(p_to, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.is_merchant_funding_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'not authorised' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH desks AS (
    SELECT a.id AS agent_id,
           coalesce(ca.label, 'Desk') || ' — ' || coalesce(pr.full_name, a.id::text) AS label
    FROM unnest(p_agent_ids) AS a(id)
    LEFT JOIN public.profiles pr ON pr.id = a.id
    LEFT JOIN LATERAL (SELECT c.label FROM public.cashout_agents c WHERE c.agent_id = a.id ORDER BY c.created_at DESC LIMIT 1) ca ON true
  ),
  gl AS (
    SELECT g.user_id AS agent_id, (g.transaction_date AT TIME ZONE 'Africa/Kampala')::date AS d,
           g.direction, g.category, g.amount
    FROM public.general_ledger g
    WHERE g.user_id = ANY (p_agent_ids)
      AND g.ledger_scope = 'wallet'
      AND g.wallet_bucket = 'float'
      AND g.classification IN ('production','admin_correction')
      AND g.transaction_date >= (c_anchor::timestamp AT TIME ZONE 'Africa/Kampala')
      AND g.transaction_date <  ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
  ),
  given AS (
    SELECT gl.agent_id, gl.d, sum(gl.amount) AS amt FROM gl
    WHERE gl.direction = 'cash_in' AND gl.category IN ('agent_float_deposit','agent_float_assignment')
    GROUP BY 1, 2
  ),
  taken AS (
    SELECT gl.agent_id, gl.d, sum(gl.amount) AS amt FROM gl
    WHERE gl.direction = 'cash_out' AND gl.category <> 'agent_float_settlement'
    GROUP BY 1, 2
  ),
  used AS (
    SELECT f.agent_id, (coalesce(w.processed_at, w.updated_at) AT TIME ZONE 'Africa/Kampala')::date AS d,
           sum(f.payout_amount + f.telecom_charge_expected) AS amt,
           count(*)::integer AS n,
           coalesce(sum(f.payout_amount) FILTER (WHERE w.payout_method = 'bank_transfer'), 0) AS bank_amt
    FROM public.merchant_payout_funding f
    JOIN public.withdrawal_requests w ON w.id = f.withdrawal_id
    WHERE f.agent_id = ANY (p_agent_ids)
      AND w.status IN ('paid','completed')
      AND coalesce(w.processed_at, w.updated_at) >= (c_anchor::timestamp AT TIME ZONE 'Africa/Kampala')
      AND coalesce(w.processed_at, w.updated_at) <  ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
    GROUP BY 1, 2
  ),
  ext AS (
    SELECT e.agent_id, (e.funded_at AT TIME ZONE 'Africa/Kampala')::date AS d,
           coalesce(sum(e.amount) FILTER (WHERE e.status = 'confirmed'), 0) AS conf,
           coalesce(sum(e.amount) FILTER (WHERE e.status = 'suggested'), 0) AS sugg
    FROM public.merchant_desk_external_funding e
    WHERE e.agent_id = ANY (p_agent_ids)
      AND e.status IN ('confirmed','suggested')
      AND e.funded_at >= (c_anchor::timestamp AT TIME ZONE 'Africa/Kampala')
      AND e.funded_at <  ((v_to + 1)::timestamp AT TIME ZONE 'Africa/Kampala')
    GROUP BY 1, 2
  ),
  days AS (
    SELECT x.agent_id, x.d FROM given x UNION SELECT x.agent_id, x.d FROM taken x
    UNION SELECT x.agent_id, x.d FROM used x UNION SELECT x.agent_id, x.d FROM ext x
  ),
  per_desk AS (
    SELECT dy.agent_id, dy.d,
           coalesce(g.amt, 0) AS given_ledger,
           coalesce(e.conf, 0) AS ext_conf,
           coalesce(e.sugg, 0) AS ext_sugg,
           coalesce(t.amt, 0) AS taken_back,
           coalesce(u.amt, 0) AS used,
           coalesce(u.n, 0) AS payouts,
           coalesce(u.bank_amt, 0) AS bank_amt
    FROM days dy
    LEFT JOIN given g ON g.agent_id = dy.agent_id AND g.d = dy.d
    LEFT JOIN taken t ON t.agent_id = dy.agent_id AND t.d = dy.d
    LEFT JOIN used  u ON u.agent_id = dy.agent_id AND u.d = dy.d
    LEFT JOIN ext   e ON e.agent_id = dy.agent_id AND e.d = dy.d
  ),
  combined AS (
    SELECT p.agent_id, p.d, p.given_ledger, p.ext_conf, p.ext_sugg, p.taken_back, p.used, p.payouts, p.bank_amt
    FROM per_desk p
    UNION ALL
    SELECT NULL::uuid, p.d, sum(p.given_ledger), sum(p.ext_conf), sum(p.ext_sugg), sum(p.taken_back),
           sum(p.used), sum(p.payouts)::integer, sum(p.bank_amt)
    FROM per_desk p
    WHERE cardinality(p_agent_ids) > 1
    GROUP BY p.d
  ),
  running AS (
    SELECT c.*,
      sum(c.given_ledger + c.ext_conf - c.taken_back - c.used)
        OVER (PARTITION BY c.agent_id ORDER BY c.d) AS run_conf,
      sum(c.given_ledger + c.ext_conf + c.ext_sugg - c.taken_back - c.used)
        OVER (PARTITION BY c.agent_id ORDER BY c.d) AS run_sugg
    FROM combined c
  )
  SELECT r.agent_id,
         coalesce(dk.label, 'ALL DESKS'),
         r.d,
         r.given_ledger, r.ext_conf, r.ext_sugg, r.taken_back, r.used, r.payouts, r.bank_amt,
         r.run_conf, greatest(0, -r.run_conf),
         r.run_sugg, greatest(0, -r.run_sugg)
  FROM running r
  LEFT JOIN desks dk ON dk.agent_id = r.agent_id
  WHERE r.d >= p_from
  ORDER BY r.agent_id NULLS LAST, r.d;
END;
$$;
REVOKE ALL ON FUNCTION public.get_merchant_desk_funding_tracker(uuid[], date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_merchant_desk_funding_tracker(uuid[], date, date) TO authenticated, service_role;

-- ── Seed: Immaculate Namulindwa's bank desk (BAITA / Sky Bubbles) ──────────
-- Funding trail established 2026-09-25 (docs/HANDOVER/134). Suggested only:
-- Finance confirms or rejects each row. MTN->Equity SMS do not name the
-- destination account, and some treasury bank funding is ALSO recorded as a
-- ledger float reconciliation (e.g. 11 Sep 20,189,508) — reject the external
-- row in that case so it is not counted twice.
INSERT INTO public.merchant_desk_funding_rules (agent_id, rule_kind, body_pattern, note)
SELECT '1a88b1b8-6601-477b-b119-8e18d5dc9ebd', 'equity_outgoing_to_account',
       'Dear\s*BAYO.*NABAGGALA CATHERINE',
       'Bayo Mercy Equity ...7542 -> NABAGGALA CATHERINE ...9292: same-day relay of WELILE treasury funds, believed to be the BAITA bank payout account (unproven).'
WHERE NOT EXISTS (SELECT 1 FROM public.merchant_desk_funding_rules
                  WHERE agent_id = '1a88b1b8-6601-477b-b119-8e18d5dc9ebd' AND rule_kind = 'equity_outgoing_to_account');
INSERT INTO public.merchant_desk_funding_rules (agent_id, rule_kind, body_pattern, note)
SELECT '1a88b1b8-6601-477b-b119-8e18d5dc9ebd', 'mtn_to_equity', NULL,
       'Company MTN line -> EQUITY BANK LIMITED. Destination account not in SMS; assumed to fund BAITA bank payouts.'
WHERE NOT EXISTS (SELECT 1 FROM public.merchant_desk_funding_rules
                  WHERE agent_id = '1a88b1b8-6601-477b-b119-8e18d5dc9ebd' AND rule_kind = 'mtn_to_equity');

SELECT public.suggest_merchant_desk_external_funding();

-- Keep suggestions current (every 15 min).
DO $cron$
BEGIN
  PERFORM cron.unschedule(jobid) FROM cron.job WHERE jobname = 'suggest-merchant-desk-external-funding-15m';
END
$cron$;
SELECT cron.schedule(
  'suggest-merchant-desk-external-funding-15m',
  '*/15 * * * *',
  $$SELECT public.suggest_merchant_desk_external_funding();$$
);
