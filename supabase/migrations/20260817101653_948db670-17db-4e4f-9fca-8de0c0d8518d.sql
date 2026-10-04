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
    (
      SELECT v FROM (
        VALUES
          (NULLIF(btrim(ll.phone), ''::text)),
          (NULLIF(btrim(ll.mobile_money_number), ''::text)),
          (NULLIF(btrim(ll2.phone), ''::text)),
          (NULLIF(btrim(ll2.mobile_money_number), ''::text)),
          (NULLIF(btrim(lp.phone), ''::text))
      ) AS cand(v)
      WHERE v IS NOT NULL
        AND right(regexp_replace(v, '\D', '', 'g'), 9)
            IS DISTINCT FROM right(regexp_replace(COALESCE(tp.phone, ''), '\D', '', 'g'), 9)
      LIMIT 1
    ) AS landlord_phone,
    COALESCE(NULLIF(btrim(lcp.name), ''::text), 'LC1 not recorded'::text) AS lc1_chairperson_name
   FROM rent_requests rr
     LEFT JOIN profiles tp ON tp.id = rr.tenant_id
     LEFT JOIN profiles lp ON lp.id = rr.landlord_id
     LEFT JOIN landlords ll ON ll.id = rr.landlord_id
     LEFT JOIN landlords ll2 ON ll2.tenant_id = rr.tenant_id
     LEFT JOIN lc1_chairpersons lcp ON lcp.id = rr.lc1_id
     LEFT JOIN partner_self_plan_claims c ON c.rent_request_id = rr.id AND (c.status = ANY (ARRAY['held'::text, 'confirmed'::text])) AND (c.status = 'confirmed'::text OR c.expires_at > now())
  WHERE rr.funded_at IS NULL AND rr.disbursed_at IS NULL AND rr.supporter_id IS NULL AND rr.self_funding_partner_id IS NULL AND rr.tenancy_status = 'active'::text AND rr.coo_reviewed_at IS NOT NULL AND rr.rent_amount >= 50000::numeric AND (rr.status = ANY (ARRAY['pending'::text, 'approved'::text, 'agent_ops_approved'::text, 'tenant_ops_approved'::text, 'landlord_ops_approved'::text, 'agent_verified'::text, 'coo_approved'::text]));