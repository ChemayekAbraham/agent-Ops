ALTER TABLE public.partner_self_funding_lines
  DROP CONSTRAINT IF EXISTS partner_self_funding_lines_status_check;
UPDATE public.partner_self_funding_lines SET status = 'active' WHERE status = 'earning';
ALTER TABLE public.partner_self_funding_lines
  ADD CONSTRAINT partner_self_funding_lines_status_check
  CHECK (status = ANY (ARRAY['idle','active','completed','cancelled']));

CREATE OR REPLACE FUNCTION public.psm_activate_line_on_disbursement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
$$;

CREATE OR REPLACE FUNCTION public.psm_complete_line_on_plan_close()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  BEGIN
    IF NEW.self_funding_partner_id IS NULL THEN RETURN NEW; END IF;
    IF NEW.status IN ('completed','fully_repaid') AND COALESCE(OLD.status,'') <> NEW.status THEN
      UPDATE public.partner_self_funding_lines
         SET status='completed', completed_at=now(), updated_at=now()
       WHERE rent_request_id = NEW.id AND status IN ('active','earning');
      PERFORM public.psm_audit(NULL, NEW.self_funding_partner_id, 'line_completed',
        'rent_requests', NEW.id, jsonb_build_object('status', NEW.status));
    END IF;
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN NEW;
END;
$$;

DROP VIEW IF EXISTS public.v_partner_self_fundable_plans;
CREATE VIEW public.v_partner_self_fundable_plans AS
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
    (CURRENT_DATE + ((rr.duration_days || ' days')::interval))::date AS projected_end_date,
    CASE
      WHEN COALESCE(rr.number_of_payments, 0) > 0 AND rr.duration_days > 0
           AND (rr.duration_days::numeric / NULLIF(rr.number_of_payments, 0)::numeric) >= 6::numeric
      THEN 'weekly' ELSE 'daily'
    END AS repayment_cadence,
    split_part(COALESCE(NULLIF(btrim(tp.full_name), ''), 'Tenant'), ' ', 1) AS tenant_first_name,
    tp.avatar_url AS tenant_avatar_url,
    COALESCE(NULLIF(btrim(lp.full_name), ''), 'Landlord') AS landlord_name,
    c.id AS active_claim_id,
    c.partner_id AS held_by,
    c.expires_at AS hold_expires_at
   FROM public.rent_requests rr
     LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
     LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
     LEFT JOIN public.partner_self_plan_claims c
       ON c.rent_request_id = rr.id
      AND c.status = ANY (ARRAY['held','confirmed'])
      AND (c.status = 'confirmed' OR c.expires_at > now())
  WHERE rr.funded_at IS NULL AND rr.disbursed_at IS NULL AND rr.supporter_id IS NULL
    AND rr.self_funding_partner_id IS NULL AND rr.tenancy_status = 'active'
    AND rr.coo_reviewed_at IS NOT NULL
    AND rr.rent_amount >= 50000
    AND (rr.status = ANY (ARRAY['pending','approved','agent_ops_approved','tenant_ops_approved',
                               'landlord_ops_approved','agent_verified','coo_approved']));

