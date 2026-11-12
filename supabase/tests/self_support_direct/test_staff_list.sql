-- 20261117130000: Financial Ops list + shared staff check.
SET client_min_messages = warning;
UPDATE public.pipeline_switches SET is_on = true WHERE key = 'self_support_merchant_direct';

CALL tt.run('F01', 'Financial Ops list: attention filter shows held and overdue only; buttons follow the merchant state', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); fo uuid := tt.person('Fin Ops', ARRAY['financial_ops']);
        a uuid := tt.plan(300000); b uuid := tt.plan(300000); c uuid := tt.plan(300000); r jsonb; j jsonb; row jsonb;
BEGIN
  PERFORM tt.float(pa, 2000000);
  PERFORM tt.as_user(pa);
  r := funder_support_tenant_direct(ARRAY[a]); r := funder_support_tenant_direct(ARRAY[b]); r := funder_support_tenant_direct(ARRAY[c]);
  PERFORM tt.as_user(NULL);
  -- a: held (failed while the merchant was settling); b: overdue; c: fresh
  UPDATE withdrawal_requests SET status = 'processing' WHERE id = (tt.payment(a)).withdrawal_request_id;
  UPDATE landlord_payouts SET status = 'failed', last_error = 'x' WHERE id = (tt.payment(a)).landlord_payout_id;
  UPDATE self_support_landlord_payments SET expires_at = now() - interval '1 hour' WHERE id = (tt.payment(b)).id;
  PERFORM tt.as_user(fo);
  j := self_support_staff_landlord_payments();
  ASSERT (SELECT count(*) FROM jsonb_array_elements(j) e WHERE (e->>'rent_request_id')::uuid IN (a, b, c)) = 2, 'a and b only: ' || j;
  SELECT e INTO row FROM jsonb_array_elements(j) e WHERE (e->>'rent_request_id')::uuid = a;
  ASSERT (row->>'can_refund')::boolean AND NOT (row->>'can_mark_paid')::boolean AND row->>'withdrawal_status' = 'processing'
     AND row->>'payout_status' = 'failed' AND jsonb_array_length(row->'partners') = 1 AND (row->'partners'->0->>'share')::numeric = 306000,
     'held row ' || row;
  SELECT e INTO row FROM jsonb_array_elements(j) e WHERE (e->>'rent_request_id')::uuid = b;
  ASSERT (row->>'overdue')::boolean, 'overdue row';
  j := self_support_staff_landlord_payments('queued');
  ASSERT (SELECT count(*) FROM jsonb_array_elements(j) e WHERE (e->>'rent_request_id')::uuid IN (a, b, c)) = 3, 'queued shows all three';
  -- settle a as paid once the merchant confirms
  PERFORM tt.as_user(NULL);
  UPDATE withdrawal_requests SET status = 'completed', processed_at = now() WHERE id = (tt.payment(a)).withdrawal_request_id;
  PERFORM tt.as_user(fo);
  SELECT e INTO row FROM jsonb_array_elements(self_support_staff_landlord_payments()) e WHERE (e->>'rent_request_id')::uuid = a;
  ASSERT (row->>'can_mark_paid')::boolean AND NOT (row->>'can_refund')::boolean, 'now only mark paid';
  r := self_support_staff_resolve((tt.payment(a)).id, 'paid', 'merchant showed the MoMo message');
  ASSERT r->>'status' = 'paid', 'resolve still works through the shared check';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(self_support_staff_landlord_payments()) e WHERE (e->>'rent_request_id')::uuid = a), 'gone from attention';
END $t$);

CALL tt.run('F02', 'Partners, agents and anon cannot read the staff list; bad filter refused', $t$
DECLARE pa uuid := tt.person('Pius Partner', ARRAY['supporter']); e text;
BEGIN
  PERFORM tt.as_user(pa);
  e := tt.err('select self_support_staff_landlord_payments()');
  ASSERT e LIKE 'only Financial Ops%', e;
  e := tt.err('select self_support_staff_resolve(gen_random_uuid(), ''refund'', ''some reason here'')');
  ASSERT e LIKE 'only Financial Ops%', e;
  ASSERT NOT has_function_privilege('anon', 'public.self_support_staff_landlord_payments(text, integer)', 'EXECUTE'), 'anon';
  ASSERT NOT has_function_privilege('authenticated', 'public._ssd_is_finance_staff()', 'EXECUTE'), 'helper closed';
  PERFORM tt.as_user(tt.person('Fin', ARRAY['cfo']));
  e := tt.err('select self_support_staff_landlord_payments(''bogus'')');
  ASSERT e LIKE 'filter must be%', e;
END $t$);

SELECT id || ' ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END || ' ' || title || COALESCE(' :: ' || detail, '') FROM tt.result WHERE id LIKE 'F%' ORDER BY id;
