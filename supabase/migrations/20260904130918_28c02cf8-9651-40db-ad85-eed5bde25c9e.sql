create or replace view public.v_rent_plan_schedule
with (security_invoker = on) as
WITH pay AS (
         SELECT x.rent_request_id,
            max((x.created_at AT TIME ZONE 'Africa/Kampala'::text)::date) AS last_pay_date
           FROM ( SELECT agent_collections.rent_request_id,
                    agent_collections.created_at
                   FROM agent_collections
                  WHERE agent_collections.rent_request_id IS NOT NULL
                UNION ALL
                 SELECT repayments.rent_request_id,
                    repayments.created_at
                   FROM repayments
                  WHERE repayments.rent_request_id IS NOT NULL) x
          GROUP BY x.rent_request_id
        )
 SELECT rr.id AS rent_request_id,
    rr.agent_id,
    rr.tenant_id,
    COALESCE(rr.daily_repayment, 0::numeric) AS daily_amount,
    COALESCE(rr.total_repayment, 0::numeric) AS total_amount,
    COALESCE(rr.amount_repaid, 0::numeric) AS amount_repaid,
    s.term_start,
    s.term_end,
    COALESCE(rr.duration_days, 0) AS term_days,
    o.obligation_end,
    o.obligation_end - s.term_start + 1 AS oblig_days,
    (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric AS is_live
   FROM rent_requests rr
     LEFT JOIN pay ON pay.rent_request_id = rr.id
     CROSS JOIN LATERAL ( SELECT COALESCE(rr.repayment_starts_on, (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala'::text)::date) AS term_start,
            COALESCE(rr.repayment_starts_on, (COALESCE(rr.funded_at, rr.disbursed_at, rr.created_at) AT TIME ZONE 'Africa/Kampala'::text)::date) + COALESCE(rr.duration_days, 0) - 1 AS term_end) s
     CROSS JOIN LATERAL ( SELECT
                CASE
                    WHEN (COALESCE(rr.total_repayment, 0::numeric) - COALESCE(rr.amount_repaid, 0::numeric)) > 0::numeric THEN s.term_end
                    ELSE LEAST(s.term_end, GREATEST(s.term_start - 1, COALESCE(pay.last_pay_date, (rr.updated_at AT TIME ZONE 'Africa/Kampala'::text)::date, s.term_end)))
                END AS obligation_end) o
  WHERE s.term_start IS NOT NULL AND (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text, 'completed'::text])) AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text AND rr.tenancy_status = 'active'::text AND rr.tenancy_ended_at IS NULL AND COALESCE(rr.duration_days, 0) > 0 AND NOT (EXISTS ( SELECT 1
           FROM rent_repayment_pauses pz
          WHERE pz.rent_request_id = rr.id AND pz.status = 'active'::text AND pz.resumed_at IS NULL));

comment on view public.v_rent_plan_schedule is 'Canonical per-plan repayment schedule: term_start/term_end derived from repayment_starts_on (fallback funded/disbursed/created date in Kampala), obligation_end clamps settled plans to their last payment date so settled plans drop out of the daily schedule.';

revoke all on public.v_rent_plan_schedule from anon;