BEGIN;
CREATE FUNCTION pg_temp.assert_true(ok boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %', label; END IF; RAISE NOTICE 'PASS: %', label; END;
$$;
CREATE TEMP TABLE financial_before AS SELECT
 (SELECT jsonb_agg(to_jsonb(w)) FROM public.wallets w) AS wallets,
 (SELECT jsonb_agg(to_jsonb(l)) FROM public.general_ledger l) AS ledger,
 (SELECT jsonb_agg(to_jsonb(r)) FROM public.scheduled_payout_runs r) AS runs;
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true), set_config('request.jwt.claim.aal','aal2',true);
DO $$
DECLARE b jsonb; a jsonb; result jsonb; audit public.standing_order_audit_log%ROWTYPE;
BEGIN
 SELECT to_jsonb(s) INTO b FROM public.scheduled_payouts s;
 result := public.standing_order_set_amount((b->>'id')::uuid,100000,(b->>'updated_at')::timestamptz,125000,'Approved local increase');
 SELECT to_jsonb(s) INTO a FROM public.scheduled_payouts s;
 PERFORM pg_temp.assert_true((a->>'amount')::numeric=125000 AND (a-'amount'-'updated_at')=(b-'amount'-'updated_at'),'increase UGX 100,000 to UGX 125,000 changes only amount/version');
 SELECT * INTO audit FROM public.standing_order_audit_log WHERE id=(result->>'audit_id')::uuid;
 PERFORM pg_temp.assert_true(audit.details->>'previous_amount'='100000' AND audit.details->>'new_amount'='125000' AND audit.details->>'difference'='25000' AND audit.acted_by=auth.uid() AND audit.created_at IS NOT NULL AND audit.reason='Approved local increase','increase audit records old/new/difference/caller/time/reason');
 b := a;
 result := public.standing_order_set_amount((b->>'id')::uuid,125000,(b->>'updated_at')::timestamptz,75000,'Approved local decrease');
 SELECT to_jsonb(s) INTO a FROM public.scheduled_payouts s;
 PERFORM pg_temp.assert_true((a->>'amount')::numeric=75000 AND (a-'amount'-'updated_at')=(b-'amount'-'updated_at'),'decrease UGX 125,000 to UGX 75,000 changes only amount/version');
 SELECT * INTO audit FROM public.standing_order_audit_log WHERE id=(result->>'audit_id')::uuid;
 PERFORM pg_temp.assert_true(audit.details->>'previous_amount'='125000' AND audit.details->>'new_amount'='75000' AND audit.details->>'difference'='-50000' AND audit.acted_by=auth.uid() AND audit.reason='Approved local decrease','decrease audit retains both amounts and negative difference');
END; $$;

CREATE FUNCTION pg_temp.expect_rejection(actor text, aal text, expected numeric, version timestamptz, proposed numeric, reason text, code text, label text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE before_config jsonb; before_audit jsonb; raised boolean := false; actual_code text;
BEGIN
 SELECT to_jsonb(s) INTO before_config FROM public.scheduled_payouts s;
 SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) INTO before_audit FROM public.standing_order_audit_log a;
 PERFORM set_config('request.jwt.claim.sub',actor,true); PERFORM set_config('request.jwt.claim.aal',aal,true);
 BEGIN
   PERFORM public.standing_order_set_amount('00000000-0000-0000-0000-000000000010',expected,version,proposed,reason);
 EXCEPTION WHEN OTHERS THEN raised := true; GET STACKED DIAGNOSTICS actual_code = RETURNED_SQLSTATE; END;
 PERFORM pg_temp.assert_true(raised AND actual_code=code AND before_config=(SELECT to_jsonb(s) FROM public.scheduled_payouts s) AND before_audit=(SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.id),'[]'::jsonb) FROM public.standing_order_audit_log a),label);
