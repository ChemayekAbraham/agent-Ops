CREATE OR REPLACE VIEW public.v_agent_daily_eligibility AS
 WITH active_rents AS (
         SELECT rr.agent_id,
            rr.id AS rent_request_id,
            rr.daily_repayment,
            rr.amount_repaid,
            rr.total_repayment
           FROM rent_requests rr
          WHERE (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
        ), paused AS (
         SELECT DISTINCT p.rent_request_id
           FROM rent_repayment_pauses p
          WHERE p.status = 'active'::text AND p.resumed_at IS NULL AND (p.resume_on IS NULL OR p.resume_on >= (now() AT TIME ZONE 'Africa/Kampala'::text)::date)
        ), reversed AS (
         SELECT DISTINCT agent_tenant_float_reversals.rent_request_id
           FROM agent_tenant_float_reversals
        ), landlord_settled AS (
         SELECT DISTINCT a.rent_request_id
           FROM agent_landlord_float_allocations a
          WHERE a.rent_request_id IS NOT NULL
            AND a.paid_out_amount > 0::numeric
        ), eligible_rents AS (
         SELECT ar.agent_id,
            ar.rent_request_id,
            ar.daily_repayment,
            ar.amount_repaid,
            ar.total_repayment
           FROM active_rents ar
             LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
             LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
             LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
             LEFT JOIN LATERAL (
               SELECT count(*) AS open_allocs
                 FROM agent_landlord_float_allocations oa
                WHERE oa.rent_request_id = ar.rent_request_id
                  AND oa.status = ANY (ARRAY['open'::text, 'partially_paid'::text, 'return_pending'::text])
             ) oa ON true
          WHERE (rv.rent_request_id IS NULL OR COALESCE(ar.amount_repaid, 0::numeric) > 0::numeric)
            AND pz.rent_request_id IS NULL
            AND (COALESCE(ar.total_repayment, 0::numeric) - COALESCE(ar.amount_repaid, 0::numeric)) > 0::numeric
            -- The owing / daily-target list only opens once the landlord money
            -- for this tenant has actually gone out (a recorded payout against
            -- the landlord float allocation) or the tenant has already started
            -- repaying. Requests still sitting with an undisbursed allocation
            -- and zero repayment belong to "Ready to pay" only.
            AND (
              ls.rent_request_id IS NOT NULL
              OR COALESCE(ar.amount_repaid, 0::numeric) > 0::numeric
              OR COALESCE(oa.open_allocs, 0) = 0
            )
        ), expected AS (
         SELECT eligible_rents.agent_id,
            count(*)::integer AS active_count,
            COALESCE(sum(eligible_rents.daily_repayment), 0::numeric) AS expected_daily
           FROM eligible_rents
          GROUP BY eligible_rents.agent_id
        ), collection_events AS (
         SELECT ac.agent_id,
            ac.amount,
            ac.created_at
           FROM agent_collections ac
          WHERE ac.created_at >= (((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1)::timestamp without time zone AT TIME ZONE 'Africa/Kampala'::text)
        ), collected AS (
         SELECT ce.agent_id,
            sum(
                CASE
                    WHEN (ce.created_at AT TIME ZONE 'Africa/Kampala'::text)::date = (now() AT TIME ZONE 'Africa/Kampala'::text)::date THEN ce.amount
                    ELSE 0::numeric
                END) AS paid_today,
            sum(
                CASE
                    WHEN (ce.created_at AT TIME ZONE 'Africa/Kampala'::text)::date = ((now() AT TIME ZONE 'Africa/Kampala'::text)::date - 1) THEN ce.amount
                    ELSE 0::numeric
                END) AS paid_yesterday
           FROM collection_events ce
          GROUP BY ce.agent_id
        )
 SELECT e.agent_id,
    e.active_count,
    e.expected_daily,
    COALESCE(c.paid_today, 0::numeric) AS paid_today,
    COALESCE(c.paid_yesterday, 0::numeric) AS paid_yesterday,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_today, 0::numeric) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS today_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN round(COALESCE(c.paid_yesterday, 0::numeric) / e.expected_daily, 4)
            ELSE 0::numeric
        END AS yesterday_pct,
        CASE
            WHEN e.expected_daily > 0::numeric THEN GREATEST(COALESCE(c.paid_today, 0::numeric) / e.expected_daily, COALESCE(c.paid_yesterday, 0::numeric) / e.expected_daily)
            ELSE 0::numeric
        END AS effective_pct
   FROM expected e
     LEFT JOIN collected c USING (agent_id);