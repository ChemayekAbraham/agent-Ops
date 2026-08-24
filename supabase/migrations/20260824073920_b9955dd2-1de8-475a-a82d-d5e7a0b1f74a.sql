-- Shared authorisation helper for the proxy agent directory.
CREATE OR REPLACE FUNCTION public.is_proxy_directory_viewer(_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT _uid IS NOT NULL AND (
    public.has_role(_uid, 'super_admin'::app_role)
    OR public.has_role(_uid, 'coo'::app_role)
    OR public.has_role(_uid, 'manager'::app_role)
    OR public.has_role(_uid, 'partner_ops'::app_role)
  )
$$;
REVOKE ALL ON FUNCTION public.is_proxy_directory_viewer(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_proxy_directory_viewer(uuid) TO authenticated, service_role;

-- Ledger categories that pay a proxy agent.
CREATE OR REPLACE FUNCTION public.proxy_earning_categories()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY['proxy_investment_commission','agent_investment_commission','partner_commission',
               'agent_commission_earned','agent_commission']::text[]
$$;
REVOKE ALL ON FUNCTION public.proxy_earning_categories() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.proxy_earning_categories() TO authenticated, service_role;

-- ── Directory: KPIs + paged rows in ONE round trip ────────────────────────────
CREATE OR REPLACE FUNCTION public.partner_ops_proxy_agent_directory(
  p_search text DEFAULT NULL,
  p_status text DEFAULT 'all',
  p_limit int DEFAULT 60,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lim int := LEAST(GREATEST(COALESCE(p_limit,60),1),200);
  v_off int := GREATEST(COALESCE(p_offset,0),0);
  v_q text := NULLIF(btrim(COALESCE(p_search,'')),'');
  v_total int;
  v_rows jsonb;
  v_kpis jsonb;
BEGIN
  IF NOT public.is_proxy_directory_viewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _pxd(x int) ON COMMIT DROP;

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
     WHERE v_q IS NULL
        OR j.name ILIKE '%'||v_q||'%'
        OR COALESCE(j.phone,'') ILIKE '%'||v_q||'%'
        OR COALESCE(j.email,'') ILIKE '%'||v_q||'%'
        OR COALESCE(j.invite_code,'') ILIKE '%'||v_q||'%'
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
$$;
REVOKE ALL ON FUNCTION public.partner_ops_proxy_agent_directory(text, text, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_proxy_agent_directory(text, text, int, int) TO authenticated, service_role;

-- ── Detail sheet: bio + notes + partners + earnings in ONE round trip ─────────
CREATE OR REPLACE FUNCTION public.partner_ops_proxy_agent_detail(p_agent_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_out jsonb;
BEGIN
  IF NOT public.is_proxy_directory_viewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT jsonb_build_object(
    'bio', (
      SELECT jsonb_build_object(
        'agent_user_id', i.agent_user_id,
        'name', COALESCE(NULLIF(btrim(p.full_name),''), NULLIF(btrim(i.full_name),''), 'Unknown agent'),
        'status', i.status, 'nin', i.nin, 'invite_code', i.invite_code,
        'submitted_at', i.submitted_at, 'approved_at', i.reviewed_at,
        'review_notes', i.review_notes,
        'avatar_url', p.avatar_url,
        'phone', COALESCE(NULLIF(p.phone,''), i.phone),
        'email', p.email, 'district', p.district, 'national_id', p.national_id,
        'joined_at', p.created_at,
        'referrer_name', rp.full_name,
        'lead_name', (SELECT lp.full_name FROM partner_lead_assignments a
                        JOIN profiles lp ON lp.id = a.lead_user_id
                       WHERE a.agent_id = i.agent_user_id AND a.detached_at IS NULL
                       ORDER BY a.attached_at DESC LIMIT 1)
      )
      FROM proxy_agent_identity i
      LEFT JOIN profiles p ON p.id = i.agent_user_id
      LEFT JOIN profiles rp ON rp.id = p.referrer_id
      WHERE i.agent_user_id = p_agent_user_id
    ),
    'notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', pn.id, 'partner_name', pn.partner_name, 'partner_user_id', pn.partner_user_id,
        'phone', COALESCE(NULLIF(pn.phone_number,''), pn.whatsapp_number),
        'amount', pn.amount, 'collected', COALESCE(pn.total_collected,0),
        'status', pn.status, 'contribution_type', pn.contribution_type,
        'deduction_day', pn.deduction_day, 'next_deduction_date', pn.next_deduction_date,
        'created_at', pn.created_at, 'approved_at', pn.approved_at
      ) ORDER BY pn.created_at DESC)
      FROM promissory_notes pn WHERE pn.agent_id = p_agent_user_id
    ), '[]'::jsonb),
    'partners', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'partner_user_id', r.partner_user_id,
        'partner_name', r.partner_name,
        'partner_phone', r.partner_phone,
        'avatar_url', pp.avatar_url,
        'sources', r.sources,
        'linked_at', r.linked_at,
        'portfolios', r.portfolios,
        'total_funded', r.total_funded,
        'last_funded_at', r.last_funded_at,
        'came_in', r.came_in,
        'is_returning', r.is_returning,
        'notes_count', r.notes_count,
        'support_type', CASE WHEN r.notes_count > 0 THEN 'self_support' ELSE 'managed_support' END,
        'portfolio_status', pfs.statuses,
        'active_portfolios', COALESCE(pfs.active_count,0),
        'locked_portfolios', COALESCE(pfs.locked_count,0)
      ) ORDER BY r.total_funded DESC, r.partner_name ASC)
      FROM proxy_agent_partner_rows(p_agent_user_id) r
      LEFT JOIN profiles pp ON pp.id = r.partner_user_id
      LEFT JOIN LATERAL (
        SELECT string_agg(DISTINCT ip.status, ', ') AS statuses,
               COUNT(*) FILTER (WHERE ip.status = 'active')::int AS active_count,
               COUNT(*) FILTER (WHERE ip.status = 'locked')::int AS locked_count
          FROM investor_portfolios ip WHERE ip.investor_id = r.partner_user_id
      ) pfs ON TRUE
    ), '[]'::jsonb),
    'earnings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', gl.id, 'transaction_date', gl.transaction_date, 'amount', gl.amount,
        'category', gl.category, 'description', gl.description, 'linked_party', gl.linked_party
      ) ORDER BY gl.transaction_date DESC)
      FROM (
        SELECT g.id, g.transaction_date, g.amount, g.category, g.description, g.linked_party
          FROM general_ledger g
         WHERE g.user_id = p_agent_user_id
           AND g.ledger_scope = 'wallet'
           AND g.direction = 'cash_in'
           AND g.category = ANY (public.proxy_earning_categories())
           AND COALESCE(g.classification,'production') <> 'admin_correction'
         ORDER BY g.transaction_date DESC
         LIMIT 60
      ) gl
    ), '[]'::jsonb),
    'earnings_total', COALESCE((
      SELECT SUM(g.amount) FROM general_ledger g
       WHERE g.user_id = p_agent_user_id AND g.ledger_scope = 'wallet' AND g.direction = 'cash_in'
         AND g.category = ANY (public.proxy_earning_categories())
         AND COALESCE(g.classification,'production') <> 'admin_correction'
    ), 0)
  ) INTO v_out;

  IF v_out->'bio' IS NULL OR v_out->'bio' = 'null'::jsonb THEN
    RAISE EXCEPTION 'Proxy agent not found';
  END IF;

  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION public.partner_ops_proxy_agent_detail(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_proxy_agent_detail(uuid) TO authenticated, service_role;

-- ── Transfer a proxy agent's book to another approved proxy agent ─────────────
CREATE OR REPLACE FUNCTION public.partner_ops_transfer_proxy_book(
  p_from_agent_id uuid,
  p_to_agent_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')),'');
  v_assignments int := 0;
  v_notes int := 0;
  v_invites int := 0;
BEGIN
  IF NOT public.is_proxy_directory_viewer(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  IF p_from_agent_id IS NULL OR p_to_agent_id IS NULL OR p_from_agent_id = p_to_agent_id THEN
    RAISE EXCEPTION 'Pick two different proxy agents';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Provide a transfer reason of at least 10 characters';
  END IF;
  IF NOT public.is_approved_proxy_agent(p_to_agent_id) THEN
    RAISE EXCEPTION 'The receiving agent is not an approved proxy agent';
  END IF;

  UPDATE proxy_agent_assignments SET agent_id = p_to_agent_id, updated_at = now()
   WHERE agent_id = p_from_agent_id AND beneficiary_role = 'supporter' AND is_active;
  GET DIAGNOSTICS v_assignments = ROW_COUNT;

  UPDATE promissory_notes SET agent_id = p_to_agent_id, updated_at = now()
   WHERE agent_id = p_from_agent_id;
  GET DIAGNOSTICS v_notes = ROW_COUNT;

  UPDATE proxy_partner_invites SET proxy_agent_id = p_to_agent_id
   WHERE proxy_agent_id = p_from_agent_id;
  GET DIAGNOSTICS v_invites = ROW_COUNT;

  INSERT INTO audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (auth.uid(), 'proxy_agent_book_transferred', 'proxy_agent_identity',
          p_from_agent_id::text, v_reason,
          jsonb_build_object('from_agent_id', p_from_agent_id, 'to_agent_id', p_to_agent_id,
                             'assignments_moved', v_assignments, 'notes_moved', v_notes,
                             'invites_moved', v_invites));

  RETURN jsonb_build_object('assignments_moved', v_assignments, 'notes_moved', v_notes,
                            'invites_moved', v_invites, 'to_agent_id', p_to_agent_id);
END;
$$;
REVOKE ALL ON FUNCTION public.partner_ops_transfer_proxy_book(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.partner_ops_transfer_proxy_book(uuid, uuid, text) TO authenticated, service_role;