END; $$;
DO $$
DECLARE version timestamptz; value numeric; cfo text := '00000000-0000-0000-0000-000000000001';
BEGIN
 SELECT updated_at INTO version FROM public.scheduled_payouts;
 PERFORM pg_temp.expect_rejection('','aal2',75000,version,80000,'Meaningful local reason','42501','signed-out rejects without config/audit writes');
 PERFORM pg_temp.expect_rejection('00000000-0000-0000-0000-000000000003','aal2',75000,version,80000,'Meaningful local reason','42501','tenant rejects without config/audit writes');
 PERFORM pg_temp.expect_rejection('00000000-0000-0000-0000-000000000004','aal2',75000,version,80000,'Meaningful local reason','42501','disabled CFO rejects without config/audit writes');
 PERFORM pg_temp.expect_rejection(cfo,'aal1',75000,version,80000,'Meaningful local reason','42501','missing staff MFA rejects without config/audit writes');
 FOREACH value IN ARRAY ARRAY[0::numeric,-1::numeric,500000001::numeric,'NaN'::numeric,'Infinity'::numeric,'-Infinity'::numeric,NULL::numeric] LOOP
   PERFORM pg_temp.expect_rejection(cfo,'aal2',75000,version,value,'Meaningful local reason','22023','invalid amount '||coalesce(value::text,'NULL')||' leaves config/audit unchanged');
 END LOOP;
 PERFORM pg_temp.expect_rejection(cfo,'aal2',75000,version,75000,'Meaningful local reason','22023','unchanged amount rejects');
 PERFORM pg_temp.expect_rejection(cfo,'aal2',75000,version,80000,'short','22023','short reason rejects');
 PERFORM pg_temp.expect_rejection(cfo,'aal2',75000,version,80000,NULL,'22023','missing reason rejects');
 PERFORM pg_temp.expect_rejection(cfo,'aal2',75000,version,80000,repeat('x',1001),'22023','overlong reason rejects');
 PERFORM pg_temp.expect_rejection(cfo,'aal2',100000,version,80000,'Meaningful local reason','40001','stale amount rejects');
 PERFORM pg_temp.expect_rejection(cfo,'aal2',75000,version-interval '1 second',80000,'Meaningful local reason','40001','stale version rejects even when amount matches');
 PERFORM pg_temp.expect_rejection(cfo,'aal2',75000,NULL,80000,'Meaningful local reason','22023','missing version rejects');
END; $$;

CREATE FUNCTION pg_temp.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected audit failure'; END; $$;
CREATE TRIGGER local_fail_audit BEFORE INSERT ON public.standing_order_audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_audit();
SELECT pg_temp.expect_rejection('00000000-0000-0000-0000-000000000001','aal2',75000,(SELECT updated_at FROM public.scheduled_payouts),80000,'Meaningful local reason','P0001','audit insertion failure rolls back amount AND updated_at');
DROP TRIGGER local_fail_audit ON public.standing_order_audit_log;
SELECT pg_temp.assert_true(NOT has_function_privilege('anon','public.standing_order_set_amount(uuid,numeric,timestamptz,numeric,text)','EXECUTE') AND has_function_privilege('authenticated','public.standing_order_set_amount(uuid,numeric,timestamptz,numeric,text)','EXECUTE'),'RPC grant excludes anonymous callers');

-- Exercise the actual authenticated grant + SECURITY DEFINER boundary, not just owner calls.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',true);
SELECT id AS order_id, amount AS old_amount, updated_at AS old_version FROM public.scheduled_payouts \gset
SET LOCAL ROLE authenticated;
SELECT public.standing_order_set_amount(:'order_id'::uuid,:'old_amount'::numeric,:'old_version'::timestamptz,500000000,'Super admin upper boundary');
RESET ROLE;
SELECT pg_temp.assert_true((SELECT amount=500000000 FROM public.scheduled_payouts),'authorized super-admin accepts UGX 500,000,000 boundary');
SELECT pg_temp.assert_true((SELECT wallets=(SELECT jsonb_agg(to_jsonb(w)) FROM public.wallets w) AND ledger=(SELECT jsonb_agg(to_jsonb(l)) FROM public.general_ledger l) AND runs=(SELECT jsonb_agg(to_jsonb(r)) FROM public.scheduled_payout_runs r) FROM financial_before),'wallet buckets, ledger entries and historical runs unchanged throughout');
SELECT pg_temp.assert_true((SELECT count(*)=3 FROM public.standing_order_audit_log),'exactly three successful edits and three audit entries');
ROLLBACK;