-- Read-only evidence helpers, private to the caller-checked CFO reports.
CREATE OR REPLACE FUNCTION public._cfo_tracker_direct_receipt(p_receipt uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
 SELECT EXISTS (
   SELECT 1 FROM public.agent_collections c JOIN public.rent_requests p ON p.id=c.rent_request_id
   WHERE c.id=p_receipt AND c.tenant_id=p.tenant_id AND c.reversed_at IS NULL
     AND COALESCE(c.notes,'') NOT ILIKE '%[REVERSED:%'
     AND c.created_at >= TIMESTAMPTZ '2026-10-01 00:00:00+03'
     AND (SELECT count(*) FROM public.agent_collections c2 WHERE c2.rent_request_id=c.rent_request_id AND c2.amount=c.amount
           AND abs(extract(epoch FROM c2.created_at-c.created_at)) <= 1)=1
     AND (SELECT count(*) FROM public.general_ledger g WHERE g.source_table='rent_requests' AND g.source_id=c.rent_request_id
           AND g.amount=c.amount AND g.direction='cash_in' AND g.ledger_scope='platform'
           AND g.classification IN ('production','legacy_real') AND g.transaction_date >= TIMESTAMPTZ '2026-10-01 00:00:00+03'
           AND left(COALESCE(g.idempotency_key,''),30)<>'smartphone_a10_to_a12_reclass:'
           AND left(COALESCE(g.idempotency_key,''),34)<>'merch_a12_a13_correction_20261104:'
           AND left(COALESCE(g.idempotency_key,''),19)<>'merch_recv_derecog:'
           AND public._cfo_received_category_for(g.category,g.source_table)='land'
           AND abs(extract(epoch FROM g.created_at-c.created_at)) <= 1
           AND NOT EXISTS (SELECT 1 FROM public.general_ledger rev WHERE rev.transaction_group_id=g.transaction_group_id
             AND rev.source_id=g.source_id AND rev.ledger_scope='platform' AND rev.direction='cash_out'
             AND public._cfo_received_category_for(rev.category,rev.source_table)='land'))=1
 )
$fn$;
REVOKE ALL ON FUNCTION public._cfo_tracker_direct_receipt(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._cfo_tracker_direct_receipt(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public._cfo_tracker_payment_change(p_change uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
 SELECT EXISTS (
   SELECT 1 FROM public.rent_amount_change_log l JOIN public.rent_requests p ON p.id=l.rent_request_id
   WHERE l.id=p_change AND l.source IS NULL
     AND COALESCE(l.new_total_repayment,0)=COALESCE(l.old_total_repayment,0)
     AND COALESCE(l.new_amount_repaid,0)>COALESCE(l.old_amount_repaid,0)
     AND l.changed_at >= TIMESTAMPTZ '2026-10-01 00:00:00+03'
     AND (SELECT count(*) FROM public.rent_amount_change_log l2 WHERE l2.rent_request_id=l.rent_request_id
           AND COALESCE(l2.new_amount_repaid,0)-COALESCE(l2.old_amount_repaid,0)=COALESCE(l.new_amount_repaid,0)-COALESCE(l.old_amount_repaid,0)
           AND abs(extract(epoch FROM l2.changed_at-l.changed_at))<=1)=1
     AND (SELECT count(*) FROM public.repayments r WHERE r.rent_request_id=l.rent_request_id AND r.tenant_id=p.tenant_id
           AND r.amount=COALESCE(l.new_amount_repaid,0)-COALESCE(l.old_amount_repaid,0)
           AND r.created_at=l.changed_at)=1
     AND NOT EXISTS (SELECT 1 FROM public.agent_collections c WHERE c.rent_request_id=l.rent_request_id
           AND c.amount=COALESCE(l.new_amount_repaid,0)-COALESCE(l.old_amount_repaid,0)
           AND abs(extract(epoch FROM c.created_at-l.changed_at))<=1
           AND (c.reversed_at IS NOT NULL OR COALESCE(c.notes,'') ILIKE '%[REVERSED:%'))
     AND (SELECT count(*) FROM public.general_ledger g WHERE g.source_table IN ('rent_requests','agent_collections') AND g.source_id=l.rent_request_id
           AND g.amount=COALESCE(l.new_amount_repaid,0)-COALESCE(l.old_amount_repaid,0) AND g.direction='cash_in' AND g.ledger_scope='platform'
           AND g.classification IN ('production','legacy_real') AND g.transaction_date >= TIMESTAMPTZ '2026-10-01 00:00:00+03'
           AND left(COALESCE(g.idempotency_key,''),30)<>'smartphone_a10_to_a12_reclass:'
           AND left(COALESCE(g.idempotency_key,''),34)<>'merch_a12_a13_correction_20261104:'
           AND left(COALESCE(g.idempotency_key,''),19)<>'merch_recv_derecog:'
           AND public._cfo_received_category_for(g.category,g.source_table)='land'
           AND abs(extract(epoch FROM g.created_at-l.changed_at))<=1
           AND NOT EXISTS (SELECT 1 FROM public.general_ledger rev WHERE rev.transaction_group_id=g.transaction_group_id
             AND rev.source_id=g.source_id AND rev.ledger_scope='platform' AND rev.direction='cash_out'
             AND public._cfo_received_category_for(rev.category,rev.source_table)='land'))=1
 )
$fn$;
REVOKE ALL ON FUNCTION public._cfo_tracker_payment_change(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._cfo_tracker_payment_change(uuid) TO service_role;

DO $patch$
DECLARE original text; revised text;
BEGIN
 original := pg_get_functiondef('public._cfo_tenant_repayment_rows(uuid)'::regprocedure);
 IF md5(rtrim(original, E'\n')) <> '5fdcb404a0aca18fe4dc76216bb2b032' THEN RAISE EXCEPTION 'Reporting definition changed: _cfo_tenant_repayment_rows(uuid); review before applying'; END IF;
 revised := original;
revised := replace(revised,$old$AND abs(extract(epoch FROM g.created_at - c.created_at)) < 300)) not_posted$old$,$new$AND abs(extract(epoch FROM g.created_at - c.created_at)) < 300)
                              AND NOT public._cfo_tracker_direct_receipt(c.id)) not_posted$new$);
revised := replace(revised,$old$AND abs(extract(epoch FROM c.created_at - l.changed_at)) < 120)) unreceipted_inc,$old$,$new$AND abs(extract(epoch FROM c.created_at - l.changed_at)) < 120)
               AND NOT public._cfo_tracker_payment_change(l.id)) unreceipted_inc,$new$);
