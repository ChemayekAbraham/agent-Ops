-- Rollback for 20261115090000_co_support_phase1.sql.
-- Puts back the exact live bodies of the four changed objects and removes every
-- co-support object. Refuses while any co-supported plan has live funding:
-- unwinding real money needs its own plan first.
SET client_encoding = 'UTF8';
SET lock_timeout = '5s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines
              WHERE co_support_id IS NOT NULL AND status <> 'cancelled') THEN
    RAISE EXCEPTION 'ROLLBACK_REFUSED: co-supported plans have live funding lines';
  END IF;
END $$;

-- 1. Original bodies
CREATE OR REPLACE FUNCTION public.psm_disburse_landlord_float(p_commitment_id uuid, p_topup_id uuid DEFAULT NULL::uuid, p_rent_request_ids uuid[] DEFAULT NULL::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid;
  v_line record;
  v_agent uuid;
  v_alloc uuid;
  v_alloc_ids uuid[] := ARRAY[]::uuid[];
  v_landlord_name text;
  v_ref text;
  v_funded integer := 0;
  v_skipped integer := 0;
  v_total numeric := 0;
  v_notices integer := 0;
  v_treasury jsonb;
  v_treasury_recognised integer := 0;
  v_pool_entry uuid;          -- Landlord Float Pool
  v_pool_drawn numeric := 0;  -- Landlord Float Pool
  v_pool_pid uuid;            -- Landlord Float Pool (self-managed top-ups)
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.psm_is_topup_reviewer(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  SELECT partner_id INTO v_partner FROM public.partner_self_commitments WHERE id = p_commitment_id;
  IF v_partner IS NULL THEN
    RETURN jsonb_build_object('funded', 0, 'skipped', 0, 'reason', 'commitment_not_found');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-float-' || p_commitment_id::text));

  -- Landlord Float Pool: a self-managed top-up's new tenant lines are reserved
  -- as self-support TOP-UP entries — only once the top-up's own wallet debit
  -- (key psm-topup-<id>) exists, and only for a pool_eligible portfolio
  -- (checked inside landlord_pool_reserve_increment).
  IF p_topup_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.general_ledger g
                  WHERE g.idempotency_key = 'psm-topup-' || p_topup_id::text) THEN
    SELECT fp.portfolio_id INTO v_pool_pid FROM public.funder_pending_portfolios fp
     WHERE fp.commitment_id = p_commitment_id ORDER BY fp.created_at DESC LIMIT 1;
  END IF;

  FOR v_line IN
    SELECT l.id AS line_id,
           -- the rent goes to landlord float; the partner's principal may include the agent fee
           COALESCE(l.rent_amount, l.principal) AS principal,
           l.rent_request_id,
           rr.status AS rr_status,
           rr.tenant_id,
           rr.landlord_id,
           COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id,
           ld.name AS landlord_name,
           COALESCE(ld.mobile_money_number, ld.phone) AS landlord_phone
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = p_commitment_id
       AND (p_rent_request_ids IS NULL OR l.rent_request_id = ANY(p_rent_request_ids))
     ORDER BY l.created_at
  LOOP
    v_agent := v_line.agent_id;

    IF v_agent IS NULL THEN
      v_skipped := v_skipped + 1;
      PERFORM public.psm_audit(auth.uid(), v_partner, 'float_disbursement_skipped',
        'partner_self_funding_lines', v_line.line_id,
        jsonb_build_object('reason', 'no_agent_assigned', 'rent_request_id', v_line.rent_request_id));
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.agent_landlord_float_allocations a
       WHERE a.rent_request_id = v_line.rent_request_id
         AND a.status IN ('open','partially_paid')
    ) THEN
      v_skipped := v_skipped + 1;
      CONTINUE;
    END IF;

    v_landlord_name := COALESCE(v_line.landlord_name, 'Unknown Landlord');
    v_ref := 'PSF-' || upper(substr(replace(v_line.line_id::text, '-', ''), 1, 8));

    INSERT INTO public.agent_landlord_float_allocations (
      agent_id, tenant_id, rent_request_id, landlord_id,
      landlord_name, landlord_phone, allocated_amount, source,
      funded_by_partner_id, funding_reference
    ) VALUES (
      v_agent, v_line.tenant_id, v_line.rent_request_id, v_line.landlord_id,
      v_landlord_name, v_line.landlord_phone, v_line.principal, 'partner_self_funding',
      v_partner, v_ref
    )
    RETURNING id INTO v_alloc;

    v_alloc_ids := v_alloc_ids || v_alloc;

    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object(
          'direction','cash_out','amount', v_line.principal,
          'category','rent_disbursement','ledger_scope','platform',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Partner self-managed funding released to agent landlord float for ' || v_landlord_name
        ),
        jsonb_build_object(
          'direction','cash_in','amount', v_line.principal,
          'category','rent_receivable_created','ledger_scope','bridge',
          'source_table','partner_self_funding_lines','source_id', v_line.line_id,
          'reference_id', v_ref,
          'user_id', v_agent,
          'linked_party', v_partner::text,
          'description','Landlord float credited (partner-funded) - ' || v_landlord_name
        )
      ),
      idempotency_key := 'psm-float-' || v_line.line_id::text
    );

    -- Landlord Float Pool (self-managed top-ups): reserve this top-up line first.
    IF v_pool_pid IS NOT NULL THEN
      BEGIN
        PERFORM public.landlord_pool_reserve_increment(v_pool_pid, 'topup', v_line.principal,
          'partner_self_funding_lines', v_line.line_id, 'psm_self_topup');
      EXCEPTION WHEN OTHERS THEN
        INSERT INTO public.landlord_pool_exceptions (portfolio_id, operation, caller, reason, detail)
        VALUES (v_pool_pid, 'reserve', 'psm_self_topup', SQLERRM,
                jsonb_build_object('sqlstate', SQLSTATE, 'topup_id', p_topup_id, 'line_id', v_line.line_id));
      END;
    END IF;

    -- Landlord Float Pool: this tenant line was reserved as self-support, so
    -- the money leaves the pool now, beside the rent_disbursement above.
    v_pool_entry := NULL;
    SELECT e.id INTO v_pool_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_line.line_id
       AND e.status = 'open' AND e.in_pool > 0;
    IF v_pool_entry IS NOT NULL THEN
      v_pool_drawn := v_pool_drawn + coalesce((public.landlord_pool_deploy(
        v_line.rent_request_id, v_line.principal, 'self_support', v_alloc, v_pool_entry,
        'psm_disburse_landlord_float') ->> 'drawn')::numeric, 0);
    END IF;

    INSERT INTO public.agent_float_funding (agent_id, amount, funded_by, rent_request_id, notes)
    VALUES (v_agent, v_line.principal, auth.uid(), v_line.rent_request_id,
            'Partner-funded landlord float for ' || v_landlord_name)
    ON CONFLICT DO NOTHING;

    UPDATE public.rent_requests
       SET status = 'funded',
           funded_at = COALESCE(funded_at, now()),
           self_funding_partner_id = COALESCE(self_funding_partner_id, v_partner),
           self_funding_line_id = COALESCE(self_funding_line_id, v_line.line_id),
           updated_at = now()
     WHERE id = v_line.rent_request_id
       AND status IN ('approved','coo_approved','pending','agent_ops_approved',
                      'tenant_ops_approved','landlord_ops_approved','cfo_approved');

    v_treasury := public.recognise_funding_treasury(v_line.rent_request_id);
    IF (v_treasury->>'status') = 'recognised' THEN
      v_treasury_recognised := v_treasury_recognised + 1;
    END IF;

    v_funded := v_funded + 1;
    v_total := v_total + v_line.principal;
  END LOOP;

  WITH grouped AS (
    SELECT a.agent_id, a.landlord_id,
           MIN(a.landlord_name) AS landlord_name,
           SUM(a.allocated_amount) AS amount,
           COUNT(DISTINCT a.rent_request_id)::int AS tenant_count,
           array_agg(DISTINCT a.rent_request_id) AS rent_request_ids
      FROM public.agent_landlord_float_allocations a
     WHERE a.id = ANY(v_alloc_ids)
       AND a.status NOT IN ('cancelled','reversed')
     GROUP BY a.agent_id, a.landlord_id
  ), ins AS (
    INSERT INTO public.partner_float_agent_notices (
      commitment_id, topup_id, partner_id, agent_id, landlord_id,
      landlord_name, amount, tenant_count, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.landlord_id,
           COALESCE(g.landlord_name,'the landlord'), g.amount, g.tenant_count, g.rent_request_ids
      FROM grouped g
    ON CONFLICT DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*)::int INTO v_notices FROM ins;

  -- Landlord SMS queue (5a). One row per agent+landlord, like the agent notices.
  -- The landlord is told their rent is approved and who will pay them, because
  -- the money now sits on the agent's dashboard. Never blocks the approval.
  BEGIN
    INSERT INTO public.partner_float_landlord_notices (
      commitment_id, topup_id, partner_id, agent_id, agent_name, landlord_id,
      landlord_name, landlord_phone, amount, tenant_count, tenant_first_names, rent_request_ids
    )
    SELECT p_commitment_id, p_topup_id, v_partner, g.agent_id, g.agent_name, g.landlord_id,
           COALESCE(g.landlord_name, 'the landlord'), g.landlord_phone, g.amount, g.tenant_count,
           COALESCE(g.tenant_names, '{}'::text[]), g.rent_request_ids
      FROM (
        SELECT a.agent_id, a.landlord_id,
               MIN(pa.full_name)                       AS agent_name,
               MIN(a.landlord_name)                    AS landlord_name,
               MIN(ld.phone)                           AS landlord_phone,
               SUM(a.allocated_amount)                 AS amount,
               COUNT(DISTINCT a.rent_request_id)::int  AS tenant_count,
               array_agg(DISTINCT initcap(split_part(btrim(pt.full_name), ' ', 1)))
                 FILTER (WHERE btrim(COALESCE(pt.full_name, '')) <> '') AS tenant_names,
               array_agg(DISTINCT a.rent_request_id)   AS rent_request_ids
          FROM public.agent_landlord_float_allocations a
          LEFT JOIN public.profiles  pa ON pa.id = a.agent_id
          LEFT JOIN public.profiles  pt ON pt.id = a.tenant_id
          LEFT JOIN public.landlords ld ON ld.id = a.landlord_id
         WHERE a.id = ANY(v_alloc_ids)
           AND a.status NOT IN ('cancelled', 'reversed')
         GROUP BY a.agent_id, a.landlord_id
      ) g
    ON CONFLICT DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_sms_queue_failed',
      'partner_self_commitments', p_commitment_id, jsonb_build_object('error', SQLERRM));
  END;

  PERFORM public.psm_audit(auth.uid(), v_partner, 'landlord_float_disbursed',
    'partner_self_commitments', p_commitment_id,
    jsonb_build_object('funded_lines', v_funded, 'skipped_lines', v_skipped,
                       'total_amount', v_total, 'notices_queued', v_notices,
                       'treasury_recognised', v_treasury_recognised,
                       'topup_id', p_topup_id,
                       'landlord_pool_drawn', v_pool_drawn));

  RETURN jsonb_build_object('funded', v_funded, 'skipped', v_skipped,
                            'total_amount', v_total, 'notices_queued', v_notices,
                            'treasury_recognised', v_treasury_recognised,
                            'landlord_pool_drawn', v_pool_drawn);
