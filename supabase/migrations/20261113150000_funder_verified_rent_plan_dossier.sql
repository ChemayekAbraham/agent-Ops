-- Read-only dossier for a funder opening a Rent Plan they fund.
-- Returns landlord name and phone, the payout mobile money number and the
-- name registered on it, repayment figures already stored on the plan, and
-- the tenant agreement acceptance. Nothing here writes money, wallets, or
-- approvals.
--
-- A plan is verified the same way the funders board says "Verified": it has
-- passed the COO desk and is still visible to funders. Plans that have since
-- been funded, are repaying, or are completed keep that verification. A plan
-- still sitting at COO approval is verified only when its agent is eligible
-- (public._eligible_agents), matching funders_board_items. Pending
-- verification, rejected, and cancelled plans return no contact details.
--
-- The caller must fund the plan: supporter_id, a live self-funding line, or a
-- fulfilled portfolio allocation. Anyone else gets the same empty answer as a
-- missing plan. Reserved allocations are not funding.
--
-- Funding status (timeline and receipt) is returned for every plan the caller
-- funds, verified or not. It never says the rent was paid unless a landlord
-- payout is completed, awaiting the agent receipt, or has a disbursement
-- stamp. An open agent float allocation is "on the agent's dashboard". The
-- landlord has a Welile account only when their phone matches a live landlord
-- login the same way get_my_landlord_properties does. Phone, mobile money and
-- the tenant agreement stay empty until the plan is verified.

