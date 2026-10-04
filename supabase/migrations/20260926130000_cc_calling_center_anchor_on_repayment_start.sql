-- Tenant Ops Calling Center: measure a tenant's repayment clock from when
-- repayment actually STARTS, not from when the plan was funded.
--
-- THE DEFECT
-- Three objects feeding the Calling Center (the tenant reveal panel, the
-- queue list's own "days"/"owing" badge, and the queue's call-priority
-- order) all anchor "days since the clock started" on
-- COALESCE(disbursed_at, funded_at, created_at) -- never checking
-- rent_requests.repayment_starts_on. Funding always happens before the
-- agreed repayment start date (confirmed live: every one of the 741 tenants
-- these objects currently cover has repayment_starts_on later than their
-- funding date, average gap 2.2 days, worst case 126 days), so every figure
-- is inflated by that gap, and any tenant whose repayment has not started
-- yet is shown a fabricated non-zero "days missed" instead of 0.
--
-- Confirmed example: Kulubya Simon (rent_request_id
-- eefc068e-7fa4-4929-bc7d-062c8087ead0) -- funded 2026-09-17,
-- repayment_starts_on 2026-09-25, amount_repaid 0. The Calling Center showed
-- "8 days missed" (today - funded date); the correct figure was 0
-- (repayment had not started).
--
-- THE REST OF THE PLATFORM ALREADY HAD THIS RIGHT
-- v_rent_plan_schedule, pin_agent_expected_day and the CRM's
-- v_crm_call_section (fixed 2026-09-24, see
-- supabase/migrations/20260924130000_defaulter_uses_repayment_start_not_funding.sql)
-- all already use COALESCE(repayment_starts_on, funded_at) as the term
-- start. This migration brings the three Tenant Ops Calling Center objects
-- into line with that same house convention -- it does not invent a new rule.
--
-- SCOPE: only the day-anchor used for "days since / arrears to date" changes.
-- funded_at and the plain funding-date column (funded_date in
-- v_tenant_ops_tenant_base) are left meaning exactly what they always meant
-- -- the day the plan was funded -- since other reports may reasonably read
-- "funded_date" as a literal funding date. Queue membership itself (any
-- funded/repaying tenant belongs in the queue) is untouched; only the
-- figures shown about each tenant change.
--
-- Each view below is a straight CREATE OR REPLACE of its own current live
-- definition (fetched fresh today, 2026-09-26) with only the funding-date
-- day-diff arithmetic repointed at repayment_starts_on first -- every output
-- column keeps its exact name, type and position, so nothing downstream
-- needs to change.

