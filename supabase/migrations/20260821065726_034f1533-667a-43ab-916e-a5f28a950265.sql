CREATE OR REPLACE FUNCTION public.get_promissory_ops_report(p_from timestamptz DEFAULT NULL, p_to timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_from timestamptz := COALESCE(p_from, '1970-01-01'::timestamptz);
  v_to timestamptz := COALESCE(p_to, now() + interval '1 day');
  v_result jsonb;
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
  -- Indexed candidate pulls (idx_profiles_phone_last9 / idx_profiles_email_lower / pkey)
  cand_phone AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at,
           right(regexp_replace(p.phone, '\D', '', 'g'), 9) AS pk
    FROM profiles p
    WHERE right(regexp_replace(p.phone, '\D', '', 'g'), 9) IN (SELECT k FROM keys)
  ),
  cand_email AS MATERIALIZED (
    SELECT p.id, p.full_name, p.created_at, lower(p.email) AS pem
    FROM profiles p
    WHERE lower(p.email) IN (SELECT em FROM emails)
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
  notes AS MATERIALIZED (
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
      lm.full_name AS lead_partner_name
    FROM nb
    LEFT JOIN profiles ag ON ag.id = nb.agent_id
    LEFT JOIN cand_id bi ON bi.id = nb.partner_user_id
    LEFT JOIN by_phone bk1 ON length(nb.k1) = 9 AND bk1.pk = nb.k1
    LEFT JOIN by_phone bk2 ON length(nb.k2) = 9 AND bk2.pk = nb.k2
    LEFT JOIN by_email be ON nb.em IS NOT NULL AND be.pem = nb.em
    LEFT JOIN lead_map lm ON lm.agent_id = nb.agent_id
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
  )
  SELECT jsonb_build_object(
    'kpis', jsonb_build_object(
      'notes_count', (SELECT count(*) FROM notes),
      'partners_came_in', (SELECT count(came_in_user_id) FROM notes),
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
      'approved_commission_count', (SELECT approved_count FROM commission)
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
        'lead_partner_name', lead_partner_name
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
$fn$;

GRANT EXECUTE ON FUNCTION public.get_promissory_ops_report(timestamptz, timestamptz) TO authenticated, service_role;