CREATE OR REPLACE FUNCTION public.funder_verified_rent_plan_dossier(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_rr public.rent_requests%ROWTYPE;
  v_funds boolean := false;
  v_eligible boolean := true;
  v_verified boolean := false;
  v_agent uuid;
  v_out jsonb;
  v_alloc_id uuid;
  v_alloc_status text;
  v_alloc_agent uuid;
  v_alloc_amount numeric;
  v_alloc_ref text;
  v_alloc_at timestamptz;
  v_pay_id uuid;
  v_pay_status text;
  v_pay_disbursed timestamptz;
  v_pay_finops timestamptz;
  v_pay_receipt text;
  v_pay_momo text;
  v_pay_external text;
  v_phone text;
  v_digits text;
  v_local text;
  v_intl text;
  v_has_dashboard boolean := false;
  v_rent_paid boolean := false;
  v_agent_id uuid;
  v_agent_name text;
  v_funder_name text;
  v_tid text;
  v_receipt_no text;
  v_amount numeric;
  v_route text;
  v_where_title text;
  v_where_detail text;
  v_where_state text;
  v_pay_title text;
  v_pay_detail text;
  v_pay_state text;
  v_house text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;

  IF p_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_available');
  END IF;

  SELECT * INTO v_rr FROM public.rent_requests WHERE id = p_rent_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_available');
  END IF;

  v_funds := v_rr.supporter_id = v_uid
    OR (
      v_rr.self_funding_partner_id = v_uid
      AND NOT (
        EXISTS (
          SELECT 1
            FROM public.partner_self_funding_lines l
            JOIN public.partner_self_commitments c ON c.id = l.commitment_id
           WHERE l.rent_request_id = v_rr.id
             AND l.partner_id = v_uid
             AND (l.status = 'cancelled' OR c.status = 'cancelled')
        )
        AND NOT EXISTS (
          SELECT 1
            FROM public.partner_self_funding_lines l2
            JOIN public.partner_self_commitments c2 ON c2.id = l2.commitment_id
           WHERE l2.rent_request_id = v_rr.id
             AND l2.partner_id = v_uid
             AND l2.status <> 'cancelled'
             AND c2.status <> 'cancelled'
        )
      )
    )
    OR EXISTS (
      SELECT 1
        FROM public.portfolio_allocations pa
        JOIN public.investor_portfolios ip ON ip.id = pa.portfolio_id
       WHERE ip.investor_id = v_uid
         AND pa.status = 'fulfilled'
         AND pa.released_at IS NULL
         AND (pa.rent_request_id = v_rr.id OR pa.fulfilled_rent_request_id = v_rr.id)
    );

  IF NOT v_funds THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_available');
  END IF;

  -- Still on the COO desk: the board calls this "Verified" only when the
  -- agent is eligible. A missing agent row is eligible, same as the board.
  -- Funded, repaying and completed plans keep verification without this scan.
  IF v_rr.status = 'coo_approved' THEN
    v_agent := COALESCE(v_rr.assigned_agent_id, v_rr.agent_id);
    BEGIN
      SELECT e.eligible
        INTO v_eligible
        FROM public._eligible_agents() e
       WHERE e.agent_id = v_agent
       LIMIT 1;
      IF NOT FOUND THEN
        v_eligible := true;
      END IF;
    EXCEPTION
      WHEN undefined_function THEN
        v_eligible := false;
    END;
  END IF;

  v_verified :=
    v_rr.coo_reviewed_at IS NOT NULL
    AND COALESCE(v_rr.funder_visible, true)
    AND v_rr.status IN ('coo_approved', 'funded', 'repaying', 'completed')
    AND (
      v_rr.status IN ('funded', 'repaying', 'completed')
      OR COALESCE(v_eligible, false)
    );

  SELECT a.id, a.status, a.agent_id, a.allocated_amount, NULLIF(btrim(a.funding_reference), ''), a.created_at
    INTO v_alloc_id, v_alloc_status, v_alloc_agent, v_alloc_amount, v_alloc_ref, v_alloc_at
    FROM public.agent_landlord_float_allocations a
   WHERE a.rent_request_id = v_rr.id
     AND a.status <> 'cancelled'
   ORDER BY a.created_at DESC
   LIMIT 1;

  SELECT p.id, p.status, p.disbursed_at, p.finops_disbursed_at,
         NULLIF(btrim(p.receipt_number), ''),
         NULLIF(btrim(p.finops_momo_reference), ''),
         NULLIF(btrim(p.external_reference), '')
    INTO v_pay_id, v_pay_status, v_pay_disbursed, v_pay_finops, v_pay_receipt, v_pay_momo, v_pay_external
    FROM public.landlord_payouts p
   WHERE p.rent_request_id = v_rr.id
   ORDER BY p.created_at DESC
   LIMIT 1;

  v_rent_paid := v_pay_id IS NOT NULL
    AND v_pay_status IS DISTINCT FROM 'failed'
    AND (
      v_pay_status IN ('completed', 'awaiting_agent_receipt')
      OR v_pay_disbursed IS NOT NULL
      OR v_pay_finops IS NOT NULL
    );

  SELECT COALESCE(NULLIF(btrim(ll.phone), ''), NULLIF(btrim(hll.phone), ''))
    INTO v_phone
    FROM (SELECT 1) s
    LEFT JOIN public.landlords ll ON ll.id = v_rr.landlord_id
    LEFT JOIN public.house_listings hl ON hl.id = v_rr.house_listing_id
    LEFT JOIN public.landlords hll ON hll.id = hl.landlord_id;

  v_digits := regexp_replace(COALESCE(v_phone, ''), '\D', '', 'g');
  v_local := CASE
    WHEN v_digits LIKE '256%' AND length(v_digits) >= 12 THEN '0' || substr(v_digits, 4)
    ELSE v_digits
  END;
  v_intl := CASE
    WHEN v_digits LIKE '0%' AND length(v_digits) >= 10 THEN '256' || substr(v_digits, 2)
    ELSE v_digits
  END;
  IF length(v_digits) >= 9 THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.profiles p
        JOIN public.user_roles ur
          ON ur.user_id = p.id
         AND ur.role = 'landlord'::public.app_role
         AND COALESCE(ur.enabled, true)
       WHERE COALESCE(p.is_frozen, false) = false
         AND p.deleted_at IS NULL
         AND regexp_replace(COALESCE(p.phone, ''), '\D', '', 'g') IN (v_digits, v_local, v_intl)
    ) INTO v_has_dashboard;
  END IF;

  v_agent_id := COALESCE(v_alloc_agent, v_rr.agent_id, v_rr.assigned_agent_id);
  SELECT NULLIF(btrim(full_name), '') INTO v_agent_name FROM public.profiles WHERE id = v_agent_id;
  SELECT NULLIF(btrim(full_name), '') INTO v_funder_name FROM public.profiles WHERE id = v_uid;
  v_agent_name := COALESCE(v_agent_name, 'your agent');

  SELECT NULLIF(btrim(f.float_delivery_tid), '')
    INTO v_tid
    FROM public.agent_float_funding f
   WHERE f.rent_request_id = v_rr.id
     AND NULLIF(btrim(f.float_delivery_tid), '') IS NOT NULL
   ORDER BY f.created_at DESC
   LIMIT 1;
  v_tid := COALESCE(v_tid, v_pay_momo, v_pay_external);

  v_receipt_no := COALESCE(
    v_pay_receipt,
    v_alloc_ref,
    'WR-' || upper(substr(replace(v_rr.id::text, '-', ''), 1, 8))
  );
  v_amount := COALESCE(v_alloc_amount, v_rr.rent_amount);

  IF v_rent_paid THEN
    v_route := 'rent_paid';
    v_where_state := 'done';
    v_where_title := 'Rent paid to the landlord';
    v_where_detail := 'A landlord payout on this Rent Plan is recorded'
      || CASE
           WHEN COALESCE(v_pay_disbursed, v_pay_finops) IS NOT NULL
             THEN ' on ' || to_char(COALESCE(v_pay_disbursed, v_pay_finops) AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY')
           ELSE ''
         END
      || '.';
    v_pay_state := 'done';
    v_pay_title := 'Landlord payout';
    v_pay_detail := CASE v_pay_status
      WHEN 'awaiting_agent_receipt' THEN 'Paid to the landlord. The agent still confirms the receipt.'
      ELSE 'Paid to the landlord.'
    END;
  ELSIF v_pay_id IS NOT NULL AND v_pay_status IN ('pending_merchant_payout', 'pending_finops_disbursement', 'disbursing', 'otp_verified', 'escalated') THEN
    v_route := 'payout_pending';
    v_where_state := 'current';
    v_where_title := 'Payout not completed';
    v_where_detail := 'A payout to the landlord is in progress. It has not been paid yet.';
    v_pay_state := 'current';
    v_pay_title := 'Landlord payout';
    v_pay_detail := 'Not paid to the landlord yet.';
  ELSIF v_alloc_id IS NOT NULL AND v_alloc_status IN ('open', 'partially_paid') THEN
    IF v_has_dashboard THEN
      v_route := 'landlord_account';
      v_where_state := 'current';
      v_where_title := 'Landlord Welile account';
      v_where_detail := 'The landlord has a Welile account. This rent is recorded on '
        || v_agent_name || '''s dashboard until a payout to the landlord is on file. It has not been paid out yet.';
    ELSE
      v_route := 'agent_will_withdraw';
      v_where_state := 'current';
      v_where_title := 'On the agent dashboard';
      v_where_detail := 'The landlord is not using a Welile dashboard. This rent is on '
        || v_agent_name || '''s dashboard. ' || v_agent_name || ' will process the withdrawal for the landlord.';
    END IF;
    v_pay_state := 'waiting';
    v_pay_title := 'Landlord payout';
    v_pay_detail := 'Not paid to the landlord yet.';
  ELSIF v_alloc_id IS NOT NULL AND v_alloc_status = 'fully_paid' THEN
    v_route := 'payout_pending';
    v_where_state := 'current';
    v_where_title := 'Float marked paid out';
    v_where_detail := 'The agent float for this rent is marked paid out. A completed landlord payout is not on file, so this is not shown as paid to the landlord.';
    v_pay_state := 'waiting';
    v_pay_title := 'Landlord payout';
    v_pay_detail := 'Not paid to the landlord yet.';
  ELSE
    v_route := 'funding_recorded';
    v_where_state := 'waiting';
    v_where_title := 'Not released yet';
    v_where_detail := 'Your funding is recorded. It is not on an agent dashboard yet, and it has not been paid to the landlord.';
    v_pay_state := 'waiting';
    v_pay_title := 'Landlord payout';
    v_pay_detail := 'Not paid to the landlord yet.';
  END IF;

  SELECT NULLIF(btrim(hl.title), '') INTO v_house
    FROM public.house_listings hl
   WHERE hl.id = v_rr.house_listing_id;

  SELECT jsonb_build_object(
    'ok', true,
    'verified', v_verified,
    'rent_request_id', v_rr.id,
    'verification_label', CASE WHEN v_verified THEN 'Verified' ELSE NULL END,
    'status', v_rr.status,
    'tenant_name', COALESCE(NULLIF(btrim(tp.full_name), ''), 'Tenant'),
    'tenant_phone', CASE WHEN v_verified THEN NULLIF(btrim(tp.phone), '') ELSE NULL END,
    'landlord_name', COALESCE(
      NULLIF(btrim(lp.full_name), ''),
      NULLIF(btrim(ll.name), ''),
      NULLIF(btrim(hll.name), ''),
      'Landlord'
    ),
    'landlord_phone', CASE WHEN v_verified THEN (
      SELECT cand.v
        FROM (
          VALUES
            (NULLIF(btrim(lp.phone), ''), 1),
            (NULLIF(btrim(ll.phone), ''), 2),
            (NULLIF(btrim(hll.phone), ''), 3)
        ) AS cand(v, ord)
       WHERE cand.v IS NOT NULL
         AND right(regexp_replace(cand.v, '\D', '', 'g'), 9)
             IS DISTINCT FROM right(regexp_replace(COALESCE(tp.phone, ''), '\D', '', 'g'), 9)
       ORDER BY cand.ord
       LIMIT 1
    ) ELSE NULL END,
    'payout_momo_number', CASE WHEN v_verified THEN momo.number ELSE NULL END,
    'payout_momo_name', CASE WHEN v_verified THEN momo.account_name ELSE NULL END,
    'payout_momo_source', CASE WHEN v_verified THEN momo.source ELSE NULL END,
    'house_category', NULLIF(btrim(v_rr.house_category), ''),
    'location', NULLIF(concat_ws(', ',
      NULLIF(btrim(hl.address), ''),
      NULLIF(btrim(COALESCE(NULLIF(hl.village, ''), tp.village)), ''),
      NULLIF(btrim(COALESCE(NULLIF(hl.district, ''), tp.district)), ''),
      NULLIF(btrim(COALESCE(v_rr.request_city, tp.city)), '')
    ), ''),
    'rent_amount', v_rr.rent_amount,
    'daily_repayment', v_rr.daily_repayment,
    'total_repayment', v_rr.total_repayment,
    'amount_repaid', v_rr.amount_repaid,
    'duration_days', v_rr.duration_days,
    'repayment_frequency', NULLIF(btrim(v_rr.repayment_frequency), ''),
    'repayment_starts_on', v_rr.repayment_starts_on,
    'funded_at', v_rr.funded_at,
    'agreement', CASE WHEN v_verified THEN jsonb_build_object(
      'version', agree.agreement_version,
      'status', CASE WHEN agree.accepted_at IS NULL THEN 'not_accepted' ELSE 'accepted' END,
      'accepted_at', agree.accepted_at
    ) ELSE NULL END,
    'house_title', COALESCE(v_house, NULLIF(btrim(v_rr.house_category), '')),
    'funding', jsonb_build_object(
      'recorded_at', COALESCE(v_rr.funded_at, v_alloc_at),
      'amount', v_amount,
      'receipt_number', v_receipt_no,
      'reference', COALESCE(v_alloc_ref, v_tid),
      'tid', v_tid,
      'funder_name', COALESCE(v_funder_name, 'Supporter'),
      'agent_name', NULLIF(v_agent_name, 'your agent'),
      'landlord_has_dashboard', v_has_dashboard,
      'rent_paid', v_rent_paid,
      'route', v_route,
      'route_detail', v_where_detail,
      'steps', jsonb_build_array(
        jsonb_build_object(
          'key', 'funded',
          'state', 'done',
          'title', 'Funding recorded',
          'detail', CASE
            WHEN COALESCE(v_rr.funded_at, v_alloc_at) IS NOT NULL THEN 'You funded this Rent Plan on ' || to_char(COALESCE(v_rr.funded_at, v_alloc_at) AT TIME ZONE 'Africa/Kampala', 'DD Mon YYYY') || '.'
            ELSE 'You funded this Rent Plan.'
          END
        ),
        jsonb_build_object(
          'key', 'where',
          'state', v_where_state,
          'title', v_where_title,
          'detail', v_where_detail
        ),
        jsonb_build_object(
          'key', 'payout',
          'state', v_pay_state,
          'title', v_pay_title,
          'detail', v_pay_detail
        )
      )
    )
  )
    INTO v_out
    FROM (SELECT 1) AS one
    LEFT JOIN public.profiles tp ON tp.id = v_rr.tenant_id
    LEFT JOIN public.profiles lp ON lp.id = v_rr.landlord_id
    LEFT JOIN public.landlords ll ON ll.id = v_rr.landlord_id
    LEFT JOIN public.house_listings hl ON hl.id = v_rr.house_listing_id
    LEFT JOIN public.landlords hll ON hll.id = hl.landlord_id
    LEFT JOIN LATERAL (
      SELECT cand.number, cand.account_name, cand.source
        FROM (
          VALUES
            (NULLIF(btrim(ll.verified_mobile_money_number), ''), NULLIF(btrim(ll.mobile_money_name), ''), 'approved', 1),
            (NULLIF(btrim(ll.mobile_money_number), ''), NULLIF(btrim(ll.mobile_money_name), ''), 'on_file', 2),
            (NULLIF(btrim(hll.verified_mobile_money_number), ''), NULLIF(btrim(hll.mobile_money_name), ''), 'approved', 3),
            (NULLIF(btrim(hll.mobile_money_number), ''), NULLIF(btrim(hll.mobile_money_name), ''), 'on_file', 4)
        ) AS cand(number, account_name, source, ord)
       WHERE cand.number IS NOT NULL
         AND right(regexp_replace(cand.number, '\D', '', 'g'), 9)
             IS DISTINCT FROM right(regexp_replace(COALESCE(tp.phone, ''), '\D', '', 'g'), 9)
       ORDER BY cand.ord
       LIMIT 1
    ) momo ON true
    LEFT JOIN LATERAL (
      SELECT ta.agreement_version, ta.accepted_at
        FROM public.tenant_agreement_acceptance ta
       WHERE ta.tenant_id = v_rr.tenant_id
         AND ta.status = 'accepted'
       ORDER BY ta.accepted_at DESC
       LIMIT 1
    ) agree ON true;

  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.funder_verified_rent_plan_dossier(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.funder_verified_rent_plan_dossier(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.funder_verified_rent_plan_dossier(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.funder_verified_rent_plan_dossier(uuid) TO service_role;

COMMENT ON FUNCTION public.funder_verified_rent_plan_dossier(uuid) IS
  'Read-only. Funding timeline and receipt facts for a Rent Plan the caller funds. Landlord phone, mobile money and the tenant agreement only when that plan is also verified. No money movement.';