-- 1. Tenant reveal panel (TenantCallContextPanel.tsx -> useCcSubjectSnapshot.ts).
CREATE OR REPLACE VIEW public.v_tenant_daily_eligibility AS
 WITH active_rents AS (
         SELECT rr.id AS rent_request_id,
            rr.tenant_id,
            rr.agent_id,
            rr.landlord_id,
            COALESCE(rr.daily_repayment, 0::numeric) AS daily_repayment,
            COALESCE(rr.amount_repaid, 0::numeric) AS amount_repaid,
            COALESCE(rr.total_repayment, 0::numeric) AS total_repayment,
            COALESCE(rr.rent_amount, 0::numeric) AS rent_amount,
            COALESCE(rr.repayment_starts_on::timestamptz, rr.disbursed_at, rr.funded_at, rr.created_at) AS start_at,
            rr.status,
            rr.tenant_no_smartphone
           FROM rent_requests rr
          WHERE (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND rr.tenant_id IS NOT NULL AND COALESCE(rr.agent_payment_status, 'paying'::text) <> 'not_paying'::text
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
          WHERE a.rent_request_id IS NOT NULL AND a.paid_out_amount > 0::numeric
        )
 SELECT ar.rent_request_id,
    ar.tenant_id,
    ar.agent_id,
    ar.landlord_id,
    ar.daily_repayment,
    ar.amount_repaid,
    ar.total_repayment,
    ar.rent_amount,
    ar.start_at,
    ar.status,
    ar.tenant_no_smartphone
   FROM active_rents ar
     LEFT JOIN reversed rv ON rv.rent_request_id = ar.rent_request_id
     LEFT JOIN paused pz ON pz.rent_request_id = ar.rent_request_id
     LEFT JOIN landlord_settled ls ON ls.rent_request_id = ar.rent_request_id
     LEFT JOIN LATERAL ( SELECT count(*) AS open_allocs
           FROM agent_landlord_float_allocations oa2
          WHERE oa2.rent_request_id = ar.rent_request_id AND (oa2.status = ANY (ARRAY['open'::text, 'partially_paid'::text, 'return_pending'::text]))) oa ON true
  WHERE (rv.rent_request_id IS NULL OR ar.amount_repaid > 0::numeric) AND pz.rent_request_id IS NULL AND (ar.total_repayment - ar.amount_repaid) > 0::numeric AND (ls.rent_request_id IS NOT NULL OR ar.amount_repaid > 0::numeric OR COALESCE(oa.open_allocs, 0::bigint) = 0);

COMMENT ON VIEW public.v_tenant_daily_eligibility IS
'Active daily-eligible rent plans. start_at (fixed 2026-09-26) is COALESCE(repayment_starts_on, disbursed_at, funded_at, created_at) -- the tenant''s actual repayment clock start, not the funding date. Feeds the Calling Center reveal panel via useCcSubjectSnapshot.ts.';

-- 2. Queue call-priority order (cc_cycle_populations "tenants_active_plans").
CREATE OR REPLACE VIEW public.v_cc_tenant_calling_population AS
 WITH plan AS (
         SELECT DISTINCT ON (rr.tenant_id) rr.tenant_id,
            rr.id AS rent_request_id,
            COALESCE(rr.total_repayment, 0::numeric) AS total_repayment,
            COALESCE(rr.amount_repaid, 0::numeric) AS amount_repaid,
            COALESCE(rr.daily_repayment, 0::numeric) AS daily_repayment,
            rr.funded_at,
            rr.repayment_starts_on
           FROM rent_requests rr
          WHERE rr.tenant_id IS NOT NULL AND (rr.status = ANY (ARRAY['funded'::text, 'repaying'::text]))
          ORDER BY rr.tenant_id, rr.funded_at DESC NULLS LAST, rr.created_at DESC
        )
 SELECT tenant_id,
    rent_request_id,
    GREATEST(total_repayment - amount_repaid, 0::numeric) AS outstanding,
    GREATEST(
        CASE
            WHEN funded_at IS NULL OR daily_repayment <= 0::numeric THEN 0::numeric
            ELSE LEAST(total_repayment, daily_repayment * GREATEST((now() AT TIME ZONE 'Africa/Kampala'::text)::date - COALESCE(repayment_starts_on, (funded_at AT TIME ZONE 'Africa/Kampala'::text)::date), 0)::numeric)
        END - amount_repaid, 0::numeric) AS arrears_amount
   FROM plan p;

COMMENT ON VIEW public.v_cc_tenant_calling_population IS
'Tenant population for the Calling Center queue (cc_cycle_populations "tenants_active_plans"). arrears_amount (fixed 2026-09-26) is measured from repayment_starts_on, not funded_at -- membership itself (any funded/repaying tenant) is unchanged, only the call-priority ordering.';

-- 3. Queue list badge + detail-adjacent figures (v_cc_call_queue's arrears_amount,
--    outstanding, schedule_delta_days, days_since_funded, next_due_date).
CREATE OR REPLACE VIEW public.v_tenant_ops_tenant_base AS
 WITH latest_rr AS (
         SELECT DISTINCT ON (rr.tenant_id) rr.tenant_id,
            rr.id AS rent_request_id,
            rr.agent_id,
            rr.landlord_id,
            rr.status,
            rr.registration_type,
            rr.rent_amount,
            rr.total_repayment,
            rr.amount_repaid,
            rr.daily_repayment,
            rr.duration_days,
            rr.funded_at,
            rr.repayment_starts_on,
            rr.created_at AS rr_created_at,
            rr.tenancy_status,
            rr.agent_payment_status,
            rr.house_listing_id
           FROM rent_requests rr
          WHERE rr.tenant_id IS NOT NULL AND (rr.status <> ALL (ARRAY['rejected'::text, 'deleted_by_agent'::text]))
          ORDER BY rr.tenant_id, rr.created_at DESC
        ), pay AS (
         SELECT c.tenant_id,
            max(c.created_at) AS last_payment_at,
            sum(c.amount) AS lifetime_paid,
            sum(c.amount) FILTER (WHERE (c.created_at AT TIME ZONE 'Africa/Kampala'::text)::date = (now() AT TIME ZONE 'Africa/Kampala'::text)::date) AS paid_today,
            sum(c.amount) FILTER (WHERE (c.created_at AT TIME ZONE 'Africa/Kampala'::text)::date >= date_trunc('week'::text, (now() AT TIME ZONE 'Africa/Kampala'::text)::date::timestamp with time zone)::date) AS paid_week,
            sum(c.amount) FILTER (WHERE (c.created_at AT TIME ZONE 'Africa/Kampala'::text)::date >= date_trunc('month'::text, (now() AT TIME ZONE 'Africa/Kampala'::text)::date::timestamp with time zone)::date) AS paid_month,
            sum(c.amount) FILTER (WHERE (c.created_at AT TIME ZONE 'Africa/Kampala'::text)::date >= date_trunc('quarter'::text, (now() AT TIME ZONE 'Africa/Kampala'::text)::date::timestamp with time zone)::date) AS paid_quarter,
            sum(c.amount) FILTER (WHERE (c.created_at AT TIME ZONE 'Africa/Kampala'::text)::date >= date_trunc('year'::text, (now() AT TIME ZONE 'Africa/Kampala'::text)::date::timestamp with time zone)::date) AS paid_year
           FROM agent_collections c
          WHERE c.tenant_id IS NOT NULL
          GROUP BY c.tenant_id
        )
 SELECT tenant_id,
    tenant_name,
    tenant_phone,
    tenant_avatar_url,
    tenant_created_at,
    continent,
    country,
    region,
    district,
    ward,
    agent_id,
    landlord_id,
    rent_request_id,
    rr_status,
    registration_type,
    tenancy_status,
    agent_payment_status,
    house_listing_id,
    duration_days,
    rent_amount,
    total_repayment,
    amount_repaid,
    daily_repayment,
    funded_at,
    funded_date,
    days_since_funded,
    expected_to_date,
    is_active,
    last_payment_at,
    lifetime_paid,
    paid_today,
    paid_week,
    paid_month,
    paid_quarter,
    paid_year,
    GREATEST(total_repayment - amount_repaid, 0::numeric) AS outstanding,
    GREATEST(expected_to_date - amount_repaid, 0::numeric) AS arrears_amount,
    GREATEST(amount_repaid - expected_to_date, 0::numeric) AS advance_amount,
        CASE
            WHEN daily_repayment > 0::numeric THEN floor(amount_repaid / daily_repayment)::integer - days_since_funded
            ELSE NULL::integer
        END AS schedule_delta_days,
        CASE
            WHEN daily_repayment > 0::numeric AND funded_date IS NOT NULL AND (total_repayment - amount_repaid) > 0::numeric THEN funded_date + (floor(amount_repaid / daily_repayment)::integer + 1)
            ELSE NULL::date
        END AS next_due_date,
        CASE
            WHEN funded_date IS NOT NULL AND duration_days IS NOT NULL THEN funded_date + duration_days
            ELSE NULL::date
        END AS lease_end_date,
    district_id,
    subcounty_id
   FROM ( SELECT t.tenant_id,
            t.tenant_name,
            t.tenant_phone,
            t.tenant_avatar_url,
            t.tenant_created_at,
            continent_for_country(t.country) AS continent,
            t.country,
            t.region,
            t.district,
            t.ward,
            t.district_id,
            t.subcounty_id,
            COALESCE(lr.agent_id, t.agent_id) AS agent_id,
            COALESCE(lr.landlord_id, t.landlord_id) AS landlord_id,
            lr.rent_request_id,
            lr.status AS rr_status,
            lr.registration_type,
            lr.tenancy_status,
            lr.agent_payment_status,
            lr.house_listing_id,
            lr.duration_days,
            COALESCE(lr.rent_amount, 0::numeric) AS rent_amount,
            COALESCE(lr.total_repayment, 0::numeric) AS total_repayment,
            COALESCE(lr.amount_repaid, 0::numeric) AS amount_repaid,
            COALESCE(lr.daily_repayment, 0::numeric) AS daily_repayment,
            lr.funded_at,
            (lr.funded_at AT TIME ZONE 'Africa/Kampala'::text)::date AS funded_date,
            GREATEST(COALESCE((now() AT TIME ZONE 'Africa/Kampala'::text)::date - COALESCE(lr.repayment_starts_on, (lr.funded_at AT TIME ZONE 'Africa/Kampala'::text)::date), 0), 0) AS days_since_funded,
                CASE
                    WHEN lr.funded_at IS NULL OR COALESCE(lr.daily_repayment, 0::numeric) <= 0::numeric THEN 0::numeric
                    ELSE LEAST(COALESCE(lr.total_repayment, 0::numeric), lr.daily_repayment * GREATEST((now() AT TIME ZONE 'Africa/Kampala'::text)::date - COALESCE(lr.repayment_starts_on, (lr.funded_at AT TIME ZONE 'Africa/Kampala'::text)::date), 0)::numeric)
                END AS expected_to_date,
            (lr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND COALESCE(lr.agent_payment_status, 'paying'::text) <> 'not_paying'::text AS is_active,
            p.last_payment_at,
            COALESCE(p.lifetime_paid, 0::numeric) AS lifetime_paid,
            COALESCE(p.paid_today, 0::numeric) AS paid_today,
            COALESCE(p.paid_week, 0::numeric) AS paid_week,
            COALESCE(p.paid_month, 0::numeric) AS paid_month,
            COALESCE(p.paid_quarter, 0::numeric) AS paid_quarter,
            COALESCE(p.paid_year, 0::numeric) AS paid_year
           FROM ( SELECT pv.tenant_id,
                    pv.tenant_name,
                    pv.tenant_phone,
                    pv.tenant_avatar_url,
                    pv.country,
                    pv.region,
                    pv.district,
                    pv.ward,
                    pv.district_id,
                    pv.subcounty_id,
                    pv.agent_id,
                    pv.landlord_id,
                    pv.tenant_photo_url,
                    pv.house_image_urls,
                    pv.house_category,
                    pv.rent_amount,
                    pv.rent_request_id,
                    pv.tenant_created_at
                   FROM v_tenant_location_pivot pv
                  WHERE pv.tenant_id = ANY ((ARRAY( SELECT DISTINCT rr3.tenant_id
                           FROM rent_requests rr3
                          WHERE rr3.tenant_id IS NOT NULL AND (rr3.status <> ALL (ARRAY['rejected'::text, 'deleted_by_agent'::text])))))) t
             JOIN latest_rr lr ON lr.tenant_id = t.tenant_id
             LEFT JOIN pay p ON p.tenant_id = t.tenant_id) b;

COMMENT ON VIEW public.v_tenant_ops_tenant_base IS
'Per-tenant Tenant Ops summary (one row per tenant, latest rent_request). days_since_funded / expected_to_date / arrears_amount / schedule_delta_days (fixed 2026-09-26) are measured from repayment_starts_on when set, falling back to the funding date only when it is not -- previously measured from the funding date alone, inflating every figure by the funding-to-repayment-start gap and fabricating a nonzero figure for any tenant whose repayment has not started yet. funded_date/funded_at keep their original literal meaning (the funding date) and are unchanged; next_due_date/lease_end_date remain funded_date-anchored (unchanged in this fix, out of scope -- they are not consumed by the Calling Center).';