revised := replace(revised,$old$ORDER BY x.funded_at DESC NULLS LAST, x.created_at DESC$old$,$new$ORDER BY x.funded_at DESC NULLS LAST, x.created_at DESC, x.id DESC$new$);
EXECUTE revised;
 original := pg_get_functiondef('public.get_cfo_tenant_repayment_detail(uuid)'::regprocedure);
 IF md5(rtrim(original, E'\n')) <> '1c881de8e7118a17708cf393363477b9' THEN RAISE EXCEPTION 'Reporting definition changed: get_cfo_tenant_repayment_detail(uuid); review before applying'; END IF;
 revised := original;
revised := replace(revised,$old$AND abs(extract(epoch FROM g.created_at - c.created_at)) < 300),$old$,$new$AND abs(extract(epoch FROM g.created_at - c.created_at)) < 300) OR public._cfo_tracker_direct_receipt(c.id),$new$);
revised := replace(revised,$old$'kind', CASE WHEN l.source IS NOT NULL$old$,$new$'kind', CASE WHEN public._cfo_tracker_payment_change(l.id) THEN 'Payment-backed repayment change' WHEN l.source IS NOT NULL$new$);
revised := replace(revised,$old$    'plan', v_plan,
$old$,$new$    'plan', v_plan,
    'tenant_context', jsonb_build_object(
      'tenant_id', v_plan->>'tenant_id', 'rent_request_id', p_rent_request_id,
      'tenant_status', (SELECT p.tenant_status FROM public.profiles p WHERE p.id=(v_plan->>'tenant_id')::uuid),
      'last_active_at', (SELECT p.last_active_at FROM public.profiles p WHERE p.id=(v_plan->>'tenant_id')::uuid),
      'plan_activity', (SELECT to_jsonb(a) FROM (SELECT t.state,t.days_idle,t.last_collection_at,t.updated_at
                         FROM public.tenant_idle_states t WHERE t.rent_request_id=p_rent_request_id AND t.tenant_id=(v_plan->>'tenant_id')::uuid) a),
      'other_plans', COALESCE((SELECT jsonb_agg(jsonb_build_object('rent_request_id',r.id,'status',r.status,'created_at',r.created_at) ORDER BY r.created_at DESC,r.id DESC)
                      FROM public.rent_requests r WHERE r.tenant_id=(v_plan->>'tenant_id')::uuid AND r.id<>p_rent_request_id
                        AND (r.funded_at IS NOT NULL OR r.disbursed_at IS NOT NULL OR r.status IN ('funded','repaying','completed'))), '[]'::jsonb)),
$new$);
EXECUTE revised;
END $patch$;
