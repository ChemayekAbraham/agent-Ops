CREATE OR REPLACE VIEW public.v_receivables_lines AS
-- ── AGENT ───────────────────────────────────────────────────────────────────
SELECT 'agent'::text AS category_key, 'Agent Products & Services'::text AS category_label,
       'agent_advance'::text AS product_key, 'Agent Advances'::text AS product_label,
       'agent_advances'::text AS source_table, a.id AS item_id, a.agent_id AS counterparty_id,
       COALESCE(p.full_name, 'Unknown agent')::text AS counterparty_name,
       GREATEST(COALESCE(a.outstanding_balance,0),0)::numeric AS outstanding_amount,
       NULL::date AS due_date, 'projected'::text AS due_kind,
       COALESCE(NULLIF(a.daily_installment,0), NULLIF(a.installment_amount,0), 0)::numeric AS daily_amount,
       a.status::text, a.created_at
  FROM public.agent_advances a
  LEFT JOIN public.profiles p ON p.id = a.agent_id
 WHERE a.status IN ('active','overdue') AND COALESCE(a.outstanding_balance,0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'agent_advance_access_fee', 'Agent Advance Access Fees',
       'agent_advances.access_fee', a.id, a.agent_id,
       COALESCE(p.full_name, 'Unknown agent'),
       GREATEST(COALESCE(a.access_fee,0) - COALESCE(a.access_fee_collected,0), 0),
       a.expires_at::date, 'scheduled', 0,
       COALESCE(a.access_fee_status, a.status)::text, a.created_at
  FROM public.agent_advances a
  LEFT JOIN public.profiles p ON p.id = a.agent_id
 WHERE a.status IN ('active','overdue')
   AND GREATEST(COALESCE(a.access_fee,0) - COALESCE(a.access_fee_collected,0), 0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'credit_access_draw', 'Credit Access Draws', 'credit_access_draws',
       d.id, COALESCE(d.agent_id, d.user_id),
       COALESCE(p.full_name, 'Unknown borrower'),
       GREATEST(COALESCE(d.outstanding_balance,0),0),
       NULL::date, 'projected', COALESCE(NULLIF(d.daily_charge,0),0),
       d.status::text, d.created_at
  FROM public.credit_access_draws d
  LEFT JOIN public.profiles p ON p.id = COALESCE(d.agent_id, d.user_id)
 WHERE d.status IN ('active','overdue') AND COALESCE(d.outstanding_balance,0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'merchandise_recovery', 'Merchandise & Smartphone Recovery', 'merchandise_recovery_plans',
       r.id, r.customer_id,
       COALESCE(NULLIF(r.customer_name,''), p.full_name, 'Unknown customer'),
       GREATEST(COALESCE(r.outstanding_balance,0),0),
       NULL::date, 'projected', COALESCE(NULLIF(r.daily_deduction_amount,0), NULLIF(r.daily_rate,0), 0),
       r.status::text, r.created_at
  FROM public.merchandise_recovery_plans r
  LEFT JOIN public.profiles p ON p.id = r.customer_id
 WHERE r.status = 'active' AND COALESCE(r.outstanding_balance,0) > 0

UNION ALL
SELECT 'agent', 'Agent Products & Services',
       'merchandise_credit_sale', 'Merchandise Credit Sales', 'merchandise_sales',
       s.id, s.customer_id,
       COALESCE(NULLIF(s.client_name,''), p.full_name, 'Unknown customer'),
       GREATEST(COALESCE(s.amount_outstanding,0),0),
       NULL::date, 'projected', COALESCE(NULLIF(s.access_daily_amount,0),0),
       s.payment_status::text, s.created_at
  FROM public.merchandise_sales s
  LEFT JOIN public.profiles p ON p.id = s.customer_id
 WHERE COALESCE(s.amount_outstanding,0) > 0
   AND COALESCE(s.payment_status,'') <> 'paid'
   AND NOT EXISTS (SELECT 1 FROM public.merchandise_recovery_plans rp
                    WHERE rp.sale_id = s.id AND rp.status = 'active')

-- ── SERVICE CENTRE ───────────────────────────────────────────────────────────
UNION ALL
SELECT 'service_centre'::text AS category_key, 'Service Centre Products & Services'::text AS category_label,
       'service_centre_advance'::text AS product_key, 'Service Centre Advances'::text AS product_label,
       'service_centre_advances'::text AS source_table, sa.id AS item_id, sa.agent_id AS counterparty_id,
       COALESCE(p.full_name, 'Unknown agent')::text AS counterparty_name,
       GREATEST(COALESCE(sa.principal_amount,0) - COALESCE(sa.amount_recovered,0), 0)::numeric AS outstanding_amount,
       NULL::date AS due_date, 'projected'::text AS due_kind,
       COALESCE(NULLIF(sa.daily_deduction,0),0)::numeric AS daily_amount,
       sa.status::text, sa.created_at
  FROM public.service_centre_advances sa
  LEFT JOIN public.profiles p ON p.id = sa.agent_id
 WHERE sa.status = 'active'
   AND GREATEST(COALESCE(sa.principal_amount,0) - COALESCE(sa.amount_recovered,0), 0) > 0

UNION ALL
SELECT 'service_centre', 'Service Centre Products & Services',
       'service_centre_receivable', 'Service Centre Receivables', 'service_centre_receivables',
       r.id, r.service_centre_id,
       COALESCE(NULLIF(s.location_name,''), 'Service centre ' || r.service_centre_id::text),
       GREATEST(COALESCE(r.recoverable_amount,0),0),
       r.start_date, 'scheduled', COALESCE(NULLIF(r.daily_amount,0),0),
       r.status::text, r.created_at
  FROM public.service_centre_receivables r
  LEFT JOIN public.service_centre_setups s ON s.id = r.service_centre_id
 WHERE r.status = 'active'
   AND GREATEST(COALESCE(r.recoverable_amount,0),0) > 0

-- ── TENANT ──────────────────────────────────────────────────────────────────
UNION ALL
SELECT 'tenant', 'Tenant Products & Services',
       'rent_plan', 'Rent Access Plans', 'rent_requests',
       rr.id, rr.tenant_id,
       COALESCE(p.full_name, 'Unknown tenant'),
       GREATEST(COALESCE(NULLIF(rr.total_repayment,0),
                         COALESCE(rr.rent_amount,0) + COALESCE(rr.access_fee,0) + COALESCE(rr.request_fee,0))
                - COALESCE(rr.amount_repaid,0), 0),
       NULL::date, 'projected', COALESCE(NULLIF(rr.daily_repayment,0),0),
       rr.status::text, rr.created_at
  FROM public.rent_requests rr
  LEFT JOIN public.profiles p ON p.id = rr.tenant_id
 WHERE rr.status IN ('funded','disbursed','repaying')
   AND GREATEST(COALESCE(NULLIF(rr.total_repayment,0),
                         COALESCE(rr.rent_amount,0) + COALESCE(rr.access_fee,0) + COALESCE(rr.request_fee,0))
                - COALESCE(rr.amount_repaid,0), 0) > 0

UNION ALL
SELECT 'tenant', 'Tenant Products & Services',
       'tenant_service_charge', 'Tenant Service Charges', 'subscription_charges',
       sc.id, sc.tenant_id,
       COALESCE(p.full_name, 'Unknown tenant'),
       GREATEST(COALESCE(sc.accumulated_debt,0),0),
       sc.next_charge_date, 'scheduled', 0,
       sc.status::text, sc.created_at
  FROM public.subscription_charges sc
  LEFT JOIN public.profiles p ON p.id = sc.tenant_id
 WHERE sc.status = 'active' AND COALESCE(sc.accumulated_debt,0) > 0

UNION ALL
SELECT 'tenant', 'Tenant Products & Services',
       'business_advance', 'Business Advances', 'business_advances',
       ba.id, ba.tenant_id,
       COALESCE(p.full_name, NULLIF(ba.business_name,''), 'Unknown business'),
       GREATEST(COALESCE(ba.outstanding_balance,0),0),
       NULL::date, 'projected',
       ROUND(GREATEST(COALESCE(ba.outstanding_balance,0),0) * COALESCE(ba.daily_rate,0), 2),
       ba.status::text, ba.created_at
  FROM public.business_advances ba
  LEFT JOIN public.profiles p ON p.id = ba.tenant_id
 WHERE ba.status::text IN ('active','defaulted') AND COALESCE(ba.outstanding_balance,0) > 0

-- ── LANDLORD ────────────────────────────────────────────────────────────────
UNION ALL
SELECT 'landlord', 'Landlord Products & Services',
       'welile_homes', 'Welile Homes Subscriptions', 'welile_homes_subscriptions',
       w.id, w.landlord_id,
       COALESCE(NULLIF(w.landlord_name,''), p.full_name, 'Unknown landlord'),
       GREATEST(COALESCE(w.outstanding_balance,0),0),
       w.next_due_date, 'scheduled', 0,
       w.subscription_status::text, w.created_at
  FROM public.welile_homes_subscriptions w
  LEFT JOIN public.profiles p ON p.id = w.landlord_id
 WHERE COALESCE(w.outstanding_balance,0) > 0

UNION ALL
SELECT 'landlord', 'Landlord Products & Services',
       'landlord_float_receivable', 'Landlord Float Receivables', 'landlord_float_receivables',
       lfr.id, lfr.landlord_id,
       COALESCE(NULLIF(lfr.landlord_name,''), p.full_name, 'Unknown landlord'),
       GREATEST(COALESCE(lfr.amount,0),0),
       lfr.promised_deposit_date, 'scheduled', 0,
       lfr.status::text, lfr.created_at
  FROM public.landlord_float_receivables lfr
  LEFT JOIN public.profiles p ON p.id = lfr.landlord_id
 WHERE COALESCE(lfr.amount,0) > 0
   AND COALESCE(lfr.status,'') NOT IN ('settled','cancelled')

-- ── PARTNER ─────────────────────────────────────────────────────────────────
UNION ALL
SELECT 'partner', 'Partner Products & Services',
       'promissory_note', 'Promissory Notes', 'promissory_notes',
       n.id, COALESCE(n.partner_user_id, n.agent_id),
       COALESCE(NULLIF(n.partner_name,''), 'Unknown partner'),
       GREATEST(COALESCE(n.amount,0) - COALESCE(n.total_collected,0), 0),
       n.next_deduction_date, 'scheduled', 0,
       n.status::text, n.created_at
  FROM public.promissory_notes n
 WHERE n.status IN ('pending','activated')
   AND GREATEST(COALESCE(n.amount,0) - COALESCE(n.total_collected,0), 0) > 0

-- ── UNCLASSIFIED / OTHER ────────────────────────────────────────────────────
UNION ALL
SELECT 'other', 'Unclassified / Other',
       'field_collection_pending', 'Unconfirmed Field Collections', 'field_collections',
       fc.id, fc.agent_id,
       COALESCE(NULLIF(fc.tenant_name,''), p.full_name, 'Unknown agent'),
       GREATEST(COALESCE(fc.amount,0),0),
       fc.captured_at::date, 'scheduled', 0,
       fc.status::text, fc.created_at
  FROM public.field_collections fc
  LEFT JOIN public.profiles p ON p.id = fc.agent_id
 WHERE fc.status = 'pending' AND COALESCE(fc.amount,0) > 0;

COMMENT ON VIEW public.v_receivables_lines IS
  'Authoritative line-level receivables source. Every Total Receivables figure in the product must derive from this view via get_receivables_total/breakdown/forecast. Undisbursed items (credit draws and business advances awaiting CFO release) are excluded by design.';

CREATE OR REPLACE FUNCTION public.receivables_category_frame()
RETURNS TABLE(category_key text, category_label text, sort_order int)
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT * FROM (VALUES
    ('agent','Agent Products & Services',1),
    ('service_centre','Service Centre Products & Services',2),
    ('landlord','Landlord Products & Services',3),
    ('partner','Partner Products & Services',4),
    ('tenant','Tenant Products & Services',5),
    ('rnd','R&D',6),
    ('other','Unclassified / Other',7)
  ) f(category_key, category_label, sort_order)
$$;

GRANT EXECUTE ON FUNCTION public.receivables_category_frame() TO authenticated, service_role;