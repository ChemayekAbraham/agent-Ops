-- Payout projection covers every day since the last payout day, not one date.
--
-- WHY
-- ---
-- Supporter Returns are not paid on Saturday or Sunday; everything due over the
-- weekend is paid on Monday. get_next_day_payout_projection(p_date) only listed
-- Returns whose next_roi_date = p_date, so Sunday's 18:00 email showed Monday's
-- UGX 44.2M and missed Saturday + Sunday (UGX 76M on 2026-09-26). Weekend
-- Returns are not moved by any job: they keep their next_roi_date until a person
-- pays them (approve-wallet-operation), so a date range finds them on Monday.
--
-- WHAT CHANGES
-- ------------
-- * p_date (payout day) defaults to tomorrow (EAT), rolled forward past Saturday
--   and Sunday, so the Friday, Saturday and Sunday emails all plan Monday.
-- * p_from (first due date covered) defaults to the day after the previous
--   payout day: Monday covers Sat-Mon; Tuesday-Friday cover one day.
-- * Every Returns item carries its due_date; roi.by_day gives cash and
--   compounding per due date. Compounding stays separate and never counts as cash.
-- * plan: base = Returns cash + landlord + wallet withdrawals + partner capital;
--   cushion = p_cushion_pct % of base (default 10, 0 to hide);
--   total = base + cushion.
-- * Past-due backlog is now "due before p_from", so the range and the backlog
--   never overlap.
--
-- Same authorisation as before (service role, or a signed-in ceo/cfo/coo/manager/
-- super_admin). The old one-argument signature is dropped so callers passing
-- only p_date resolve to this function.

DROP FUNCTION IF EXISTS public.get_next_day_payout_projection(date);

CREATE OR REPLACE FUNCTION public.get_next_day_payout_projection(
  p_date date DEFAULT NULL::date,
  p_from date DEFAULT NULL::date,
  p_cushion_pct numeric DEFAULT 10
)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_date date;
  v_from date;
  v_prev date;
  v_cushion_pct numeric := greatest(coalesce(p_cushion_pct, 0), 0);
  v_roi jsonb;
  v_by_day jsonb;
  v_landlord jsonb;
  v_withdrawals jsonb;
  v_partner_capital jsonb;
  v_backlog jsonb;
  v_roi_cash numeric;
  v_base numeric;
  v_cushion numeric;