CREATE OR REPLACE FUNCTION public.partner_self_confirm_commitment(
  p_rent_request_ids uuid[], p_term_months integer DEFAULT 12, p_idempotency_key text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_key text := COALESCE(NULLIF(p_idempotency_key,''), 'psm-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids,',')));
  v_existing public.partner_self_commitments%ROWTYPE;
  v_commitment_id uuid;
  v_total numeric;
  v_count integer;
  v_min numeric;
  v_available numeric;
  v_rate numeric := 15;
  v_entries jsonb;
  v_group uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for self-managed funding' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psm-commit-' || v_uid::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
                              'committed_amount', v_existing.committed_amount,
                              'lines', v_existing.lines_count);
  END IF;

  SELECT COUNT(*), COALESCE(SUM(amount),0), COALESCE(MIN(amount),0)
  INTO v_count, v_total, v_min
  FROM public.partner_self_plan_claims
  WHERE partner_id = v_uid AND status = 'held' AND expires_at > now()
    AND rent_request_id = ANY(p_rent_request_ids);

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_rent_request_ids,1),0) THEN
    RAISE EXCEPTION 'Some selections are no longer held by you. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_min < 50000 THEN
    RAISE EXCEPTION 'Each plan you fund must be at least UGX 50,000.' USING ERRCODE = 'check_violation';
  END IF;
  IF v_total < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. Your selection totals UGX %.', round(v_total)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.get_user_available_balance(v_uid);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'Selected plans total UGX %. Your wallet has UGX % available. You are UGX % over.',
      round(v_total), round(v_available), round(v_total - v_available)
      USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key
  ) VALUES (
    v_uid, v_total, GREATEST(1, LEAST(COALESCE(p_term_months,12), 60)), v_rate, v_count, v_key
  ) RETURNING id INTO v_commitment_id;

  INSERT INTO public.partner_self_funding_lines (
    commitment_id, partner_id, rent_request_id, principal, monthly_rate, term_months
  )
  SELECT v_commitment_id, v_uid, c.rent_request_id, c.amount, v_rate,
         GREATEST(1, LEAST(COALESCE(p_term_months,12), 60))
  FROM public.partner_self_plan_claims c
  WHERE c.partner_id = v_uid AND c.status='held' AND c.rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.partner_self_plan_claims
     SET status='confirmed', confirmed_at=now(), commitment_id=v_commitment_id, updated_at=now()
   WHERE partner_id = v_uid AND status='held' AND rent_request_id = ANY(p_rent_request_ids);

  UPDATE public.rent_requests rr
     SET self_funding_partner_id = v_uid,
         self_funding_line_id = l.id,
         updated_at = now()
  FROM public.partner_self_funding_lines l
  WHERE l.commitment_id = v_commitment_id AND rr.id = l.rent_request_id;

  SELECT jsonb_agg(e) INTO v_entries FROM (
    SELECT jsonb_build_object(
      'user_id', v_uid, 'amount', l.principal, 'direction', 'cash_out',
      'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
      'recipient_type', 'user', 'wallet_bucket', 'withdrawable',
      'source_table', 'partner_self_funding_lines', 'source_id', l.id,
      'reference_id', l.rent_request_id::text,
      'description', 'Self-managed partner funding committed (self_managed_partner)'
    ) AS e
    FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_commitment_id
    UNION ALL
    SELECT jsonb_build_object(
      'amount', l.principal, 'direction', 'cash_in',
      'category', 'partner_funding', 'ledger_scope', 'platform',
      'source_table', 'partner_self_funding_lines', 'source_id', l.id,
      'reference_id', l.rent_request_id::text,
      'linked_party', v_uid::text,
      'description', 'Self-managed partner capital received (self_managed_partner)'
    )
    FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_commitment_id
  ) s;

  v_group := public.create_ledger_transaction(
    entries := v_entries,
    idempotency_key := 'psm-commit-' || v_commitment_id::text
  );

  UPDATE public.partner_self_commitments
     SET ledger_group_id = v_group, updated_at = now()
   WHERE id = v_commitment_id;

  PERFORM public.psm_audit(v_uid, v_uid, 'commitment_confirmed', 'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'lines', v_count, 'term_months', p_term_months,
                       'linked_party', 'self_managed_partner',
                       'ledger_group_id', v_group, 'available_before', v_available));

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'committed_amount', v_total, 'lines', v_count,
    'monthly_return', round(v_total * v_rate / 100), 'ledger_group_id', v_group,
    'available_balance', public.get_user_available_balance(v_uid)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.partner_self_portfolio(p_partner_id uuid DEFAULT NULL::uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid := COALESCE(p_partner_id, auth.uid());
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'Not authenticated' USING ERRCODE='42501'; END IF;
  IF v_target <> v_uid AND NOT (
      public.is_ops_role(v_uid) OR public.has_role(v_uid,'cfo') OR public.has_role(v_uid,'coo')
      OR public.has_role(v_uid,'ceo') OR public.has_role(v_uid,'manager') OR public.has_role(v_uid,'super_admin')
  ) THEN
    RAISE EXCEPTION 'Not authorised' USING ERRCODE='42501';
  END IF;

  RETURN (
    WITH commitments AS (
      SELECT * FROM public.partner_self_commitments WHERE partner_id = v_target
    ),
    lines AS (
      SELECT l.*, rr.rent_amount, rr.duration_days, rr.daily_repayment,
             rr.request_city, rr.house_category, rr.status AS plan_status,
             rr.disbursed_at, rr.amount_repaid,
             split_part(COALESCE(NULLIF(btrim(tp.full_name),''),'Tenant'),' ',1) AS tenant_first_name,
             tp.full_name AS tenant_full_name,
             tp.avatar_url AS tenant_avatar_url,
             COALESCE(NULLIF(btrim(lp.full_name),''),'Landlord') AS landlord_name
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
      LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
      WHERE l.partner_id = v_target AND l.status <> 'cancelled'
    ),
    holds AS (
      SELECT * FROM public.partner_self_plan_claims
      WHERE partner_id = v_target AND status='held' AND expires_at > now()
    ),
    payouts AS (
      SELECT * FROM public.partner_self_payout_cycles WHERE partner_id = v_target
    )
    SELECT jsonb_build_object(
      'available_balance', public.get_user_available_balance(v_target),
      'minimum_funding', 50000,
      'totals', jsonb_build_object(
        'committed', (SELECT COALESCE(SUM(committed_amount),0) FROM commitments WHERE status <> 'cancelled'),
        'active', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'earning', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='active'),
        'idle', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='idle'),
        'completed', (SELECT COALESCE(SUM(principal),0) FROM lines WHERE status='completed'),
        'total_earned', (SELECT COALESCE(SUM(total_earned),0) FROM commitments),
        'total_paid', (SELECT COALESCE(SUM(total_paid),0) FROM commitments),
        'lines_count', (SELECT COUNT(*) FROM lines)
      ),
      'commitments', (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC), '[]'::jsonb) FROM commitments c),
      'lines', (SELECT COALESCE(jsonb_agg(to_jsonb(l) ORDER BY l.created_at DESC), '[]'::jsonb) FROM lines l),
      'active_holds', (SELECT COALESCE(jsonb_agg(to_jsonb(h)), '[]'::jsonb) FROM holds h),
      'payout_cycles', (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY p.cycle_end DESC), '[]'::jsonb) FROM payouts p),
      'next_payout', (SELECT jsonb_build_object('date', MIN(next_payout_at))
                        FROM commitments WHERE status='active' AND next_payout_at IS NOT NULL)
    )
  );
END;
$$;