END;
$function$;

CREATE OR REPLACE FUNCTION public.psm_activate_line_on_disbursement()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_line public.partner_self_funding_lines%ROWTYPE; v_live timestamptz;
BEGIN
  BEGIN
    IF NEW.self_funding_partner_id IS NULL THEN RETURN NEW; END IF;
    v_live := COALESCE(NEW.disbursed_at, NEW.funded_at);
    IF v_live IS NULL THEN RETURN NEW; END IF;

    UPDATE public.partner_self_funding_lines
       SET status='active', live_at=v_live,
           term_end_at = v_live + (term_months || ' months')::interval,
           updated_at = now()
     WHERE rent_request_id = NEW.id AND status='idle'
    RETURNING * INTO v_line;

    IF v_line.id IS NULL THEN RETURN NEW; END IF;

    UPDATE public.partner_self_commitments
       SET payout_anchor_at = v_live,
           payout_day = EXTRACT(DAY FROM v_live)::smallint,
           next_payout_at = v_live + interval '1 month',
           term_end_at = v_live + (term_months || ' months')::interval,
           updated_at = now()
     WHERE id = v_line.commitment_id AND payout_anchor_at IS NULL;

    PERFORM public.psm_audit(NULL, v_line.partner_id, 'line_activated',
      'partner_self_funding_lines', v_line.id,
      jsonb_build_object('rent_request_id', NEW.id, 'live_at', v_live,
                         'principal', v_line.principal, 'linked_party', 'self_managed_partner'));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.funder_pending_hold(p_user_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  RETURN (
  SELECT COALESCE(SUM(f.amount), 0)::numeric
  FROM public.funder_pending_portfolios f
  WHERE f.funder_id = p_user_id
    AND f.status = 'pending'
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || f.portfolio_id::text
           OR (g.source_table = 'investor_portfolios' AND g.source_id = f.portfolio_id)
           OR (f.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = f.commitment_id))
         )
    ));