BEGIN
  -- Service role (cron / edge function) has no auth.uid(); signed-in callers
  -- must hold an executive role.
  IF v_uid IS NOT NULL AND NOT (
       public.has_role(v_uid, 'ceo'::app_role)
    OR public.has_role(v_uid, 'cfo'::app_role)
    OR public.has_role(v_uid, 'coo'::app_role)
    OR public.has_role(v_uid, 'manager'::app_role)
    OR public.has_role(v_uid, 'super_admin'::app_role)
  ) THEN
    RAISE EXCEPTION 'forbidden: executive role required';
  END IF;

  -- Payout day. Default: tomorrow, skipping Saturday (6) and Sunday (0).
  v_date := coalesce(p_date, v_today + 1);
  IF p_date IS NULL THEN
    WHILE extract(dow FROM v_date) IN (0, 6) LOOP
      v_date := v_date + 1;
    END LOOP;
  END IF;

  -- First due date covered: the day after the previous payout day (weekday).
  IF p_from IS NOT NULL THEN
    v_from := least(p_from, v_date);
  ELSE
    v_prev := v_date - 1;
    WHILE extract(dow FROM v_prev) IN (0, 6) LOOP
      v_prev := v_prev - 1;
    END LOOP;
    v_from := v_prev + 1;
  END IF;

  -- 1. Supporter Returns due from v_from to v_date
  SELECT COALESCE(jsonb_agg(r ORDER BY r->>'due_date', r->>'channel', r->>'partner_name'), '[]'::jsonb)
    INTO v_roi
  FROM (
    SELECT jsonb_build_object(
      'portfolio_id', p.id,
      'portfolio_code', p.portfolio_code,
      'partner_name', COALESCE(NULLIF(trim(pr.full_name), ''), p.portfolio_code),
      'due_date', p.next_roi_date::date,
      'amount', round(p.investment_amount * p.roi_percentage / 100),
      'principal', p.investment_amount,
      'roi_percentage', p.roi_percentage,
      'compounding', (p.roi_mode ILIKE '%compound%'),
      'payment_method', p.payment_method,
      'channel', CASE
        WHEN p.roi_mode ILIKE '%compound%' THEN 'COMPOUNDING'
        WHEN p.payment_method = 'bank_transfer' OR (p.payment_method IS NULL AND p.bank_name IS NOT NULL)
          THEN CASE
            WHEN NULLIF(trim(p.bank_name), '') IS NULL THEN 'BANK (UNSPECIFIED)'
            -- "Centenary" and "CENTENARY BANK" must land in one group.
            WHEN upper(trim(p.bank_name)) LIKE '%BANK%' THEN upper(trim(p.bank_name))
            ELSE upper(trim(p.bank_name)) || ' BANK'
          END
        WHEN p.payment_method = 'mobile_money' OR p.mobile_money_number IS NOT NULL
          THEN upper(COALESCE(NULLIF(trim(p.mobile_network), ''), 'MOBILE')) || ' MOBILE MONEY'
        ELSE 'DESTINATION NOT SET'
      END,
      'destination_name', p.bank_account_name,
      'destination_number', COALESCE(p.account_number, p.mobile_money_number),
      'funded_on', (p.created_at AT TIME ZONE 'Africa/Kampala')::date,
      -- A first payout less than 25 days after funding is almost certainly a
      -- hand-edited next_roi_date (see WIP2609245978, 2026-09-25).
      'early_first_payout', ((p.next_roi_date::date - (p.created_at AT TIME ZONE 'Africa/Kampala')::date) < 25)
    ) AS r
    FROM public.investor_portfolios p
    LEFT JOIN public.profiles pr ON pr.id = COALESCE(p.investor_id, p.agent_id)
    WHERE p.status = 'active'
      AND p.next_roi_date::date BETWEEN v_from AND v_date
      AND NOT COALESCE(pr.is_frozen, false)
      AND pr.frozen_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.portfolio_action_requests a
         WHERE a.portfolio_id = p.id
           AND a.request_type = 'REDEMPTION_REQUEST'
           AND a.status IN ('pending', 'processing'))
  ) x;

  -- Per due date: cash vs compounding
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'due_date', d,
           'cash_count', cash_count, 'cash_total', cash_total,
           'compounding_count', comp_count, 'compounding_total', comp_total
         ) ORDER BY d), '[]'::jsonb)
    INTO v_by_day
  FROM (
    SELECT (e->>'due_date')::date AS d,
           count(*) FILTER (WHERE NOT (e->>'compounding')::boolean) AS cash_count,
           COALESCE(sum((e->>'amount')::numeric) FILTER (WHERE NOT (e->>'compounding')::boolean), 0) AS cash_total,
           count(*) FILTER (WHERE (e->>'compounding')::boolean) AS comp_count,
           COALESCE(sum((e->>'amount')::numeric) FILTER (WHERE (e->>'compounding')::boolean), 0) AS comp_total
      FROM jsonb_array_elements(v_roi) e
     GROUP BY 1
  ) b;

  -- 2. Landlord payouts queued tonight
  SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_landlord
  FROM (
    SELECT jsonb_build_object(
      'source', 'landlord_payout',
      'id', l.id,
      'status', l.status,
      'landlord_name', l.landlord_name,
      'landlord_phone', l.landlord_phone,
      'provider', l.mobile_money_provider,
      'amount', l.amount,
      'queued_at', l.created_at
    ) AS r
    FROM public.landlord_payouts l
    WHERE l.status = 'pending_merchant_payout'
    UNION ALL
    SELECT jsonb_build_object(
      'source', 'funded_rent_plan',
      'id', rr.id,
      'status', rr.status,
      'landlord_name', ll.name,
      'landlord_phone', ll.phone,
      'provider', NULL,
      'amount', rr.rent_amount,
      'queued_at', rr.funded_at
    )
    FROM public.rent_requests rr
    LEFT JOIN public.landlords ll ON ll.id = rr.landlord_id
    WHERE rr.status = 'funded'
      AND rr.funded_at > now() - interval '14 days'
      AND NOT EXISTS (SELECT 1 FROM public.landlord_payouts l2 WHERE l2.rent_request_id = rr.id)
  ) y;

  -- 3a. Wallet withdrawals still open
  SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_withdrawals
  FROM (
    SELECT jsonb_build_object(
      'id', w.id,
      'status', w.status,
      'name', COALESCE(NULLIF(trim(pr.full_name), ''), w.mobile_money_name),
      'amount', w.amount,
      'payout_method', w.payout_method,
      'channel', CASE
        WHEN w.payout_method ILIKE '%bank%' THEN upper(COALESCE(NULLIF(trim(w.bank_name), ''), 'BANK'))
        ELSE upper(COALESCE(NULLIF(trim(w.mobile_money_provider), ''), 'MOBILE')) || ' MOBILE MONEY'
      END,
      'destination_name', COALESCE(w.bank_account_name, w.mobile_money_name),
      'destination_number', COALESCE(w.bank_account_number, w.mobile_money_number),
      'requested_at', w.created_at
    ) AS r
    FROM public.withdrawal_requests w
    LEFT JOIN public.profiles pr ON pr.id = w.user_id
    WHERE NOT COALESCE(w.frozen, false)
      -- A landlord payout spawns a linked withdrawal_request; it is already
      -- counted under Landlord payouts, so skip it here (was double-counted).
      AND w.landlord_payout_id IS NULL
      AND (w.status = 'pending'
           OR (w.status = 'approved' AND w.created_at > now() - interval '7 days'))
  ) z;

  -- 3b. Partner capital withdrawals whose notice period ends by v_date
  SELECT COALESCE(jsonb_agg(r ORDER BY (r->>'amount')::numeric DESC), '[]'::jsonb)
    INTO v_partner_capital
  FROM (
    SELECT jsonb_build_object(
      'id', i.id,
      'status', i.status,
      'name', pr.full_name,
      'amount', i.amount,
      'earliest_process_date', i.earliest_process_date::date,
      'requested_at', i.requested_at
    ) AS r
    FROM public.investment_withdrawal_requests i
    LEFT JOIN public.profiles pr ON pr.id = i.user_id
    WHERE i.status NOT IN ('completed', 'rejected', 'cancelled')
      AND i.earliest_process_date::date <= v_date
  ) c;

  -- Backlog — counts only, excluded from totals. Returns past due = due
  -- before the range starts, so nothing is counted twice.
  SELECT jsonb_build_object(
    'roi_past_due', (SELECT jsonb_build_object('count', count(*),
        'amount', COALESCE(sum(round(investment_amount * roi_percentage / 100)), 0))
      FROM public.investor_portfolios
      WHERE status = 'active' AND next_roi_date::date < least(v_from, v_today)),
    'withdrawals_approved_stale', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0))
      FROM public.withdrawal_requests
      WHERE status = 'approved' AND created_at <= now() - interval '7 days'),
    'landlord_payouts_failed', (SELECT jsonb_build_object('count', count(*), 'amount', COALESCE(sum(amount), 0))
      FROM public.landlord_payouts WHERE status = 'failed')
  ) INTO v_backlog;

  v_roi_cash := (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_roi) e WHERE NOT (e->>'compounding')::boolean);
  v_base := v_roi_cash
          + (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_landlord) e)
          + (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_withdrawals) e)
          + (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_partner_capital) e);
  v_cushion := round(v_base * v_cushion_pct / 100);

  RETURN jsonb_build_object(
    'date', v_date,
    'from', v_from,
    'days', (v_date - v_from) + 1,
    'generated_at', now(),
    'roi', jsonb_build_object(
      'items', v_roi,
      'by_day', v_by_day,
      'cash_count', (SELECT count(*) FROM jsonb_array_elements(v_roi) e WHERE NOT (e->>'compounding')::boolean),
      'cash_total', v_roi_cash,
      'compounding_count', (SELECT count(*) FROM jsonb_array_elements(v_roi) e WHERE (e->>'compounding')::boolean),
      'compounding_total', (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_roi) e WHERE (e->>'compounding')::boolean)
    ),
    'landlord', jsonb_build_object(
      'items', v_landlord,
      'count', jsonb_array_length(v_landlord),
      'total', (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_landlord) e)
    ),
    'withdrawals', jsonb_build_object(
      'items', v_withdrawals,
      'count', jsonb_array_length(v_withdrawals),
      'total', (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_withdrawals) e)
    ),
    'partner_capital', jsonb_build_object(
      'items', v_partner_capital,
      'count', jsonb_array_length(v_partner_capital),
      'total', (SELECT COALESCE(sum((e->>'amount')::numeric), 0) FROM jsonb_array_elements(v_partner_capital) e)
    ),
    'plan', jsonb_build_object(
      'base_total', v_base,
      'cushion_pct', v_cushion_pct,
      'cushion', v_cushion,
      'total', v_base + v_cushion
    ),
    'backlog', v_backlog
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_next_day_payout_projection(date, date, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_next_day_payout_projection(date, date, numeric) TO authenticated, service_role;
