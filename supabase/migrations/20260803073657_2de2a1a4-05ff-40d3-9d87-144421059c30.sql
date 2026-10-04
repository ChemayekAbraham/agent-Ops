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
            rr.created_at AS rr_created_at,
            rr.tenancy_status,
            rr.agent_payment_status,
            rr.house_listing_id
           FROM rent_requests rr
          WHERE rr.tenant_id IS NOT NULL AND (rr.status <> ALL (ARRAY['rejected'::text, 'deleted_by_agent'::text]))
          ORDER BY rr.tenant_id, rr.created_at DESC
        ), pay AS (
         -- Single money source: agent_collections is the live field record.
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
        END AS lease_end_date
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
            GREATEST(COALESCE((now() AT TIME ZONE 'Africa/Kampala'::text)::date - (lr.funded_at AT TIME ZONE 'Africa/Kampala'::text)::date, 0), 0) AS days_since_funded,
                CASE
                    WHEN lr.funded_at IS NULL OR COALESCE(lr.daily_repayment, 0::numeric) <= 0::numeric THEN 0::numeric
                    ELSE LEAST(COALESCE(lr.total_repayment, 0::numeric), lr.daily_repayment * GREATEST((now() AT TIME ZONE 'Africa/Kampala'::text)::date - (lr.funded_at AT TIME ZONE 'Africa/Kampala'::text)::date, 0)::numeric)
                END AS expected_to_date,
            (lr.status = ANY (ARRAY['funded'::text, 'repaying'::text])) AND COALESCE(lr.agent_payment_status, 'paying'::text) <> 'not_paying'::text AS is_active,
            p.last_payment_at,
            COALESCE(p.lifetime_paid, 0::numeric) AS lifetime_paid,
            COALESCE(p.paid_today, 0::numeric) AS paid_today,
            COALESCE(p.paid_week, 0::numeric) AS paid_week,
            COALESCE(p.paid_month, 0::numeric) AS paid_month,
            COALESCE(p.paid_quarter, 0::numeric) AS paid_quarter,
            COALESCE(p.paid_year, 0::numeric) AS paid_year
           FROM v_tenant_location_pivot t
             -- Only people who actually have a rent plan count as tenants.
             JOIN latest_rr lr ON lr.tenant_id = t.tenant_id
             LEFT JOIN pay p ON p.tenant_id = t.tenant_id) b;