END;
$function$;

CREATE OR REPLACE FUNCTION public.psm_release_self_funding_line(p_line_id uuid, p_reason text DEFAULT 'Self-support funding cancelled — plan released back to ready to fund'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_line   public.partner_self_funding_lines%ROWTYPE;
  v_rr     public.rent_requests%ROWTYPE;
  v_alloc  public.agent_landlord_float_allocations%ROWTYPE;
  v_group  uuid;
  v_reversed numeric := 0;
BEGIN
  SELECT * INTO v_line FROM public.partner_self_funding_lines WHERE id = p_line_id FOR UPDATE;
  IF v_line.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding line not found.');
  END IF;
  IF v_line.rent_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Funding line has no rent plan.');
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = v_line.rent_request_id FOR UPDATE;
  IF v_rr.id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rent plan not found.');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations
     WHERE rent_request_id = v_rr.id
       AND source = 'partner_self_funding'
       AND COALESCE(paid_out_amount, 0) > 0
  ) THEN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
    VALUES (v_line.partner_id, 'psm_release_skipped_paid_out', 'rent_requests', v_rr.id::text,
            'Self-support release skipped: landlord already partly paid from float',
            jsonb_build_object('line_id', v_line.id, 'partner_id', v_line.partner_id));
    RETURN jsonb_build_object('success', false, 'error', 'Landlord already paid from float — release blocked.');
  END IF;

  FOR v_alloc IN
    SELECT * FROM public.agent_landlord_float_allocations
     WHERE rent_request_id = v_rr.id
       AND source = 'partner_self_funding'
       AND status IN ('open','partially_paid','return_pending')
     FOR UPDATE
  LOOP
    IF COALESCE(v_alloc.remaining_amount, 0) > 0 THEN
      SELECT public.create_ledger_transaction(entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_in',
          'category', 'rent_disbursement', 'ledger_scope', 'platform', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_rr.id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Self-support cancellation — float returned for %s (float_usage=self_portfolio_funding reversal)', COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        ),
        jsonb_build_object(
          'user_id', v_alloc.agent_id, 'amount', v_alloc.remaining_amount, 'direction', 'cash_out',
          'category', 'rent_receivable_created', 'ledger_scope', 'bridge', 'classification', 'production',
          'currency', 'UGX', 'source_table', 'rent_requests', 'source_id', v_rr.id,
          'linked_party', v_alloc.landlord_id,
          'description', format('Reversal — self-support funding cancelled (%s)', COALESCE(v_alloc.landlord_name,'landlord')),
          'transaction_date', now()
        )
      )) INTO v_group;

      -- balance is recomputed from allocations by the allocation trigger (sole writer);
      -- only the lifetime funded tally is adjusted here.
      UPDATE public.agent_landlord_float
         SET total_funded = GREATEST(0, COALESCE(total_funded,0) - v_alloc.remaining_amount),
             updated_at = now()
       WHERE agent_id = v_alloc.agent_id;

      v_reversed := v_reversed + v_alloc.remaining_amount;
    END IF;

    UPDATE public.agent_landlord_float_allocations
       SET status = 'cancelled',
           notes = COALESCE(notes,'') || ' | Self-support funding cancelled — released back to ready to fund',
           updated_at = now()
     WHERE id = v_alloc.id;
  END LOOP;

  UPDATE public.rent_requests
     SET status = CASE
                    WHEN status IN ('funded','disbursed')
                      THEN CASE WHEN coo_reviewed_at IS NOT NULL THEN 'coo_approved' ELSE 'approved' END
                    ELSE status
                  END,
         funded_at = NULL,
         disbursed_at = NULL,
         self_funding_partner_id = NULL,
         self_funding_line_id = NULL,
         fund_recipient_type = NULL,
         fund_recipient_id = NULL,
         fund_recipient_name = NULL,
         fund_routed_at = NULL,
         funder_visible = true,
         updated_at = now()
   WHERE id = v_rr.id;

  UPDATE public.partner_self_plan_claims
     SET status = 'released', closed_at = now(), updated_at = now()
   WHERE rent_request_id = v_rr.id
     AND status IN ('held','confirmed');

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, metadata)
  VALUES (v_line.partner_id, 'psm_release_self_funding_line', 'rent_requests', v_rr.id::text,
          COALESCE(NULLIF(btrim(p_reason),''), 'Self-support funding cancelled — plan released back to ready to fund'),
          jsonb_build_object('line_id', v_line.id, 'commitment_id', v_line.commitment_id,
                             'partner_id', v_line.partner_id, 'float_returned', v_reversed));

  RETURN jsonb_build_object('success', true, 'rent_request_id', v_rr.id, 'float_returned', v_reversed);
