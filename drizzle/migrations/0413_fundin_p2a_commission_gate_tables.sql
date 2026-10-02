-- FUNDIN-P2A. Approved: Bwayo (HR Lead), 2 Oct 2026, on executive authority.
-- Adds tables and helper functions for the fund-in commission gate. Changes no existing behaviour.
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='user_roles' AND column_name='enabled') THEN
    RAISE EXCEPTION 'FINGERPRINT FAIL: not the RentFlow database';
  END IF;
  IF to_regprocedure('public.create_ledger_transaction(jsonb,text,boolean)') IS NULL
     OR to_regprocedure('public.promissory_commission_rate(text,timestamp with time zone)') IS NULL
     OR to_regprocedure('public.hr_pay_is_staff_reinvest_portfolio(uuid)') IS NULL
     OR to_regclass('public.portfolio_renewals') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAIL: a required object is missing';
  END IF;
END $pre$;

CREATE TABLE IF NOT EXISTS public.commission_gate_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  cutover_at timestamptz NOT NULL,
  note text
);

CREATE TABLE IF NOT EXISTS public.commission_fund_in_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid NOT NULL,
  portfolio_id uuid,
  source_table text NOT NULL,
  source_key text NOT NULL,
  event text NOT NULL CHECK (event IN ('portfolio_activation','topup_completed','self_topup','self_commitment','principal_increase')),
  amount numeric NOT NULL CHECK (amount > 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','fund_in','merged','roi','cancelled','needs_review','not_commissionable')),
  fund_in_id uuid,
  note text,
  decided_by uuid,
  decided_at timestamptz,
  UNIQUE (source_table, source_key, event)
);
CREATE INDEX IF NOT EXISTS commission_fund_in_candidates_pending_idx
  ON public.commission_fund_in_candidates (observed_at) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS public.commission_fund_ins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fund_in_key text NOT NULL UNIQUE,
  partner_id uuid NOT NULL,
  portfolio_id uuid,
  source_table text NOT NULL,
  source_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  occurred_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'unattributed'
    CHECK (status IN ('unattributed','paid','no_earner','not_commissionable')),
  earner_id uuid,
  earner_path text CHECK (earner_path IN ('promissory_note','managed_proxy')),
  note_id uuid,
  assignment_id uuid,
  kind text CHECK (kind IN ('portfolio_creation','portfolio_topup')),
  rate numeric,
  commission numeric,
  ledger_group_id uuid,
  legacy_table text,
  legacy_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commission_fund_ins_partner_idx ON public.commission_fund_ins (partner_id, occurred_at);

CREATE TABLE IF NOT EXISTS public.commission_gate_errors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  context text NOT NULL,
  detail jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $pol$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['commission_gate_settings','commission_fund_in_candidates','commission_fund_ins','commission_gate_errors'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_exec_read', t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (
        public.hr_is_admin() OR public.hr_is_executive() OR EXISTS (
          SELECT 1 FROM public.user_roles ur
           WHERE ur.user_id = auth.uid() AND ur.enabled = true
             AND ur.role = ANY (ARRAY['ceo'::app_role,'cfo'::app_role,'coo'::app_role,'super_admin'::app_role])))$p$,
      t || '_exec_read', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM anon, authenticated', t);
  END LOOP;
END $pol$;

CREATE OR REPLACE FUNCTION public.commission_enqueue_candidate(
  p_partner uuid, p_portfolio uuid, p_source_table text, p_source_key text, p_event text, p_amount numeric)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
BEGIN
  IF p_partner IS NULL OR coalesce(p_amount,0) <= 0 THEN RETURN; END IF;
  IF p_portfolio IS NOT NULL AND public.hr_pay_is_staff_reinvest_portfolio(p_portfolio) THEN RETURN; END IF;
  INSERT INTO public.commission_fund_in_candidates (partner_id, portfolio_id, source_table, source_key, event, amount)
  VALUES (p_partner, p_portfolio, p_source_table, p_source_key, p_event, p_amount)
  ON CONFLICT (source_table, source_key, event) DO NOTHING;
EXCEPTION WHEN OTHERS THEN
  BEGIN
    INSERT INTO public.commission_gate_errors (context, detail, error)
    VALUES ('enqueue', jsonb_build_object('partner',p_partner,'portfolio',p_portfolio,'source_table',p_source_table,
            'source_key',p_source_key,'event',p_event,'amount',p_amount), sqlerrm);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'commission_enqueue_candidate: %', sqlerrm;
  END;
