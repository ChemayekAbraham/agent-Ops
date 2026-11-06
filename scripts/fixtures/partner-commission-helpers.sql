-- Verbatim production copies (2026-10-26, read-only export) of the helpers used by
-- 20261026120000_partner_commission_payables_v2. Loaded by scripts/test-partner-commission-payables.mjs.

CREATE OR REPLACE FUNCTION public.commission_resolve_earner(p_partner uuid, p_at timestamp with time zone, p_use_lock boolean DEFAULT true)
 RETURNS TABLE(earner_id uuid, earner_path text, note_id uuid, assignment_id uuid, basis text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_phone text; v_email text; v_name text;
BEGIN
  IF p_use_lock THEN
    RETURN QUERY
      SELECT f.earner_id, f.earner_path, f.note_id, f.assignment_id, 'locked_to_first_paid_fund_in'::text
        FROM public.commission_fund_ins f
       WHERE f.partner_id = p_partner AND f.status = 'paid'
         AND (f.earner_path IS DISTINCT FROM 'managed_proxy'
              OR EXISTS (SELECT 1 FROM public.proxy_agent_assignments a
                          WHERE a.id = f.assignment_id
                            AND a.is_active = true
                            AND coalesce(a.approval_status, 'pending') = 'approved'
                            AND (a.expires_at IS NULL OR a.expires_at > p_at)))
       ORDER BY f.occurred_at, f.created_at
       LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT right(regexp_replace(coalesce(p.phone,''), '\D', '', 'g'), 9),
         nullif(lower(trim(coalesce(p.email,''))), ''),
         nullif(lower(regexp_replace(trim(coalesce(p.full_name,'')), '\s+', ' ', 'g')), '')
    INTO v_phone, v_email, v_name
    FROM public.profiles p WHERE p.id = p_partner;

  RETURN QUERY
  WITH c AS (
    SELECT n.agent_id AS c_earner, 'promissory_note'::text AS c_path, n.id AS c_note, NULL::uuid AS c_asg, n.created_at AS c_est
      FROM public.promissory_notes n
     WHERE n.agent_id IS NOT NULL AND n.agent_id <> p_partner
       AND coalesce(n.approval_bonus_paid, false) = true
       -- (no "created before the fund-in" test: an approved note that arrived after the money still counts; the earliest note wins)
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
  ), name_c AS (
    SELECT n.agent_id AS c_earner, n.id AS c_note, n.created_at AS c_est
      FROM public.promissory_notes n
     WHERE v_name IS NOT NULL AND position(' ' IN v_name) > 0 AND length(v_name) >= 5
       AND n.agent_id IS NOT NULL AND n.agent_id <> p_partner
       AND coalesce(n.approval_bonus_paid, false) = true
       AND NOT EXISTS (SELECT 1 FROM public.pso_note_reversals r WHERE r.note_id = n.id)
       AND lower(regexp_replace(trim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) = v_name
  ), pick AS (
    SELECT c.c_earner, c.c_path, c.c_note, c.c_asg, 'earliest_relationship'::text AS b
      FROM c ORDER BY c.c_est, c.c_path LIMIT 1
  )
  SELECT * FROM pick
  UNION ALL
  SELECT nc.c_earner, 'promissory_note'::text, nc.c_note, NULL::uuid, 'unique_note_name_match'::text
    FROM name_c nc
   WHERE NOT EXISTS (SELECT 1 FROM pick)
     AND (SELECT count(*) FROM name_c) = 1;
END $function$
;

CREATE OR REPLACE FUNCTION public.commission_partner_has_prior_fund_in(p_partner uuid, p_fund_in_key text, p_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.promissory_commission_rate(p_kind text, p_at timestamp with time zone DEFAULT now())
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT r.rate
    FROM public.promissory_commission_rates r
   WHERE r.kind = p_kind
     AND r.effective_from <= coalesce(p_at, now())
   ORDER BY r.effective_from DESC
   LIMIT 1
$function$
;

CREATE OR REPLACE FUNCTION public.partner_note_rate(p_role text, p_at timestamp with time zone)
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select amount from public.partner_note_rates
   where payee_role = p_role and effective_from <= p_at
   order by effective_from desc limit 1
$function$
;

CREATE OR REPLACE FUNCTION public.payables_guard()
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR NOT (
       has_role(v_uid,'cfo') OR has_role(v_uid,'ceo') OR has_role(v_uid,'coo')
    OR has_role(v_uid,'manager') OR has_role(v_uid,'financial_ops')
    OR has_role(v_uid,'super_admin') OR has_role(v_uid,'cto')
  ) THEN
    RAISE EXCEPTION 'Not authorised to view payables' USING ERRCODE = '42501';
  END IF;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.hr_pay_is_staff_reinvest_portfolio(_portfolio_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.hr_pay_staff_reinvestments where portfolio_id = _portfolio_id);
$function$
;