END;
$function$;

CREATE OR REPLACE FUNCTION public.psm_release_plan_on_line_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status = 'cancelled' AND COALESCE(OLD.status,'') <> 'cancelled' AND NEW.rent_request_id IS NOT NULL THEN
    PERFORM public.psm_release_self_funding_line(NEW.id, 'Self-support funding line cancelled — plan auto-released');
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE VIEW public.v_partner_self_fundable_plans AS
 SELECT rr.id AS rent_request_id,
    rr.rent_amount AS funding_amount,
    rr.rent_amount,
    rr.duration_days,
    rr.daily_repayment,
    rr.total_repayment,
    rr.number_of_payments,
    rr.house_category,
    rr.request_city,
    rr.house_image_urls,
    rr.created_at AS posted_at,
    COALESCE(rr.coo_reviewed_at, rr.approved_at) AS approved_at,
    (CURRENT_DATE + ((rr.duration_days || ' days'::text)::interval))::date AS projected_end_date,
        CASE
            WHEN COALESCE(rr.number_of_payments, 0) > 0 AND rr.duration_days > 0 AND (rr.duration_days::numeric / NULLIF(rr.number_of_payments, 0)::numeric) >= 6::numeric THEN 'weekly'::text
            ELSE 'daily'::text
        END AS repayment_cadence,
    split_part(COALESCE(NULLIF(btrim(tp.full_name), ''::text), 'Tenant'::text), ' '::text, 1) AS tenant_first_name,
    NULL::text AS tenant_avatar_url,
    COALESCE(NULLIF(btrim(lp.full_name), ''::text), NULLIF(btrim(ll.name), ''::text), NULLIF(btrim(ll2.name), ''::text), 'Landlord'::text) AS landlord_name,
    c.id AS active_claim_id,
    c.partner_id AS held_by,
    c.expires_at AS hold_expires_at,
    COALESCE(NULLIF(btrim(tp.full_name), ''::text), 'Tenant'::text) AS tenant_full_name,
    NULLIF(concat_ws(', '::text, NULLIF(btrim(tp.village), ''::text), NULLIF(btrim(COALESCE(tp.city, rr.request_city)), ''::text), NULLIF(btrim(tp.district), ''::text), NULLIF(btrim(tp.region), ''::text)), ''::text) AS tenant_location,
    NULLIF(btrim(tp.avatar_url), ''::text) IS NOT NULL AS tenant_has_photo,
    rr.request_latitude,
    rr.request_longitude,
    ( SELECT cand.v
           FROM ( VALUES (NULLIF(btrim(ll.phone), ''::text)), (NULLIF(btrim(ll.mobile_money_number), ''::text)), (NULLIF(btrim(ll2.phone), ''::text)), (NULLIF(btrim(ll2.mobile_money_number), ''::text)), (NULLIF(btrim(lp.phone), ''::text))) cand(v)
          WHERE cand.v IS NOT NULL AND "right"(regexp_replace(cand.v, '\D'::text, ''::text, 'g'::text), 9) IS DISTINCT FROM "right"(regexp_replace(COALESCE(tp.phone, ''::text), '\D'::text, ''::text, 'g'::text), 9)
         LIMIT 1) AS landlord_phone,
    COALESCE(NULLIF(btrim(lcp.name), ''::text), 'LC1 not recorded'::text) AS lc1_chairperson_name,
    NULLIF(btrim(xp.phone), ''::text) AS proxy_agent_phone,
    COALESCE(rr.funder_visible, true) AS funder_visible,
    NULLIF(btrim(tp.phone), ''::text) AS tenant_phone
   FROM public.rent_requests rr
     LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
     LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
     LEFT JOIN public.landlords ll ON ll.id = rr.landlord_id
     LEFT JOIN public.landlords ll2 ON ll2.tenant_id = rr.tenant_id
     LEFT JOIN public.lc1_chairpersons lcp ON lcp.id = rr.lc1_id
     LEFT JOIN public.partner_self_plan_claims c ON c.rent_request_id = rr.id AND (c.status = ANY (ARRAY['held'::text, 'confirmed'::text])) AND (c.status = 'confirmed'::text OR c.expires_at > now())
     LEFT JOIN public.profiles xp ON xp.id = rr.proxy_agent_id
  WHERE rr.funded_at IS NULL AND rr.disbursed_at IS NULL AND rr.supporter_id IS NULL AND rr.self_funding_partner_id IS NULL AND rr.tenancy_status = 'active'::text AND rr.coo_reviewed_at IS NOT NULL AND rr.rent_amount >= 50000::numeric AND COALESCE(rr.funder_visible, true) = true AND (rr.status = ANY (ARRAY['pending'::text, 'approved'::text, 'agent_ops_approved'::text, 'tenant_ops_approved'::text, 'landlord_ops_approved'::text, 'agent_verified'::text, 'coo_approved'::text]))
    AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL;

