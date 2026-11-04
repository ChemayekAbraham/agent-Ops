-- Rollback for 20261023100000_promissory_commission_late_note_and_one_note_per_partner.sql
-- Restores the earner lookup that required the note to be created before the fund-in, and removes the one-note guard and the pay-on-approval trigger.
-- Commission already paid under the new rule (for example Rachel Blessing Nabutiti, 19 Oct fund-in) stays paid; reverse it through the normal ledger reversal path if needed.
DROP TRIGGER IF EXISTS trg_pay_commission_after_note_approval ON public.promissory_notes;
DROP TRIGGER IF EXISTS trg_guard_one_approved_note_per_partner ON public.promissory_notes;
DROP FUNCTION IF EXISTS public.pay_commission_after_note_approval();
DROP FUNCTION IF EXISTS public.guard_one_approved_note_per_partner();
DROP FUNCTION IF EXISTS public.promissory_note_same_partner(public.promissory_notes, public.promissory_notes);

CREATE OR REPLACE FUNCTION public.commission_resolve_earner(p_partner uuid, p_at timestamp with time zone, p_use_lock boolean DEFAULT true)
RETURNS TABLE(earner_id uuid, earner_path text, note_id uuid, assignment_id uuid, basis text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
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
  ), name_c AS (
    SELECT n.agent_id AS c_earner, n.id AS c_note, n.created_at AS c_est
      FROM public.promissory_notes n
     WHERE v_name IS NOT NULL AND position(' ' IN v_name) > 0 AND length(v_name) >= 5
       AND n.agent_id IS NOT NULL AND n.agent_id <> p_partner
       AND coalesce(n.approval_bonus_paid, false) = true
       AND n.created_at <= p_at
       AND NOT EXISTS (SELECT 1 FROM public.pso_note_reversals r WHERE r.note_id = n.id)
       AND lower(regexp_replace(trim(coalesce(n.partner_name,'')), '\s+', ' ', 'g')) = v_name
  ), pick AS (
    SELECT c.c_earner, c.c_path, c.c_note, c.c_asg, 'earliest_relationship_before_fund_in'::text AS b
      FROM c ORDER BY c.c_est, c.c_path LIMIT 1
  )
  SELECT * FROM pick
  UNION ALL
  SELECT nc.c_earner, 'promissory_note'::text, nc.c_note, NULL::uuid, 'unique_note_name_match'::text
    FROM name_c nc
   WHERE NOT EXISTS (SELECT 1 FROM pick)
     AND (SELECT count(*) FROM name_c) = 1;
END $function$;