END $f$;

CREATE OR REPLACE FUNCTION public.commission_resolve_earner(p_partner uuid, p_at timestamptz, p_use_lock boolean DEFAULT true)
RETURNS TABLE(earner_id uuid, earner_path text, note_id uuid, assignment_id uuid, basis text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
DECLARE v_phone text; v_email text;
BEGIN
  IF p_use_lock THEN
    RETURN QUERY
      SELECT f.earner_id, f.earner_path, f.note_id, f.assignment_id, 'locked_to_first_paid_fund_in'::text
        FROM public.commission_fund_ins f
       WHERE f.partner_id = p_partner AND f.status = 'paid'
       ORDER BY f.occurred_at, f.created_at
       LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9),
         nullif(lower(trim(coalesce(p.email,''))), '')
    INTO v_phone, v_email
    FROM public.profiles p WHERE p.id = p_partner;

  RETURN QUERY
  WITH c AS (
    SELECT n.agent_id AS c_earner, 'promissory_note'::text AS c_path, n.id AS c_note, NULL::uuid AS c_asg, n.created_at AS c_est
      FROM public.promissory_notes n
     WHERE n.agent_id IS NOT NULL AND n.agent_id <> p_partner
       AND coalesce(n.approval_bonus_paid, false) = true
       AND n.created_at <= p_at
       AND NOT EXISTS (SELECT 1 FROM public.pso_note_reversals r WHERE r.note_id = n.id)
       AND (   n.partner_user_id = p_partner
            OR (length(v_phone) = 9 AND right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9) = v_phone)
            OR (length(v_phone) = 9 AND right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9) = v_phone)
            OR (v_email IS NOT NULL AND lower(trim(coalesce(n.email,''))) = v_email))
    UNION ALL
    SELECT a.agent_id, 'managed_proxy'::text, NULL::uuid, a.id, a.created_at
      FROM public.proxy_agent_assignments a
     WHERE a.beneficiary_id = p_partner AND a.agent_id IS NOT NULL AND a.agent_id <> p_partner
       AND a.is_active = true AND coalesce(a.is_managed_account, false) = true
       AND coalesce(a.approval_status, 'pending') = 'approved'
       AND a.created_at <= p_at
       AND (a.expires_at IS NULL OR a.expires_at > p_at)
  )
  SELECT c.c_earner, c.c_path, c.c_note, c.c_asg, 'earliest_relationship_before_fund_in'::text
    FROM c ORDER BY c.c_est, c.c_path LIMIT 1;
END $f$;

CREATE OR REPLACE FUNCTION public.commission_partner_has_prior_fund_in(p_partner uuid, p_fund_in_key text, p_at timestamptz)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.commission_fund_ins f
                  WHERE f.partner_id = p_partner AND f.fund_in_key <> p_fund_in_key
                    AND f.status <> 'not_commissionable' AND f.occurred_at < p_at)
      OR EXISTS (SELECT 1 FROM public.investor_portfolios ip
                  WHERE ip.investor_id = p_partner AND ip.status IN ('active','locked')
                    AND ip.locked_from_portfolio_id IS NULL
                    AND coalesce(ip.investment_amount,0) > 0
                    AND coalesce((SELECT min(r.old_created_at) FROM public.portfolio_renewals r WHERE r.portfolio_id = ip.id),
                                 ip.created_at) < p_at
                    AND 'pf:' || ip.id::text <> p_fund_in_key
                    AND NOT public.hr_pay_is_staff_reinvest_portfolio(ip.id))
      OR EXISTS (SELECT 1 FROM public.partner_self_commitments s
                  WHERE s.partner_id = p_partner AND s.status IN ('active','matured')
                    AND s.created_at < p_at AND 'psc:' || s.id::text <> p_fund_in_key);
$f$;

REVOKE ALL ON FUNCTION public.commission_enqueue_candidate(uuid,uuid,text,text,text,numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commission_resolve_earner(uuid,timestamptz,boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.commission_partner_has_prior_fund_in(uuid,text,timestamptz) FROM PUBLIC, anon, authenticated;