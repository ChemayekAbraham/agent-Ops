CREATE OR REPLACE FUNCTION public.get_promissory_ops_report(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_from timestamptz := COALESCE(p_from, '1970-01-01'::timestamptz);
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
  v_result jsonb;
  v_rate_creation numeric := public.promissory_commission_rate('portfolio_creation');
  v_rate_topup numeric := public.promissory_commission_rate('portfolio_topup');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF NOT (
    public.is_ops_role(v_uid)
    OR public.has_role(v_uid, 'ceo') OR public.has_role(v_uid, 'coo')
    OR public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'manager')
    OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'partner_ops')
  ) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  WITH nb AS MATERIALIZED (
    SELECT n.*,
      right(regexp_replace(coalesce(n.whatsapp_number,''), '\D', '', 'g'), 9) AS k1,
      right(regexp_replace(coalesce(n.phone_number,''), '\D', '', 'g'), 9) AS k2,
      nullif(lower(trim(coalesce(n.email,''))), '') AS em
    FROM promissory_notes n
    WHERE n.created_at >= v_from AND n.created_at < v_to
  ),
  keys AS MATERIALIZED (
    SELECT DISTINCT k FROM (
      SELECT k1 AS k FROM nb UNION SELECT k2 FROM nb
    ) s WHERE length(k) = 9
  ),
  emails AS MATERIALIZED (
    SELECT DISTINCT em FROM nb WHERE em IS NOT NULL
  ),
  ids AS MATERIALIZED (
    SELECT DISTINCT partner_user_id AS id FROM nb WHERE partner_user_id IS NOT NULL
  ),
  cand_phone AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at,
           right(regexp_replace(p.phone, '\D', '', 'g'), 9) AS pk
    FROM profiles p
    WHERE right(regexp_replace(p.phone, '\D', '', 'g'), 9) IN (SELECT k FROM keys)
  ),
  cand_email AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at, lower(trim(p.email)) AS pem
    FROM profiles p
    WHERE lower(trim(p.email)) IN (SELECT em FROM emails)
  ),
  cand_id AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at
    FROM profiles p
    WHERE p.id IN (SELECT id FROM ids)
  ),
  by_phone AS (
    SELECT DISTINCT ON (pk) pk, id, full_name, created_at
    FROM cand_phone ORDER BY pk, created_at ASC
  ),
  by_email AS (
    SELECT DISTINCT ON (pem) pem, id, full_name, created_at
    FROM cand_email ORDER BY pem, created_at ASC
  ),
  lead_map AS (
    SELECT DISTINCT ON (pla.agent_id) pla.agent_id, pr.full_name
    FROM partner_lead_assignments pla
    JOIN profiles pr ON pr.id = pla.lead_user_id
    WHERE pla.detached_at IS NULL
    ORDER BY pla.agent_id, pla.attached_at DESC
  ),
  matched AS MATERIALIZED (
    SELECT nb.*,
      ag.full_name AS agent_name, ag.phone AS agent_phone,
      COALESCE(bi.id, bk1.id, bk2.id, be.id) AS came_in_user_id,
      CASE
        WHEN bi.id IS NOT NULL THEN bi.full_name
        WHEN bk1.id IS NOT NULL THEN bk1.full_name
        WHEN bk2.id IS NOT NULL THEN bk2.full_name
        ELSE be.full_name
      END AS came_in_name,
      CASE
        WHEN bi.id IS NOT NULL THEN bi.created_at
        WHEN bk1.id IS NOT NULL THEN bk1.created_at
        WHEN bk2.id IS NOT NULL THEN bk2.created_at
        ELSE be.created_at
      END AS came_in_at,
      CASE
        WHEN bk1.id IS NOT NULL THEN 'whatsapp_number'
        WHEN bk2.id IS NOT NULL THEN 'phone_number'
        WHEN be.id IS NOT NULL THEN 'email'
        WHEN bi.id IS NOT NULL THEN 'linked_account'
        ELSE NULL
      END AS came_in_match_basis,
      CASE
        WHEN bk1.id IS NOT NULL THEN nb.whatsapp_number
        WHEN bk2.id IS NOT NULL THEN nb.phone_number
        WHEN be.id IS NOT NULL THEN nb.email
        WHEN bi.id IS NOT NULL THEN nb.partner_user_id::text
        ELSE NULL
      END AS came_in_matched_value,
      lm.full_name AS lead_partner_name
    FROM nb
    LEFT JOIN profiles ag ON ag.id = nb.agent_id
    LEFT JOIN cand_id bi ON bi.id = nb.partner_user_id
    LEFT JOIN by_phone bk1 ON length(nb.k1) = 9 AND bk1.pk = nb.k1
    LEFT JOIN by_phone bk2 ON length(nb.k2) = 9 AND bk2.pk = nb.k2
    LEFT JOIN by_email be ON nb.em IS NOT NULL AND be.pem = nb.em
    LEFT JOIN lead_map lm ON lm.agent_id = nb.agent_id
  ),
  partner_ids AS MATERIALIZED (
    SELECT DISTINCT came_in_user_id AS id FROM matched WHERE came_in_user_id IS NOT NULL
  ),
  commission_rollup AS MATERIALIZED (
    SELECT e.note_id,
      COALESCE(sum(e.amount) FILTER (WHERE e.status = 'paid' AND e.kind = 'portfolio_creation'), 0) AS creation_commission_paid,
      COALESCE(sum(e.amount) FILTER (WHERE e.status = 'paid' AND e.kind = 'portfolio_topup'), 0) AS topup_commission_paid,
      COALESCE(sum(e.amount) FILTER (WHERE e.status = 'paid'), 0) AS commission_paid_total,
      count(*) FILTER (WHERE e.status = 'paid' AND e.kind = 'portfolio_topup')::int AS topup_commission_count,
      max(e.created_at) FILTER (WHERE e.status = 'paid') AS last_commission_at
    FROM promissory_commission_events e
    WHERE e.note_id IN (SELECT id FROM nb)
    GROUP BY e.note_id
  ),
  portfolio_rollup AS MATERIALIZED (
    SELECT ip.investor_id,
      count(*)::int AS portfolio_count,
      count(*) FILTER (WHERE ip.status = 'active')::int AS active_count,
      count(*) FILTER (WHERE ip.status <> 'active')::int AS pending_count,
      COALESCE(sum(ip.investment_amount), 0) AS portfolio_amount,
      COALESCE(sum(ip.investment_amount) FILTER (WHERE ip.status = 'active'), 0) AS active_amount,
      min(ip.created_at) AS first_portfolio_at
    FROM investor_portfolios ip
    WHERE ip.investor_id IN (SELECT id FROM partner_ids)
    GROUP BY ip.investor_id
  ),
  commitment_rollup AS MATERIALIZED (
    SELECT c.promissory_note_id AS note_id,
      c.partner_id,
      count(*)::int AS self_commitment_count,
      count(*) FILTER (WHERE c.status IN ('active','funded','completed'))::int AS self_commitment_active_count,
      count(*) FILTER (WHERE c.status NOT IN ('active','funded','completed','cancelled','rejected'))::int AS self_commitment_pending_count,
      COALESCE(sum(c.committed_amount), 0) AS self_commitment_amount,
      COALESCE(sum(c.committed_amount) FILTER (WHERE c.status IN ('active','funded','completed')), 0) AS self_commitment_active_amount,
      min(c.created_at) AS self_first_commitment_at,
      jsonb_agg(jsonb_build_object(
        'commitment_id', c.id,
        'status', c.status,
        'amount', c.committed_amount,
        'lines', c.lines_count,
        'created_at', c.created_at,
        'updated_at', c.updated_at
      ) ORDER BY c.created_at DESC) AS self_commitments
    FROM partner_self_commitments c
    WHERE c.promissory_note_id IN (SELECT id FROM nb)
      AND c.partner_id IN (SELECT id FROM partner_ids)
    GROUP BY c.promissory_note_id, c.partner_id
  ),
  reserved_rollup AS MATERIALIZED (
    SELECT i.note_id,
      count(*)::int AS reserved_plans,
      COALESCE(sum(i.amount), 0) AS reserved_amount
    FROM promissory_note_plan_intents i
    WHERE i.note_id IN (SELECT id FROM nb)
      AND i.status IN ('reserved','funded')
    GROUP BY i.note_id
  ),
  notes AS MATERIALIZED (
    SELECT m.*,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_count, 0)
           ELSE COALESCE(pr.portfolio_count, 0)
      END AS portfolio_count,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_active_count, 0)
           ELSE COALESCE(pr.active_count, 0)
      END AS portfolio_active_count,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_pending_count, 0)
           ELSE COALESCE(pr.pending_count, 0)
      END AS portfolio_pending_count,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_amount, 0)
           ELSE COALESCE(pr.portfolio_amount, 0)
      END AS portfolio_amount,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN COALESCE(cr.self_commitment_active_amount, 0)
           ELSE COALESCE(pr.active_amount, 0)
      END AS portfolio_active_amount,
      CASE WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
           THEN cr.self_first_commitment_at
           ELSE pr.first_portfolio_at
      END AS first_portfolio_at,
      COALESCE(cr.self_commitment_count, 0) AS self_commitment_count,
      COALESCE(cr.self_commitment_pending_count, 0) AS self_commitment_pending_count,
      COALESCE(cr.self_commitment_active_count, 0) AS self_commitment_active_count,
      COALESCE(cr.self_commitment_amount, 0) AS self_commitment_amount,
      COALESCE(cr.self_commitment_active_amount, 0) AS self_commitment_active_amount,
      COALESCE(cr.self_commitments, '[]'::jsonb) AS self_commitments,
      COALESCE(rr.reserved_plans, 0) AS reserved_plans,
      COALESCE(rr.reserved_amount, 0) AS reserved_amount,
      COALESCE(comm.creation_commission_paid, 0) AS creation_commission_paid,
      COALESCE(comm.topup_commission_paid, 0) AS topup_commission_paid,
      COALESCE(comm.commission_paid_total, 0) AS commission_paid_total,
      COALESCE(comm.topup_commission_count, 0) AS topup_commission_count,
      comm.last_commission_at,
      CASE
        WHEN m.came_in_user_id IS NULL THEN 'not_registered'
        WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
             AND COALESCE(cr.self_commitment_active_count, 0) > 0 THEN 'portfolio_active'
        WHEN COALESCE(m.support_mode, 'existing_support') = 'self_support'
             AND COALESCE(cr.self_commitment_pending_count, 0) > 0 THEN 'portfolio_pending'
        WHEN COALESCE(m.support_mode, 'existing_support') <> 'self_support'
             AND COALESCE(pr.active_count, 0) > 0 THEN 'portfolio_active'
        WHEN COALESCE(m.support_mode, 'existing_support') <> 'self_support'
             AND COALESCE(pr.pending_count, 0) > 0 THEN 'portfolio_pending'
        ELSE 'came_in'
      END AS journey_stage
    FROM matched m
    LEFT JOIN portfolio_rollup pr ON pr.investor_id = m.came_in_user_id
    LEFT JOIN commitment_rollup cr ON cr.note_id = m.id AND cr.partner_id = m.came_in_user_id
    LEFT JOIN reserved_rollup rr ON rr.note_id = m.id
    LEFT JOIN commission_rollup comm ON comm.note_id = m.id
  ),
  agent_rollup AS (
    SELECT agent_id,
      count(*)::int AS notes_count,
      count(came_in_user_id)::int AS partners_count,
      COALESCE(sum(GREATEST(amount - total_collected, 0)) FILTER (WHERE status IN ('pending','activated')), 0) AS amount_expected,
      COALESCE(sum(total_collected), 0) AS amount_collected,
      max(lead_partner_name) AS lead_partner_name
    FROM notes GROUP BY agent_id
  ),
  proxies AS MATERIALIZED (
    SELECT pai.agent_user_id, pai.full_name, pai.phone, pai.status,
      COALESCE(pai.captured_at, pai.submitted_at) AS joined_at,
      pai.invite_code, pai.nin
    FROM proxy_agent_identity pai
  ),
  commission AS (
    SELECT
      COALESCE(sum(amount) FILTER (WHERE status = 'pending'), 0) AS pending_amount,
      count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
      COALESCE(sum(amount) FILTER (WHERE status = 'approved'), 0) AS approved_amount,
      count(*) FILTER (WHERE status = 'approved')::int AS approved_count
    FROM agent_commission_payouts
    WHERE created_at >= v_from AND created_at < v_to
  ),
  self_support AS (
    SELECT
      count(*)::int AS tenant_lines,
      count(DISTINCT partner_id)::int AS partner_count,
      COALESCE(sum(principal), 0) AS committed_principal
    FROM partner_self_funding_lines
    WHERE status IN ('active','committed')
  )
  SELECT jsonb_build_object(
    'rates', jsonb_build_object(
      'portfolio_creation', v_rate_creation,
      'portfolio_topup', v_rate_topup
    ),
    'kpis', jsonb_build_object(
      'notes_count', (SELECT count(*) FROM notes),
      'partners_came_in', (SELECT count(came_in_user_id) FROM notes),
      'partners_with_portfolio', (SELECT count(*) FROM notes WHERE portfolio_count > 0),
      'partners_portfolio_pending', (SELECT count(*) FROM notes WHERE journey_stage = 'portfolio_pending'),
      'partners_portfolio_active', (SELECT count(*) FROM notes WHERE journey_stage = 'portfolio_active'),
      'receivable', (SELECT COALESCE(sum(GREATEST(amount - total_collected, 0)) FILTER (WHERE status IN ('pending','activated')), 0) FROM notes),
      'promised_total', (SELECT COALESCE(sum(amount), 0) FROM notes),
      'fulfilled_total', (SELECT COALESCE(sum(total_collected), 0) FROM notes),
      'approved_notes', (SELECT count(*) FROM notes WHERE approved_at IS NOT NULL),
      'proxy_agents', (SELECT count(*) FROM proxies),
      'proxies_approved', (SELECT count(*) FROM proxies WHERE status = 'approved'),
      'proxies_pending', (SELECT count(*) FROM proxies WHERE status <> 'approved'),
      'lead_attachments', (SELECT count(*) FROM partner_lead_assignments WHERE detached_at IS NULL),
      'pending_commission', (SELECT pending_amount FROM commission),
      'pending_commission_count', (SELECT pending_count FROM commission),
      'approved_commission', (SELECT approved_amount FROM commission),
      'approved_commission_count', (SELECT approved_count FROM commission),
      'promissory_creation_commission_paid', (SELECT COALESCE(sum(creation_commission_paid), 0) FROM notes),
      'promissory_topup_commission_paid', (SELECT COALESCE(sum(topup_commission_paid), 0) FROM notes),
      'promissory_commission_paid_total', (SELECT COALESCE(sum(commission_paid_total), 0) FROM notes),
      'self_supporting_tenants', (SELECT tenant_lines FROM self_support),
      'self_supporting_partners', (SELECT partner_count FROM self_support),
      'self_support_committed', (SELECT committed_principal FROM self_support)
    ),
    'notes', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id,
        'agent_id', agent_id,
        'agent_name', COALESCE(agent_name, 'Unknown Agent'),
        'agent_phone', agent_phone,
        'partner_name', partner_name,
        'whatsapp_number', whatsapp_number,
        'phone_number', phone_number,
        'email', email,
        'amount', amount,
        'total_collected', total_collected,
        'outstanding', GREATEST(amount - total_collected, 0),
        'contribution_type', contribution_type,
        'deduction_day', deduction_day,
        'next_deduction_date', next_deduction_date,
        'status', status,
        'created_at', created_at,
        'approved_at', approved_at,
        'approval_bonus_paid', approval_bonus_paid,
        'partner_user_id', partner_user_id,
        'came_in', came_in_user_id IS NOT NULL,
        'came_in_user_id', came_in_user_id,
        'came_in_name', came_in_name,
        'came_in_at', came_in_at,
        'came_in_match_basis', came_in_match_basis,
        'came_in_matched_value', came_in_matched_value,
        'lead_partner_name', lead_partner_name,
        'support_mode', COALESCE(support_mode, 'existing_support'),
        'reserved_plans', reserved_plans,
        'reserved_amount', reserved_amount,
        'journey_stage', journey_stage,
        'portfolio_count', portfolio_count,
        'portfolio_active_count', portfolio_active_count,
        'portfolio_pending_count', portfolio_pending_count,
        'portfolio_amount', portfolio_amount,
        'portfolio_active_amount', portfolio_active_amount,
        'first_portfolio_at', first_portfolio_at,
        'self_commitment_count', self_commitment_count,
        'self_commitment_pending_count', self_commitment_pending_count,
        'self_commitment_active_count', self_commitment_active_count,
        'self_commitment_amount', self_commitment_amount,
        'self_commitment_active_amount', self_commitment_active_amount,
        'self_commitments', self_commitments,
        'commission_creation_rate', v_rate_creation,
        'commission_topup_rate', v_rate_topup,
        'creation_commission_paid', creation_commission_paid,
        'topup_commission_paid', topup_commission_paid,
        'commission_paid_total', commission_paid_total,
        'topup_commission_count', topup_commission_count,
        'last_commission_at', last_commission_at,
        'creation_commission_expected', ROUND(COALESCE(portfolio_amount, 0) * v_rate_creation)
      ) ORDER BY created_at DESC) FROM notes
    ), '[]'::jsonb),
    'proxy_agents', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'agent_user_id', pr.agent_user_id,
        'name', COALESCE(pf.full_name, pr.full_name, 'Unnamed agent'),
        'phone', COALESCE(pf.phone, pr.phone),
        'email', pf.email,
        'avatar_url', pf.avatar_url,
        'district', pf.district,
        'region', pf.region,
        'nin', pr.nin,
        'invite_code', pr.invite_code,
        'status', pr.status,
        'joined_at', pr.joined_at,
        'notes_count', COALESCE(ar.notes_count, 0),
        'partners_count', COALESCE(ar.partners_count, 0),
        'lead_partner_name', ar.lead_partner_name,
        'amount_expected', COALESCE(ar.amount_expected, 0),
        'amount_collected', COALESCE(ar.amount_collected, 0)
      ) ORDER BY COALESCE(ar.notes_count, 0) DESC, pr.joined_at DESC NULLS LAST)
      FROM proxies pr
      LEFT JOIN agent_rollup ar ON ar.agent_id = pr.agent_user_id
      LEFT JOIN profiles pf ON pf.id = pr.agent_user_id
    ), '[]'::jsonb)
  ) INTO v_result;

  RETURN v_result;
END;
$function$;