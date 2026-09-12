-- Align CFO receivables "Tenant Products & Services" with Tenant Operations,
-- which tracks Rent Access Plans only. Tenant Service Charges and Business
-- Advances move to "Unclassified / Other" (moved, not deleted). Amounts,
-- products, totals and tie-out validation are unchanged.
CREATE OR REPLACE VIEW public.v_receivables_lines AS
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'agent_advance'::text AS product_key,
    'Agent Advances'::text AS product_label,
    'agent_advances'::text AS source_table,
    a.id AS item_id,
    a.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(a.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(a.daily_installment, (0)::numeric), NULLIF(a.installment_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    a.status,
    a.created_at
   FROM (agent_advances a
     LEFT JOIN profiles p ON ((p.id = a.agent_id)))
  WHERE ((a.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (COALESCE(a.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'agent_advance_access_fee'::text AS product_key,
    'Agent Advance Access Fees'::text AS product_label,
    'agent_advances.access_fee'::text AS source_table,
    a.id AS item_id,
    a.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    (a.expires_at)::date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    COALESCE(a.access_fee_status, a.status) AS status,
    a.created_at
   FROM (agent_advances a
     LEFT JOIN profiles p ON ((p.id = a.agent_id)))
  WHERE ((a.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (GREATEST((COALESCE(a.access_fee, (0)::numeric) - COALESCE(a.access_fee_collected, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'credit_access_draw'::text AS product_key,
    'Credit Access Draws'::text AS product_label,
    'credit_access_draws'::text AS source_table,
    d.id AS item_id,
    COALESCE(d.agent_id, d.user_id) AS counterparty_id,
    COALESCE(p.full_name, 'Unknown borrower'::text) AS counterparty_name,
    GREATEST(COALESCE(d.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(d.daily_charge, (0)::numeric), (0)::numeric) AS daily_amount,
    d.status,
    d.created_at
   FROM (credit_access_draws d
     LEFT JOIN profiles p ON ((p.id = COALESCE(d.agent_id, d.user_id))))
  WHERE ((d.status = ANY (ARRAY['active'::text, 'overdue'::text])) AND (COALESCE(d.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'merchandise_recovery'::text AS product_key,
    'Merchandise & Smartphone Recovery'::text AS product_label,
    'merchandise_recovery_plans'::text AS source_table,
    r.id AS item_id,
    r.customer_id AS counterparty_id,
    COALESCE(NULLIF(r.customer_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(r.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(r.daily_deduction_amount, (0)::numeric), NULLIF(r.daily_rate, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (merchandise_recovery_plans r
     LEFT JOIN profiles p ON ((p.id = r.customer_id)))
  WHERE ((r.status = 'active'::text) AND (COALESCE(r.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'agent'::text AS category_key,
    'Agent Products & Services'::text AS category_label,
    'merchandise_credit_sale'::text AS product_key,
    'Merchandise Credit Sales'::text AS product_label,
    'merchandise_sales'::text AS source_table,
    s.id AS item_id,
    s.customer_id AS counterparty_id,
    COALESCE(NULLIF(s.client_name, ''::text), p.full_name, 'Unknown customer'::text) AS counterparty_name,
    GREATEST(COALESCE(s.amount_outstanding, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(s.access_daily_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    s.payment_status AS status,
    s.created_at
   FROM (merchandise_sales s
     LEFT JOIN profiles p ON ((p.id = s.customer_id)))
  WHERE ((COALESCE(s.amount_outstanding, (0)::numeric) > (0)::numeric) AND (COALESCE(s.payment_status, ''::text) <> 'paid'::text) AND (NOT (EXISTS ( SELECT 1
           FROM merchandise_recovery_plans rp
          WHERE ((rp.sale_id = s.id) AND (rp.status = 'active'::text))))))
UNION ALL
 SELECT 'service_centre'::text AS category_key,
    'Service Centre Products & Services'::text AS category_label,
    'service_centre_advance'::text AS product_key,
    'Service Centre Advances'::text AS product_label,
    'service_centre_advances'::text AS source_table,
    sa.id AS item_id,
    sa.agent_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST((COALESCE(sa.principal_amount, (0)::numeric) - COALESCE(sa.amount_recovered, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(sa.daily_deduction, (0)::numeric), (0)::numeric) AS daily_amount,
    sa.status,
    sa.created_at
   FROM (service_centre_advances sa
     LEFT JOIN profiles p ON ((p.id = sa.agent_id)))
  WHERE ((sa.status = 'active'::text) AND (GREATEST((COALESCE(sa.principal_amount, (0)::numeric) - COALESCE(sa.amount_recovered, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'service_centre'::text AS category_key,
    'Service Centre Products & Services'::text AS category_label,
    'service_centre_receivable'::text AS product_key,
    'Service Centre Receivables'::text AS product_label,
    'service_centre_receivables'::text AS source_table,
    r.id AS item_id,
    r.service_centre_id AS counterparty_id,
    COALESCE(NULLIF(s.location_name, ''::text), ('Service centre '::text || (r.service_centre_id)::text)) AS counterparty_name,
    GREATEST(COALESCE(r.recoverable_amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    r.start_date AS due_date,
    'scheduled'::text AS due_kind,
    COALESCE(NULLIF(r.daily_amount, (0)::numeric), (0)::numeric) AS daily_amount,
    r.status,
    r.created_at
   FROM (service_centre_receivables r
     LEFT JOIN service_centre_setups s ON ((s.id = r.service_centre_id)))
  WHERE ((r.status = 'active'::text) AND (GREATEST(COALESCE(r.recoverable_amount, (0)::numeric), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'tenant'::text AS category_key,
    'Tenant Products & Services'::text AS category_label,
    'rent_plan'::text AS product_key,
    'Rent Access Plans'::text AS product_label,
    'rent_requests'::text AS source_table,
    rr.id AS item_id,
    rr.tenant_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown tenant'::text) AS counterparty_name,
    GREATEST((COALESCE(NULLIF(rr.total_repayment, (0)::numeric), ((COALESCE(rr.rent_amount, (0)::numeric) + COALESCE(rr.access_fee, (0)::numeric)) + COALESCE(rr.request_fee, (0)::numeric))) - COALESCE(rr.amount_repaid, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    COALESCE(NULLIF(rr.daily_repayment, (0)::numeric), (0)::numeric) AS daily_amount,
    rr.status,
    rr.created_at
   FROM (rent_requests rr
     LEFT JOIN profiles p ON ((p.id = rr.tenant_id)))
  WHERE ((rr.status = ANY (ARRAY['funded'::text, 'disbursed'::text, 'repaying'::text])) AND (GREATEST((COALESCE(NULLIF(rr.total_repayment, (0)::numeric), ((COALESCE(rr.rent_amount, (0)::numeric) + COALESCE(rr.access_fee, (0)::numeric)) + COALESCE(rr.request_fee, (0)::numeric))) - COALESCE(rr.amount_repaid, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'other'::text AS category_key,
    'Unclassified / Other'::text AS category_label,
    'tenant_service_charge'::text AS product_key,
    'Tenant Service Charges'::text AS product_label,
    'subscription_charges'::text AS source_table,
    sc.id AS item_id,
    sc.tenant_id AS counterparty_id,
    COALESCE(p.full_name, 'Unknown tenant'::text) AS counterparty_name,
    GREATEST(COALESCE(sc.accumulated_debt, (0)::numeric), (0)::numeric) AS outstanding_amount,
    sc.next_charge_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    sc.status,
    sc.created_at
   FROM (subscription_charges sc
     LEFT JOIN profiles p ON ((p.id = sc.tenant_id)))
  WHERE ((sc.status = 'active'::text) AND (COALESCE(sc.accumulated_debt, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'other'::text AS category_key,
    'Unclassified / Other'::text AS category_label,
    'business_advance'::text AS product_key,
    'Business Advances'::text AS product_label,
    'business_advances'::text AS source_table,
    ba.id AS item_id,
    ba.tenant_id AS counterparty_id,
    COALESCE(p.full_name, NULLIF(ba.business_name, ''::text), 'Unknown business'::text) AS counterparty_name,
    GREATEST(COALESCE(ba.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    NULL::date AS due_date,
    'projected'::text AS due_kind,
    round((GREATEST(COALESCE(ba.outstanding_balance, (0)::numeric), (0)::numeric) * COALESCE(ba.daily_rate, (0)::numeric)), 2) AS daily_amount,
    (ba.status)::text AS status,
    ba.created_at
   FROM (business_advances ba
     LEFT JOIN profiles p ON ((p.id = ba.tenant_id)))
  WHERE (((ba.status)::text = ANY (ARRAY['active'::text, 'defaulted'::text])) AND (COALESCE(ba.outstanding_balance, (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products & Services'::text AS category_label,
    'welile_homes'::text AS product_key,
    'Welile Homes Subscriptions'::text AS product_label,
    'welile_homes_subscriptions'::text AS source_table,
    w.id AS item_id,
    w.landlord_id AS counterparty_id,
    COALESCE(NULLIF(w.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(w.outstanding_balance, (0)::numeric), (0)::numeric) AS outstanding_amount,
    w.next_due_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    w.subscription_status AS status,
    w.created_at
   FROM (welile_homes_subscriptions w
     LEFT JOIN profiles p ON ((p.id = w.landlord_id)))
  WHERE (COALESCE(w.outstanding_balance, (0)::numeric) > (0)::numeric)
UNION ALL
 SELECT 'landlord'::text AS category_key,
    'Landlord Products & Services'::text AS category_label,
    'landlord_float_receivable'::text AS product_key,
    'Landlord Float Receivables'::text AS product_label,
    'landlord_float_receivables'::text AS source_table,
    lfr.id AS item_id,
    lfr.landlord_id AS counterparty_id,
    COALESCE(NULLIF(lfr.landlord_name, ''::text), p.full_name, 'Unknown landlord'::text) AS counterparty_name,
    GREATEST(COALESCE(lfr.amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    lfr.promised_deposit_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    lfr.status,
    lfr.created_at
   FROM (landlord_float_receivables lfr
     LEFT JOIN profiles p ON ((p.id = lfr.landlord_id)))
  WHERE ((COALESCE(lfr.amount, (0)::numeric) > (0)::numeric) AND (COALESCE(lfr.status, ''::text) <> ALL (ARRAY['settled'::text, 'cancelled'::text])))
UNION ALL
 SELECT 'partner'::text AS category_key,
    'Partner Products & Services'::text AS category_label,
    'promissory_note'::text AS product_key,
    'Promissory Notes'::text AS product_label,
    'promissory_notes'::text AS source_table,
    n.id AS item_id,
    COALESCE(n.partner_user_id, n.agent_id) AS counterparty_id,
    COALESCE(NULLIF(n.partner_name, ''::text), 'Unknown partner'::text) AS counterparty_name,
    GREATEST((COALESCE(n.amount, (0)::numeric) - COALESCE(n.total_collected, (0)::numeric)), (0)::numeric) AS outstanding_amount,
    n.next_deduction_date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    n.status,
    n.created_at
   FROM promissory_notes n
  WHERE ((n.status = ANY (ARRAY['pending'::text, 'activated'::text])) AND (GREATEST((COALESCE(n.amount, (0)::numeric) - COALESCE(n.total_collected, (0)::numeric)), (0)::numeric) > (0)::numeric))
UNION ALL
 SELECT 'other'::text AS category_key,
    'Unclassified / Other'::text AS category_label,
    'field_collection_pending'::text AS product_key,
    'Unconfirmed Field Collections'::text AS product_label,
    'field_collections'::text AS source_table,
    fc.id AS item_id,
    fc.agent_id AS counterparty_id,
    COALESCE(NULLIF(fc.tenant_name, ''::text), p.full_name, 'Unknown agent'::text) AS counterparty_name,
    GREATEST(COALESCE(fc.amount, (0)::numeric), (0)::numeric) AS outstanding_amount,
    (fc.captured_at)::date AS due_date,
    'scheduled'::text AS due_kind,
    0 AS daily_amount,
    fc.status,
    fc.created_at
   FROM (field_collections fc
     LEFT JOIN profiles p ON ((p.id = fc.agent_id)))
  WHERE ((fc.status = 'pending'::text) AND (COALESCE(fc.amount, (0)::numeric) > (0)::numeric));