COMMENT ON VIEW public.v_partner_self_fundable_plans IS
  'Rent Plans a partner may fund. Plans with no assigned agent are excluded.';

-- 2. Co-support functions
DROP FUNCTION IF EXISTS public.co_support_create(uuid);
DROP FUNCTION IF EXISTS public.co_support_preview(text);
DROP FUNCTION IF EXISTS public.co_support_accept(text);
DROP FUNCTION IF EXISTS public.co_support_decline(text);
DROP FUNCTION IF EXISTS public.co_support_cancel(uuid);
DROP FUNCTION IF EXISTS public.co_support_reinvite(uuid, boolean);
DROP FUNCTION IF EXISTS public.co_support_fund_alone(uuid);
DROP FUNCTION IF EXISTS public.co_support_my_invites();
DROP FUNCTION IF EXISTS public.co_support_integrity_check();
DROP FUNCTION IF EXISTS public.co_support_staff_cancel(uuid, text);
DROP FUNCTION IF EXISTS public._co_support_disburse_landlord_float(uuid);
DROP FUNCTION IF EXISTS public._co_support_open_half(uuid, uuid, numeric, numeric, text);
DROP FUNCTION IF EXISTS public._co_support_lead_checks(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_require_partner(uuid);
DROP FUNCTION IF EXISTS public._co_support_lock(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_invite_json(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_plan_problem(uuid, uuid);
DROP FUNCTION IF EXISTS public._co_support_expire_stale(uuid);
DROP FUNCTION IF EXISTS public._co_support_new_code();
DROP FUNCTION IF EXISTS public._co_support_fmt(numeric);
DROP FUNCTION IF EXISTS public._co_support_status(text, timestamptz, timestamptz);
DROP FUNCTION IF EXISTS public._co_support_first_name(uuid);
DROP FUNCTION IF EXISTS public._co_support_split(numeric);

-- 3. Funding lines back to one line per plan
DROP TRIGGER IF EXISTS trg_psfl_no_mixed_funding ON public.partner_self_funding_lines;
DROP FUNCTION IF EXISTS public._psfl_no_mixed_funding();
DROP INDEX IF EXISTS public.ux_psfl_active_plan_co_support;
DROP INDEX IF EXISTS public.idx_psfl_co_support;
DROP INDEX IF EXISTS public.ux_psfl_active_plan;
CREATE UNIQUE INDEX ux_psfl_active_plan ON public.partner_self_funding_lines USING btree (rent_request_id) WHERE (status <> 'cancelled'::text);
ALTER TABLE public.partner_self_funding_lines DROP COLUMN IF EXISTS co_support_id;

-- 4. The invites table (history included)
DROP TABLE IF EXISTS public.co_support_invites;
