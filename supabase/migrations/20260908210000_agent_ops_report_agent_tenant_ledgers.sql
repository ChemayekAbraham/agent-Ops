-- Agent report: add per-tenant bio + itemized collection ledgers.
--
-- The Welile Agent report template has three pages. Page 3 ("Individual Tenant
-- Collection History Ledgers") needs, per tenant, a bio block and the itemized
-- receipts behind the summary on page 2. The RPC only returned page-1/page-2
-- aggregates, so page 3 could not be rendered at all.
--
-- Added to every element of `tenants`:
--   national_id, occupation      <- public.profiles (tenant)
--   location                     <- the TENANT's own stored address on
--                                   public.profiles: village/city, sub_county,
--                                   district (falling back to region)
--   house_type                   <- rent_requests.house_category
--   daily_repayment              <- rent_requests.daily_repayment
--   history[]                    <- itemized agent_collections rows in the window:
--                                   { at, ref, expected, collected, shortfall,
--                                     channel, status }
--
-- Location source, and why not the obvious ones:
--   * `house_listings` is a DIFFERENT thing (the marketplace listing) and is not
--     the tenant's address — its title/address are empty on these rows anyway.
--   * `v_tenant_location_pivot` is the canonical pivot but is far too expensive
--     to join here: measured 792 ms / 23,850 shared buffers for one agent,
--     because it materialises all ~30,900 tenant rows (seq scans over profiles
--     and rent_requests plus district/subcounty alias joins) before hashing down
--     to the ~44 we want.
--   * `profiles` already carries the resolved address columns the pivot is built
--     from, and the RPC ALREADY joins profiles for the tenant name/phone — so
--     reading them costs nothing extra.
--
-- Coverage measured on a real agent's 87 plans: district 87/87, region 87/87,
-- sub_county 66/87, village 32/87, city 28/87. The label therefore cascades from
-- most to least specific and simply omits what is missing, e.g.
-- "Kitala, Entebbe, Wakiso" or "Entebbe Division A, Wakiso".
--
-- Cost: `hist` is ONE grouped aggregate over agent_collections keyed by
-- rent_request_id, LEFT JOINed to the tenant set — no per-tenant query, no
-- fan-out, and the whole report stays a single round trip. Measured on a real
-- agent over an 8-day window: 52 collections across 16 tenants, max 7 rows for
-- any one tenant. A defensive per-tenant cap of 100 newest rows keeps a wide
-- range from producing an unbounded payload; `history_truncated` tells the
-- renderer when that cap bit.
--
-- History is scoped to the SAME window as the rest of the report (Africa/Kampala
-- dates, inclusive) so page 3 cannot contradict pages 1-2. Lifetime progress is
-- already carried by `collected_to_date` / `percentage`.
--
-- `shortfall` is the real per-receipt shortfall_amount. The static template
-- showed a running "Balance" column, but that cannot be reconstructed honestly
-- from stored data (amount_repaid at time of collection is not retained), so the
-- accurate figure is reported instead.
--
-- Everything else is unchanged: same signature, plpgsql, STABLE,
-- SECURITY DEFINER, search_path=public, same kpis/periods, same authorization
-- gate, same tenant ordering.

CREATE OR REPLACE FUNCTION public.agent_ops_report_agent(p_agent_id uuid, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent jsonb; v_tenants jsonb; v_periods jsonb; v_k record; v_expected numeric;
BEGIN
  IF NOT public.agent_ops_report_authorized() THEN RAISE EXCEPTION 'not_authorized'; END IF;
  IF p_agent_id IS NULL OR p_from IS NULL OR p_to IS NULL THEN RAISE EXCEPTION 'bad_request'; END IF;

  SELECT jsonb_build_object('agent_id', p.id, 'full_name', p.full_name, 'phone', p.phone,
                            'territory', p.territory)
    INTO v_agent
  FROM public.profiles p WHERE p.id = p_agent_id;

  WITH plans AS (
    SELECT rr.id, rr.tenant_id, rr.rent_amount, rr.total_repayment, rr.daily_repayment,
           COALESCE(rr.amount_repaid,0) AS amount_repaid, rr.status,
           rr.house_category
    FROM public.rent_requests rr
    WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id)
      AND rr.status IN ('funded','repaying','completed')
  ), coll AS (
    SELECT ac.rent_request_id,
           SUM(ac.amount) AS collected_window,
           COUNT(*) AS payments,
           MAX(ac.created_at) AS last_at
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.rent_request_id IN (SELECT id FROM plans)
    GROUP BY ac.rent_request_id
  ), rows_ranked AS (
    -- Itemized receipts, newest first, ranked so the per-tenant cap is cheap.
    SELECT ac.rent_request_id, ac.created_at, ac.amount, ac.expected_amount,
           ac.shortfall_amount, ac.is_partial, ac.collection_channel,
           ac.payment_method, ac.momo_provider, ac.tracking_id, ac.momo_transaction_id,
           row_number() OVER (PARTITION BY ac.rent_request_id ORDER BY ac.created_at DESC) AS rn,
           count(*)     OVER (PARTITION BY ac.rent_request_id) AS total_rn
    FROM public.agent_collections ac
    WHERE ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
      AND ac.rent_request_id IN (SELECT id FROM plans)
  ), hist AS (
    SELECT r.rent_request_id,
           bool_or(r.total_rn > 100) AS truncated,
           jsonb_agg(jsonb_build_object(
             'at',        r.created_at,
             'ref',       COALESCE(NULLIF(TRIM(r.tracking_id),''), NULLIF(TRIM(r.momo_transaction_id),'')),
             'expected',  r.expected_amount,
             'collected', r.amount,
             'shortfall', COALESCE(r.shortfall_amount, 0),
             'channel',   COALESCE(
                            NULLIF(TRIM(r.collection_channel),''),
                            NULLIF(TRIM(r.momo_provider),''),
                            NULLIF(TRIM(r.payment_method::text),'')
                          ),
             'status',    CASE WHEN COALESCE(r.is_partial,false) OR COALESCE(r.shortfall_amount,0) > 0
                               THEN 'Partial' ELSE 'Settled' END
           ) ORDER BY r.created_at DESC) AS history
    FROM rows_ranked r
    WHERE r.rn <= 100
    GROUP BY r.rent_request_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'rent_request_id', x.id,
           'tenant_name', x.tenant_name,
           'tenant_phone', x.tenant_phone,
           'rent_amount', x.rent_amount,
           'outstanding', x.outstanding,
           'repayment', x.total_repayment,
           'collected', x.collected_window,
           'collected_to_date', x.amount_repaid,
           'payments', x.payments,
           'percentage', x.percentage,
           'last_collection_at', x.last_at,
           'status', x.status,
           'national_id', x.national_id,
           'occupation', x.occupation,
           'location', x.location,
           'house_type', x.house_type,
           'daily_repayment', x.daily_repayment,
           'history', COALESCE(x.history, '[]'::jsonb),
           'history_truncated', COALESCE(x.truncated, false)
         ) ORDER BY x.collected_window DESC NULLS LAST, x.tenant_name), '[]'::jsonb)
    INTO v_tenants
  FROM (
    SELECT pl.id, pl.rent_amount, pl.total_repayment, pl.amount_repaid, pl.status,
           pl.daily_repayment,
           tp.full_name AS tenant_name, tp.phone AS tenant_phone,
           tp.national_id, tp.occupation,
           COALESCE(
             NULLIF(CONCAT_WS(', ',
               NULLIF(TRIM(COALESCE(tp.village, tp.city)),''),
               NULLIF(TRIM(tp.sub_county),''),
               NULLIF(TRIM(tp.district),'')
             ), ''),
             NULLIF(TRIM(tp.region),'')
           ) AS location,
           NULLIF(TRIM(pl.house_category),'') AS house_type,
           GREATEST(COALESCE(pl.total_repayment,0) - pl.amount_repaid, 0) AS outstanding,
           COALESCE(c.collected_window,0) AS collected_window,
           COALESCE(c.payments,0) AS payments,
           c.last_at,
           h.history, h.truncated,
           CASE WHEN COALESCE(pl.total_repayment,0) > 0
                THEN ROUND(pl.amount_repaid * 100.0 / pl.total_repayment, 1) ELSE NULL END AS percentage
    FROM plans pl
    LEFT JOIN public.profiles tp ON tp.id = pl.tenant_id
    LEFT JOIN coll c ON c.rent_request_id = pl.id
    LEFT JOIN hist h ON h.rent_request_id = pl.id
    WHERE pl.status IN ('funded','repaying') OR c.rent_request_id IS NOT NULL
  ) x;

  WITH days AS (SELECT d::date AS day FROM generate_series(p_from, p_to, interval '1 day') d),
  exp AS (
    SELECT h.day, SUM(h.expected_daily) AS expected
    FROM public.agent_daily_eligibility_history h
    WHERE h.agent_id = p_agent_id AND h.day BETWEEN p_from AND p_to
    GROUP BY h.day
  ), got AS (
    SELECT (ac.created_at AT TIME ZONE 'Africa/Kampala')::date AS day,
           SUM(ac.amount) AS collected, COUNT(*) AS payments
    FROM public.agent_collections ac
    WHERE ac.agent_id = p_agent_id AND ac.amount > 0
      AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to
    GROUP BY 1
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'period', to_char(d.day,'YYYY-MM-DD'),
           'expected', COALESCE(e.expected,0),
           'collected', COALESCE(g.collected,0),
           'payments', COALESCE(g.payments,0),
           'shortfall', GREATEST(COALESCE(e.expected,0) - COALESCE(g.collected,0), 0),
           'rate', CASE WHEN COALESCE(e.expected,0) > 0
                        THEN ROUND(COALESCE(g.collected,0) * 100.0 / e.expected, 1) ELSE NULL END
         ) ORDER BY d.day), '[]'::jsonb)
    INTO v_periods
  FROM days d
  LEFT JOIN exp e ON e.day = d.day
  LEFT JOIN got g ON g.day = d.day;

  SELECT COALESCE(SUM(e.expected),0) INTO v_expected
  FROM public.agent_ops_report_expected(p_from, p_to) e WHERE e.agent_id = p_agent_id;

  SELECT
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS assigned_tenants,
    (SELECT COUNT(*) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying')) AS active_repaying,
    (SELECT COALESCE(SUM(rr.rent_amount),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS rent_total,
    (SELECT COALESCE(SUM(rr.total_repayment),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repayment_total,
    (SELECT COALESCE(SUM(rr.amount_repaid),0) FROM public.rent_requests rr WHERE (rr.agent_id = p_agent_id OR rr.assigned_agent_id = p_agent_id) AND rr.status IN ('funded','repaying','completed')) AS repaid_total,
    (SELECT COALESCE(SUM(ac.amount),0) FROM public.agent_collections ac WHERE ac.agent_id = p_agent_id AND ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS collected_window,
    (SELECT COUNT(*) FROM public.agent_collections ac WHERE ac.agent_id = p_agent_id AND ac.amount > 0 AND (ac.created_at AT TIME ZONE 'Africa/Kampala')::date BETWEEN p_from AND p_to) AS payments_window
  INTO v_k;

  RETURN jsonb_build_object(
    'agent', COALESCE(v_agent,'{}'::jsonb),
    'range', jsonb_build_object('from', p_from, 'to', p_to),
    'kpis', jsonb_build_object(
      'assigned_tenants', v_k.assigned_tenants,
      'active_repaying', v_k.active_repaying,
      'rent_total', v_k.rent_total,
      'repayment_total', v_k.repayment_total,
      'collected_to_date', v_k.repaid_total,
      'outstanding', GREATEST(v_k.repayment_total - v_k.repaid_total, 0),
      'expected_window', v_expected,
      'collected_window', v_k.collected_window,
      'payments_window', v_k.payments_window,
      'repayment_rate', CASE WHEN v_k.repayment_total > 0 THEN ROUND(v_k.repaid_total*100.0/v_k.repayment_total,1) END,
      'window_rate', CASE WHEN v_expected > 0 THEN ROUND(v_k.collected_window*100.0/v_expected,1) END
    ),
    'tenants', v_tenants,
    'periods', v_periods
  );
END;
$function$;
