DROP FUNCTION IF EXISTS public.partner_ops_proxy_agent_directory(text, text, integer, integer);

CREATE OR REPLACE FUNCTION public.partner_ops_proxy_agent_directory(
  p_search text DEFAULT NULL::text,
  p_status text DEFAULT 'all'::text,
  p_limit integer DEFAULT 60,
  p_offset integer DEFAULT 0,
  p_activated_from date DEFAULT NULL::date,
  p_activated_to date DEFAULT NULL::date,
  p_contact text DEFAULT 'all'::text
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit,60),1),200);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_contact text := COALESCE(NULLIF(btrim(COALESCE(p_contact,'')),''),'all');
  v_total int;
  v_rows jsonb;
  v_kpis jsonb;
BEGIN
  IF NOT public.is_proxy_directory_viewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH agents AS (
    SELECT i.agent_user_id AS id,
           COALESCE(NULLIF(btrim(p.full_name),''), NULLIF(btrim(i.full_name),''), 'Unknown agent') AS name,
           i.status, i.nin, i.invite_code, i.submitted_at, i.reviewed_at, i.review_notes,
           p.avatar_url,
           COALESCE(NULLIF(p.phone,''), i.phone) AS phone,
           p.email, p.district, p.created_at AS joined_at,
           rp.full_name AS referrer_name,
           lp.full_name AS lead_name
      FROM proxy_agent_identity i
      LEFT JOIN profiles p  ON p.id = i.agent_user_id
      LEFT JOIN profiles rp ON rp.id = p.referrer_id
      LEFT JOIN partner_lead_assignments a
             ON a.agent_id = i.agent_user_id AND a.detached_at IS NULL
      LEFT JOIN profiles lp ON lp.id = a.lead_user_id
     WHERE COALESCE(p_status,'all') = 'all' OR i.status = p_status
  ), notes AS (
    SELECT pn.agent_id AS aid,
           COUNT(*)::int AS notes_count,
           COUNT(*) FILTER (WHERE pn.status = 'pending')::int AS notes_pending,
           COUNT(*) FILTER (WHERE pn.status = 'activated')::int AS notes_activated,
           COALESCE(SUM(pn.amount),0) AS notes_amount,
           COALESCE(SUM(pn.total_collected),0) AS notes_collected
      FROM promissory_notes pn
     WHERE pn.agent_id IN (SELECT id FROM agents)
     GROUP BY 1
  ), links AS (
    SELECT si.created_by AS aid, si.activated_user_id AS pid, si.created_at AS at
      FROM supporter_invites si
     WHERE si.created_by IN (SELECT id FROM agents) AND si.activated_user_id IS NOT NULL
    UNION ALL
    SELECT pa.agent_id, pa.beneficiary_id, pa.created_at
      FROM proxy_agent_assignments pa
     WHERE pa.agent_id IN (SELECT id FROM agents) AND pa.beneficiary_role = 'supporter'
       AND pa.is_active AND pa.approval_status = 'approved'
    UNION ALL
    SELECT pr.referrer_id, pr.id, pr.created_at
      FROM profiles pr
     WHERE pr.referrer_id IN (SELECT id FROM agents)
       AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = pr.id AND ur.role = 'supporter')
    UNION ALL
    SELECT ip.agent_id, ip.investor_id, ip.created_at
      FROM investor_portfolios ip
     WHERE ip.agent_id IN (SELECT id FROM agents) AND ip.investor_id IS NOT NULL
    UNION ALL
    SELECT pn.agent_id, pn.partner_user_id, pn.created_at
      FROM promissory_notes pn
     WHERE pn.agent_id IN (SELECT id FROM agents) AND pn.partner_user_id IS NOT NULL
    UNION ALL
    SELECT pi.proxy_agent_id, pi.signed_up_user_id, pi.created_at
      FROM proxy_partner_invites pi
     WHERE pi.proxy_agent_id IN (SELECT id FROM agents) AND pi.signed_up_user_id IS NOT NULL
  ), link_pairs AS (
    SELECT DISTINCT aid, pid FROM links WHERE pid IS NOT NULL
  ), partner_folio AS (
    SELECT ip.investor_id AS pid,
           COUNT(*)::int AS portfolios,
           COALESCE(SUM(ip.investment_amount),0) AS funded
      FROM investor_portfolios ip
     WHERE ip.investor_id IN (SELECT pid FROM link_pairs)
     GROUP BY 1
  ), partners AS (
    SELECT lp.aid,
           COUNT(*)::int AS partners_linked,
           COUNT(*) FILTER (WHERE COALESCE(pf.portfolios,0) > 0)::int AS partners_came_in,
           COALESCE(SUM(pf.funded),0) AS partner_funded
      FROM link_pairs lp
      LEFT JOIN partner_folio pf ON pf.pid = lp.pid
     GROUP BY 1
  ), earnings AS (
    SELECT gl.user_id AS aid, COALESCE(SUM(gl.amount),0) AS earned
      FROM general_ledger gl
     WHERE gl.user_id IN (SELECT id FROM agents)
       AND gl.ledger_scope = 'wallet'
       AND gl.direction = 'cash_in'
       AND gl.category = ANY (public.proxy_earning_categories())
       AND COALESCE(gl.classification,'production') <> 'admin_correction'
     GROUP BY 1
  ), joined AS (
    SELECT a.*,
           COALESCE(n.notes_count,0) AS notes_count,
           COALESCE(n.notes_pending,0) AS notes_pending,
           COALESCE(n.notes_activated,0) AS notes_activated,
           COALESCE(n.notes_amount,0) AS notes_amount,
           COALESCE(n.notes_collected,0) AS notes_collected,
           COALESCE(pt.partners_linked,0) AS partners_linked,
           COALESCE(pt.partners_came_in,0) AS partners_came_in,
           COALESCE(pt.partner_funded,0) AS partner_funded,
           COALESCE(e.earned,0) AS earned
      FROM agents a
      LEFT JOIN notes n ON n.aid = a.id
      LEFT JOIN partners pt ON pt.aid = a.id
      LEFT JOIN earnings e ON e.aid = a.id
  ), filtered AS (
    SELECT * FROM joined j
     WHERE (v_q IS NULL
        OR j.name ILIKE '%'||v_q||'%'
        OR COALESCE(j.phone,'') ILIKE '%'||v_q||'%'
        OR COALESCE(j.email,'') ILIKE '%'||v_q||'%'
        OR COALESCE(j.invite_code,'') ILIKE '%'||v_q||'%')
       AND (p_activated_from IS NULL
        OR (j.reviewed_at IS NOT NULL AND j.reviewed_at >= p_activated_from::timestamptz))
       AND (p_activated_to IS NULL
        OR (j.reviewed_at IS NOT NULL AND j.reviewed_at < (p_activated_to + 1)::timestamptz))
       AND (v_contact = 'all'
        OR (v_contact = 'has_phone' AND NULLIF(btrim(COALESCE(j.phone,'')),'') IS NOT NULL)
        OR (v_contact = 'no_phone'  AND NULLIF(btrim(COALESCE(j.phone,'')),'') IS NULL)
        OR (v_contact = 'has_email' AND NULLIF(btrim(COALESCE(j.email,'')),'') IS NOT NULL)
        OR (v_contact = 'no_email'  AND NULLIF(btrim(COALESCE(j.email,'')),'') IS NULL)
        OR (v_contact = 'has_both'  AND NULLIF(btrim(COALESCE(j.phone,'')),'') IS NOT NULL
                                    AND NULLIF(btrim(COALESCE(j.email,'')),'') IS NOT NULL)
        OR (v_contact = 'missing_any' AND (NULLIF(btrim(COALESCE(j.phone,'')),'') IS NULL
                                        OR NULLIF(btrim(COALESCE(j.email,'')),'') IS NULL)))
  ), page AS (
    SELECT * FROM filtered
     ORDER BY partners_came_in DESC, partners_linked DESC, notes_amount DESC, name ASC
     LIMIT v_lim OFFSET v_off
  )
  SELECT (SELECT COUNT(*)::int FROM filtered),
         COALESCE((SELECT jsonb_agg(jsonb_build_object(
           'agent_user_id', id, 'name', name, 'status', status, 'avatar_url', avatar_url,
           'phone', phone, 'email', email, 'district', district, 'nin', nin,
           'invite_code', invite_code, 'joined_at', joined_at, 'approved_at', reviewed_at,
           'referrer_name', referrer_name, 'lead_name', lead_name,
           'notes_count', notes_count, 'notes_pending', notes_pending,
           'notes_activated', notes_activated, 'notes_amount', notes_amount,
           'notes_collected', notes_collected,
           'partners_linked', partners_linked, 'partners_came_in', partners_came_in,
           'partner_funded', partner_funded, 'earned', earned
         ) ORDER BY partners_came_in DESC, partners_linked DESC, notes_amount DESC, name ASC) FROM page), '[]'::jsonb),
         jsonb_build_object(
           'agents_total', (SELECT COUNT(*)::int FROM joined),
           'agents_approved', (SELECT COUNT(*)::int FROM joined WHERE status = 'approved'),
           'agents_suspended', (SELECT COUNT(*)::int FROM joined WHERE status <> 'approved'),
           'partners_linked', (SELECT COALESCE(SUM(partners_linked),0)::int FROM joined),
           'partners_came_in', (SELECT COALESCE(SUM(partners_came_in),0)::int FROM joined),
           'partner_funded', (SELECT COALESCE(SUM(partner_funded),0) FROM joined),
           'notes_count', (SELECT COALESCE(SUM(notes_count),0)::int FROM joined),
           'notes_pending', (SELECT COALESCE(SUM(notes_pending),0)::int FROM joined),
           'notes_amount', (SELECT COALESCE(SUM(notes_amount),0) FROM joined),
           'notes_collected', (SELECT COALESCE(SUM(notes_collected),0) FROM joined),
           'earned', (SELECT COALESCE(SUM(earned),0) FROM joined),
           'active_producers', (SELECT COUNT(*)::int FROM joined WHERE partners_came_in > 0)
         )
    INTO v_total, v_rows, v_kpis;

  RETURN jsonb_build_object('total', COALESCE(v_total,0), 'limit', v_lim, 'offset', v_off,
                            'rows', v_rows, 'kpis', v_kpis);
END;
$function$;