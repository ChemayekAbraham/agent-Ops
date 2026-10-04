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
        'self_commitments', self_commitments
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

CREATE OR REPLACE FUNCTION public.smoke_promissory_support_modes()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_result jsonb := '[]'::jsonb;
  v_stage text := 'init';
  v_agent uuid := '00000000-0000-4000-8000-00000000d203';
  v_self_user uuid := '00000000-0000-4000-8000-00000000d201';
  v_existing_user uuid := '00000000-0000-4000-8000-00000000d202';
  v_tenant uuid := '00000000-0000-4000-8000-00000000d204';
  v_landlord uuid := '00000000-0000-4000-8000-00000000d205';
  v_self_note uuid := '00000000-0000-4000-8000-00000000d206';
  v_existing_note uuid := '00000000-0000-4000-8000-00000000d207';
  v_rent_request uuid := '00000000-0000-4000-8000-00000000d208';
  v_commitment uuid;
  v_line uuid;
  v_self_context jsonb;
  v_existing_context jsonb;
  v_report jsonb;
  v_self_report_note jsonb;
  v_event_count int;
BEGIN
  BEGIN
    v_stage := 'seed_auth_users';
    INSERT INTO auth.users(id, email, created_at, updated_at, email_confirmed_at, raw_user_meta_data)
    VALUES
      (v_agent, 'promissory-smoke-agent@example.invalid', now(), now(), now(), '{}'::jsonb),
      (v_self_user, 'promissory-smoke-self@example.invalid', now(), now(), now(), '{}'::jsonb),
      (v_existing_user, 'promissory-smoke-existing@example.invalid', now(), now(), now(), '{}'::jsonb),
      (v_tenant, 'promissory-smoke-tenant@example.invalid', now(), now(), now(), '{}'::jsonb),
      (v_landlord, 'promissory-smoke-landlord@example.invalid', now(), now(), now(), '{}'::jsonb)
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now();

    v_stage := 'seed_base_profiles';
    INSERT INTO public.profiles(id, full_name, phone, email, role, created_at, updated_at)
    VALUES
      (v_agent, 'Rollback Promissory Agent', '0709999203', 'promissory-smoke-agent@example.invalid', 'agent', now(), now()),
      (v_tenant, 'Rollback Promissory Tenant', '0709999204', 'promissory-smoke-tenant@example.invalid', 'tenant', now(), now()),
      (v_landlord, 'Rollback Promissory Landlord', '0709999205', 'promissory-smoke-landlord@example.invalid', 'landlord', now(), now())
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, email = EXCLUDED.email, role = EXCLUDED.role, updated_at = now();

    v_stage := 'seed_rent_request';
    INSERT INTO public.rent_requests(
      id, tenant_id, landlord_id, agent_id, amount, daily_amount, status,
      tenant_name, tenant_phone, property_location, lease_start_date, lease_end_date,
      next_due_date, request_latitude, request_longitude, tenant_photo_url, created_at, updated_at
    ) VALUES (
      v_rent_request, v_tenant, v_landlord, v_agent, 100000, 3334, 'approved',
      'Rollback Promissory Tenant', '0709999204', 'Rollback Smoke House', current_date, current_date + 30,
      current_date + 30, 0, 0, 'https://example.invalid/tenant.jpg', now(), now()
    ) ON CONFLICT (id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      landlord_id = EXCLUDED.landlord_id,
      agent_id = EXCLUDED.agent_id,
      amount = EXCLUDED.amount,
      daily_amount = EXCLUDED.daily_amount,
      status = EXCLUDED.status,
      tenant_name = EXCLUDED.tenant_name,
      tenant_phone = EXCLUDED.tenant_phone,
      property_location = EXCLUDED.property_location,
      lease_start_date = EXCLUDED.lease_start_date,
      lease_end_date = EXCLUDED.lease_end_date,
      next_due_date = EXCLUDED.next_due_date,
      request_latitude = EXCLUDED.request_latitude,
      request_longitude = EXCLUDED.request_longitude,
      tenant_photo_url = EXCLUDED.tenant_photo_url,
      updated_at = now();

    v_stage := 'seed_promissory_notes_before_partner_registration';
    INSERT INTO public.promissory_notes(id, agent_id, partner_name, whatsapp_number, phone_number, email, amount, status, support_mode)
    VALUES
      (v_self_note, v_agent, 'Rollback Self Partner', '0709999201', '0709999201', 'promissory-smoke-self@example.invalid', 100000, 'pending', 'self_support'),
      (v_existing_note, v_agent, 'Rollback Existing Partner', '0709999202', '0709999202', 'promissory-smoke-existing@example.invalid', 100000, 'pending', 'existing_support')
    ON CONFLICT (id) DO UPDATE SET
      agent_id = EXCLUDED.agent_id,
      partner_name = EXCLUDED.partner_name,
      whatsapp_number = EXCLUDED.whatsapp_number,
      phone_number = EXCLUDED.phone_number,
      email = EXCLUDED.email,
      amount = EXCLUDED.amount,
      status = EXCLUDED.status,
      support_mode = EXCLUDED.support_mode,
      partner_user_id = NULL,
      updated_at = now();

    v_stage := 'reserve_selected_rent_plan';
    INSERT INTO public.promissory_note_plan_intents(note_id, rent_request_id, agent_id, amount, status)
    VALUES (v_self_note, v_rent_request, v_agent, 100000, 'reserved')
    ON CONFLICT (note_id, rent_request_id) DO UPDATE SET status = EXCLUDED.status, amount = EXCLUDED.amount, updated_at = now();

    v_stage := 'partner_registration_autolink';
    INSERT INTO public.profiles(id, full_name, phone, email, role, created_at, updated_at)
    VALUES
      (v_self_user, 'Rollback Self Partner', '0709999201', 'promissory-smoke-self@example.invalid', 'supporter', now(), now()),
      (v_existing_user, 'Rollback Existing Partner', '0709999202', 'promissory-smoke-existing@example.invalid', 'supporter', now(), now())
    ON CONFLICT (id) DO UPDATE SET full_name = EXCLUDED.full_name, phone = EXCLUDED.phone, email = EXCLUDED.email, role = EXCLUDED.role, updated_at = now();

    IF NOT EXISTS (SELECT 1 FROM public.promissory_notes WHERE id = v_self_note AND partner_user_id = v_self_user) THEN
      RAISE EXCEPTION 'AUTO_LINK_FAILED_SELF';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.promissory_notes WHERE id = v_existing_note AND partner_user_id = v_existing_user) THEN
      RAISE EXCEPTION 'AUTO_LINK_FAILED_EXISTING';
    END IF;
    v_result := v_result || jsonb_build_object('step','registration_came_in_autolinked','pass',true);

    v_stage := 'support_mode_context';
    v_self_context := public.promissory_self_support_context(v_self_user);
    v_existing_context := public.promissory_self_support_context(v_existing_user);
    v_result := v_result || jsonb_build_object(
      'step','support_mode_context',
      'pass', COALESCE((v_self_context->>'required')::boolean,false)
              AND NOT COALESCE((v_existing_context->>'required')::boolean,false)
              AND COALESCE((v_self_context->>'reserved_plans')::int,0) = 1
              AND COALESCE((v_self_context->>'reserved_amount')::numeric,0) = 100000
    );

    v_stage := 'normal_portfolio_blocked_for_self_support';
    BEGIN
      INSERT INTO public.investor_portfolios(
        investor_id, agent_id, portfolio_code, investment_amount, duration_months,
        roi_percentage, roi_mode, status, portfolio_pin, activation_token
      ) VALUES (v_self_user, v_agent, 'SMOKE-SELF-BLOCKED', 100000, 1, 15, 'monthly_payout', 'pending_ops_approval', '0000', gen_random_uuid());
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass',false);
    EXCEPTION WHEN check_violation THEN
      v_result := v_result || jsonb_build_object('step','normal_portfolio_blocked','pass', SQLERRM LIKE 'PROMISSORY_SELF_SUPPORT_REQUIRED%');
    END;

    v_stage := 'normal_portfolio_allowed_for_existing_support';
    INSERT INTO public.investor_portfolios(
      investor_id, agent_id, portfolio_code, investment_amount, duration_months,
      roi_percentage, roi_mode, status, portfolio_pin, activation_token
    ) VALUES (v_existing_user, v_agent, 'SMOKE-EXISTING-OK', 100000, 1, 15, 'monthly_payout', 'pending_ops_approval', '0000', gen_random_uuid());
    v_result := v_result || jsonb_build_object('step','existing_support_normal_portfolio_allowed','pass',true);

    v_stage := 'dedicated_self_support_commitment_and_portfolio';
    INSERT INTO public.partner_self_commitments(
      partner_id, committed_amount, term_months, monthly_rate, lines_count,
      idempotency_key, status, promissory_note_id
    ) VALUES (
      v_self_user, 100000, 1, 15, 1,
      'smoke-self-support-' || v_self_note::text, 'pending_ops_approval', v_self_note
    ) RETURNING id INTO v_commitment;

    INSERT INTO public.partner_self_funding_lines(
      commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months, status
    ) VALUES (v_commitment, v_self_user, v_rent_request, 100000, 15, 1, 'committed')
    RETURNING id INTO v_line;

    UPDATE public.rent_requests
       SET self_funding_partner_id = v_self_user,
           self_funding_line_id = v_line,
           updated_at = now()
     WHERE id = v_rent_request;

    INSERT INTO public.investor_portfolios(
      investor_id, agent_id, portfolio_code, investment_amount, duration_months,
      roi_percentage, roi_mode, status, portfolio_pin, activation_token
    ) VALUES (v_self_user, v_agent, 'SMOKE-SELF-OK', 100000, 1, 15, 'monthly_payout', 'pending_ops_approval', '0000', gen_random_uuid());

    UPDATE public.promissory_note_plan_intents
       SET status = 'funded', commitment_id = v_commitment, updated_at = now()
     WHERE note_id = v_self_note AND rent_request_id = v_rent_request;

    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('promissory.self_support.portfolio_created', v_self_user, 'promissory_notes', v_self_note,
      'Smoke self-support portfolio audit event', jsonb_build_object('commitment_id', v_commitment, 'line_id', v_line, 'smoke', true));

    IF NOT EXISTS (
      SELECT 1 FROM public.rent_requests
      WHERE id = v_rent_request
        AND self_funding_partner_id = v_self_user
        AND self_funding_line_id = v_line
    ) THEN
      RAISE EXCEPTION 'RENT_PLAN_NOT_ATTACHED_TO_SELF_SUPPORT_LINE';
    END IF;
    v_result := v_result || jsonb_build_object('step','rent_plan_attached_to_self_support_line','pass',true);

    v_stage := 'cfo_report_self_support_status';
    PERFORM set_config('request.jwt.claim.sub', v_agent::text, true);
    v_report := public.get_promissory_ops_report(now() - interval '1 hour', now() + interval '1 hour');
    SELECT n INTO v_self_report_note
    FROM jsonb_array_elements(v_report->'notes') AS n
    WHERE n->>'id' = v_self_note::text
    LIMIT 1;

    IF v_self_report_note IS NULL THEN
      RAISE EXCEPTION 'CFO_REPORT_NOTE_MISSING';
    END IF;
    IF v_self_report_note->>'journey_stage' <> 'portfolio_pending' THEN
      RAISE EXCEPTION 'CFO_REPORT_STAGE_WRONG: %', v_self_report_note->>'journey_stage';
    END IF;
    IF COALESCE((v_self_report_note->>'self_commitment_count')::int,0) <> 1
       OR COALESCE((v_self_report_note->>'portfolio_count')::int,0) <> 1
       OR COALESCE((v_self_report_note->>'portfolio_amount')::numeric,0) <> 100000 THEN
      RAISE EXCEPTION 'CFO_REPORT_SELF_SUPPORT_ROLLUP_WRONG';
    END IF;
    v_result := v_result || jsonb_build_object('step','cfo_report_shows_self_support_portfolio_pending','pass',true);

    v_stage := 'audit_event_visibility';
    SELECT count(*) INTO v_event_count
    FROM public.system_events
    WHERE event_type = 'promissory.self_support.portfolio_created'
      AND related_entity_id = v_self_note;
    IF v_event_count < 1 THEN
      RAISE EXCEPTION 'AUDIT_EVENT_MISSING';
    END IF;
    v_result := v_result || jsonb_build_object('step','audit_event_written_for_cfo_trace','pass',true);

    RAISE EXCEPTION 'SMOKE_ROLLBACK' USING DETAIL = v_result::text;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM = 'SMOKE_ROLLBACK' THEN
      RETURN jsonb_build_object('rolled_back', true, 'results', PG_EXCEPTION_DETAIL::jsonb);
    END IF;
    RETURN jsonb_build_object('rolled_back', true, 'pass', false, 'stage', v_stage, 'error', SQLERRM, 'results', v_result);
  END;
END;
$function$;

REVOKE ALL ON FUNCTION public.smoke_promissory_support_modes() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.smoke_promissory_support_modes() TO service_role;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sandbox_exec') THEN
    GRANT EXECUTE ON FUNCTION public.smoke_promissory_support_modes() TO sandbox_exec;
  END IF;
END $$;