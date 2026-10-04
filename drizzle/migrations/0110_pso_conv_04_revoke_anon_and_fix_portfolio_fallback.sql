REVOKE ALL ON FUNCTION public.pso_non_officer_series(date, date) FROM anon, public;
REVOKE ALL ON FUNCTION public.pso_non_officer_funded_summary(date, date) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.pso_non_officer_series(date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.pso_non_officer_funded_summary(date, date) TO authenticated;

CREATE OR REPLACE VIEW public.v_pso_conversions AS
 WITH ce AS (
         SELECT ce.id AS source_id,
            'commission_event'::text AS source,
            ce.kind AS conversion_kind,
            COALESCE(n_1.agent_id, ce.agent_id) AS officer_user_id,
            ce.note_id,
            ce.partner_id,
                CASE
                    WHEN ce.kind = 'portfolio_topup'::text THEN ce.base_amount
                    ELSE COALESCE(p.investment_amount, ce.base_amount)
                END AS amount_deployed,
            ce.base_amount AS commission_base,
            ce.amount AS commission_amount,
            ce.created_at AS converted_at
           FROM promissory_commission_events ce
             LEFT JOIN promissory_notes n_1 ON n_1.id = ce.note_id
             LEFT JOIN investor_portfolios p ON ce.source_table = 'investor_portfolios'::text AND p.id = ce.source_id::uuid
          WHERE ce.status = 'paid'::text
        ), ip AS (
         SELECT DISTINCT ON (p.id) p.id AS source_id,
            'investor_portfolio'::text AS source,
            'portfolio_creation'::text AS conversion_kind,
            n_1.agent_id AS officer_user_id,
            n_1.id AS note_id,
            n_1.partner_user_id AS partner_id,
            p.investment_amount AS amount_deployed,
            0::numeric AS commission_base,
            0::numeric AS commission_amount,
            p.created_at AS converted_at
           FROM promissory_notes n_1
             JOIN investor_portfolios p ON p.investor_id = n_1.partner_user_id AND p.created_at >= n_1.created_at
          WHERE n_1.partner_user_id IS NOT NULL AND (p.status = ANY (ARRAY['active'::text, 'locked'::text])) AND NOT (EXISTS ( SELECT 1
                   FROM promissory_commission_events x
                  WHERE x.status = 'paid'::text AND x.kind = 'portfolio_creation'::text AND x.source_table = 'investor_portfolios'::text AND x.source_id = p.id::text))
          ORDER BY p.id, n_1.created_at
        ), pi AS (
         SELECT b.intent_id AS source_id,
            'plan_intent'::text AS source,
            'rent_funding'::text AS conversion_kind,
            n_1.agent_id AS officer_user_id,
            b.note_id,
            n_1.partner_user_id AS partner_id,
            b.booked_amount::numeric AS amount_deployed,
            0::numeric AS commission_base,
            0::numeric AS commission_amount,
            b.funded_at AS converted_at
           FROM v_cfo_promissory_bookings b
             JOIN promissory_notes n_1 ON n_1.id = b.note_id
          WHERE b.funded_at IS NOT NULL
        ), allc AS (
         SELECT ce.source_id, ce.source, ce.conversion_kind, ce.officer_user_id, ce.note_id, ce.partner_id, ce.amount_deployed, ce.commission_base, ce.commission_amount, ce.converted_at
           FROM ce
        UNION ALL
         SELECT ip.source_id, ip.source, ip.conversion_kind, ip.officer_user_id, ip.note_id, ip.partner_id, ip.amount_deployed, ip.commission_base, ip.commission_amount, ip.converted_at
           FROM ip
        UNION ALL
         SELECT pi.source_id, pi.source, pi.conversion_kind, pi.officer_user_id, pi.note_id, pi.partner_id, pi.amount_deployed, pi.commission_base, pi.commission_amount, pi.converted_at
           FROM pi
        )
 SELECT a.source_id,
    a.source,
    a.conversion_kind,
    a.officer_user_id,
    o.staff_id,
    o.staff_ref,
    o.officer_since,
    a.note_id,
    a.partner_id,
    a.amount_deployed,
    a.commission_base,
    a.commission_amount,
    a.converted_at,
    (a.converted_at AT TIME ZONE 'Africa/Kampala'::text)::date AS converted_day,
    (n.created_at AT TIME ZONE 'Africa/Kampala'::text)::date < o.officer_since AS from_pre_enrolment_note
   FROM allc a
     JOIN v_pso_officers o ON o.user_id = a.officer_user_id
     LEFT JOIN promissory_notes n ON n.id = a.note_id
  WHERE a.converted_at IS NOT NULL;

ALTER VIEW public.v_pso_conversions SET (security_invoker = on);
REVOKE ALL ON public.v_pso_conversions FROM anon;
GRANT SELECT ON public.v_pso_conversions TO authenticated;