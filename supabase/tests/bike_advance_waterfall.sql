-- Run only in the isolated fixture database; production money is never tested here.
\set ON_ERROR_STOP on
CREATE FUNCTION public.test_assert(ok boolean,reason text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'Test failed: %',reason; END IF; END $$;
INSERT INTO public.profiles VALUES('00000000-0000-0000-0000-000000000001',true,'Test agent');
INSERT INTO public.treasury_controls VALUES('merchandise_recovery_enabled',true,null);
INSERT INTO public.test_wallet(user_id,withdrawable) VALUES('00000000-0000-0000-0000-000000000001',2000);
INSERT INTO public.agent_advances(id,agent_id,outstanding_balance) VALUES('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001',100000);
INSERT INTO public.merchandise_sales(id) VALUES('00000000-0000-0000-0000-000000000004');
INSERT INTO public.merchandise_recovery_plans(id,customer_id,sale_id,item_name,outstanding_balance,starts_on)
 VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','Test bike',100000,(now() AT TIME ZONE 'Africa/Kampala')::date);

SELECT test_assert(bike=2000 AND surplus=0,'UGX 2,000 pays only bike') FROM _bike_priority_split(2000,3917,0,100000);
SELECT test_assert(bike=3917 AND surplus=0,'UGX 3,917 leaves no advance surplus') FROM _bike_priority_split(3917,3917,0,100000);
SELECT test_assert(bike=3917 AND surplus=1083,'UGX 5,000 leaves UGX 1,083') FROM _bike_priority_split(5000,3917,0,100000);
SELECT test_assert(bike=0 AND surplus=5000,'Paid quota is not charged again') FROM _bike_priority_split(5000,3917,3917,100000);
SELECT test_assert(bike=100 AND surplus=4900,'Final balance caps bike recovery') FROM _bike_priority_split(5000,3917,0,100);

SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=0,'Partial bike coverage blocks advance');
SELECT test_assert(amount_recovered=2000 AND outstanding_balance=98000,'Partial bike recorded once') FROM merchandise_recovery_plans;
SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=0,'Repeat with empty wallet has no effect');
SELECT test_assert(count(*)=1,'No duplicate bike history') FROM merchandise_recovery_deductions;
UPDATE test_wallet SET withdrawable=3000;
SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=1083,'Later earnings finish quota, preserve surplus');
SELECT test_assert(sum(amount)=3917,'Daily quota collected exactly') FROM merchandise_recovery_deductions;
SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=1083,'Satisfied quota remains idempotent');
SELECT test_assert(float_balance=99000,'No float deductions') FROM test_wallet;
SELECT test_assert(sum((x->>'amount')::numeric) FILTER(WHERE x->>'category'='bike_recovery_repayment')=2820,
 'Bike principal uses unchanged allocation') FROM test_postings CROSS JOIN LATERAL jsonb_array_elements(entries) x;
SELECT test_assert(sum((x->>'amount')::numeric) FILTER(WHERE x->>'category'='access_fee_collected')=1097,
 'Bike fee uses unchanged allocation') FROM test_postings CROSS JOIN LATERAL jsonb_array_elements(entries) x;

SELECT collect_due_agent_advance_installment('00000000-0000-0000-0000-000000000001');
SELECT test_assert(sum(amount_deducted)=1083,'Advance receives only UGX 1,083 surplus') FROM agent_advance_ledger;
SELECT test_assert(outstanding_balance=98917,'Advance balance remains separate') FROM agent_advances;
SELECT test_assert(outstanding_balance=96083,'Bike balance remains separate') FROM merchandise_recovery_plans;
SELECT test_assert(count(*)=2,'Advance does not create extra bike payment') FROM merchandise_recovery_deductions;

-- Shortfall on a second bike must block all advances, even after the first quota is paid.
INSERT INTO merchandise_sales(id) VALUES('00000000-0000-0000-0000-000000000005');
INSERT INTO merchandise_recovery_plans(id,customer_id,sale_id,item_name,outstanding_balance,starts_on)
 VALUES('00000000-0000-0000-0000-000000000006','00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005','Second bike',100000,(now() AT TIME ZONE 'Africa/Kampala')::date);
UPDATE test_wallet SET withdrawable=2000;
SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=0,'All bike quotas have priority');
SELECT test_assert(amount_recovered=2000,'Second bike gets partial payment') FROM merchandise_recovery_plans WHERE item_name='Second bike';

-- Posting failure rolls back all bike state and blocks advance; retry succeeds once.
UPDATE test_wallet SET withdrawable=3000;
SELECT set_config('test.fail_post','yes',false);
SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=0,'Posting failure cannot release advance surplus');
SELECT test_assert(amount_recovered=2000,'Failed post never changes bike balance') FROM merchandise_recovery_plans WHERE item_name='Second bike';
SELECT set_config('test.fail_post','no',false);
SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=1083,'Retry finishes exact quota');
UPDATE merchandise_recovery_plans SET recovery_hold=true WHERE item_name='Second bike';
SELECT test_assert(_bike_priority_remaining('00000000-0000-0000-0000-000000000001',(now() AT TIME ZONE 'Africa/Kampala')::date)=0,'Held leases excluded');
UPDATE merchandise_recovery_plans SET recovery_hold=false,test_eligible=false WHERE item_name='Second bike';
SELECT test_assert(_bike_priority_remaining('00000000-0000-0000-0000-000000000001',(now() AT TIME ZONE 'Africa/Kampala')::date)=0,'Ineligible leases excluded');
UPDATE treasury_controls SET enabled=false;
UPDATE merchandise_recovery_plans SET test_eligible=true,test_daily=6000 WHERE item_name='Second bike';
SELECT test_assert(_prepare_bike_priority('00000000-0000-0000-0000-000000000001')=0,'Recovery kill switch blocks advance while bike unpaid');
UPDATE treasury_controls SET enabled=true;
UPDATE agent_advances SET status='completed',outstanding_balance=0;
SELECT test_assert(NOT _bike_advance_priority_active('00000000-0000-0000-0000-000000000001'),'Cleared advances cease priority 2');
UPDATE agent_advances SET status='active',outstanding_balance=100000,recovery_source='roi';
SELECT test_assert(NOT _bike_advance_priority_active('00000000-0000-0000-0000-000000000001'),'Returns-based advances remain separate');
SELECT 'Waterfall isolated regression tests passed' AS result;