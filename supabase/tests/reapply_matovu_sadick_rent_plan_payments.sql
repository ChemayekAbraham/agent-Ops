-- Dry run of 20261021120000_reapply_matovu_sadick_rent_plan_payments.sql: runs it, reports, then rolls everything back (the report is raised as an error).
-- Usage: (echo 'BEGIN;'; cat supabase/migrations/20261021120000_reapply_matovu_sadick_rent_plan_payments.sql; cat supabase/tests/reapply_matovu_sadick_rent_plan_payments.sql) | supabase db query --linked
DO $t$
DECLARE
  r text := '';
  v record;
  c_rr constant uuid := '471ff399-eee0-46cf-b4fd-c18f7e039bbe';
  c_t  constant uuid := '85317091-81bd-4ff2-8ea1-dc3ae51117f1';
BEGIN
  SELECT status, amount_repaid, total_repayment, agent_payment_status, last_payment_amount INTO v FROM rent_requests WHERE id = c_rr;
  r := r || format('plan=%s repaid=%s total=%s aps=%s last=%s | ', v.status, v.amount_repaid, v.total_repayment, v.agent_payment_status, v.last_payment_amount);
  SELECT count(*) n, sum(amount) s, min(created_at) lo, max(created_at) hi INTO v FROM agent_collections WHERE rent_request_id = c_rr;
  r := r || format('collections=%s sum=%s first=%s last=%s | ', v.n, v.s, v.lo, v.hi);
  SELECT count(*) n, sum(amount) s, min(created_at) lo, max(created_at) hi INTO v FROM repayments WHERE rent_request_id = c_rr;
  r := r || format('repayments=%s sum=%s first=%s last=%s | ', v.n, v.s, v.lo, v.hi);
  SELECT float_balance, withdrawable_balance, balance INTO v FROM wallets WHERE user_id = c_t;
  r := r || format('tenant float=%s withdrawable=%s | ', v.float_balance, v.withdrawable_balance);
  SELECT count(DISTINCT transaction_group_id) g, count(*) legs, min(transaction_date) lo, max(transaction_date) hi
    INTO v FROM general_ledger WHERE idempotency_key LIKE 'tenant_self_repayment:%' AND source_id = c_rr;
  r := r || format('ledger groups=%s legs=%s dates=%s..%s | ', v.g, v.legs, v.lo, v.hi);
  SELECT COALESCE(sum(amount) FILTER (WHERE user_id='fb6e6bf7-7147-46c3-b4e1-139fc95a864b'),0) a, COALESCE(sum(amount) FILTER (WHERE user_id='6aac6c81-b0f8-45eb-a67b-6483e7dcf82f'),0) p
    INTO v FROM general_ledger WHERE category='agent_commission_earned' AND source_id = c_rr AND idempotency_key LIKE 'tenant_self_repayment:%';
  r := r || format('commission agent=%s parent=%s | ', v.a, v.p);
  SELECT count(*) n, count(*) FILTER (WHERE outcome='settled') s INTO v FROM tenant_self_repayment_attempts WHERE tenant_id = c_t;
  r := r || format('attempts=%s settled=%s | ', v.n, v.s);
  SELECT count(*) n, COALESCE(sum(amount),0) s, count(DISTINCT day) d INTO v FROM rent_day_settlements WHERE rent_request_id = c_rr;
  r := r || format('day settlements rows=%s sum=%s days=%s | ', v.n, v.s, v.d);
  SELECT count(*) n, min(day) lo, max(day) hi INTO v FROM agent_expected_day_plans WHERE rent_request_id = c_rr;
  r := r || format('expected days=%s %s..%s | ', v.n, v.lo, v.hi);
  SELECT rent_request_id, outstanding, status INTO v FROM tenant_self_repayment_plan(c_t);
  r := r || format('self_plan rr=%s outstanding=%s status=%s | ', v.rent_request_id, v.outstanding, v.status);
  SELECT count(*) n INTO v FROM tenant_self_repayment_notices WHERE recipient_user_id = c_t;
  r := r || format('notices=%s | ', v.n);
  SELECT rent_balance_due, rent_last_paid_at INTO v FROM landlords WHERE id = '31173e91-dbe8-4e20-aa01-129794c70183';
  r := r || format('landlord due=%s last_paid=%s', v.rent_balance_due, v.rent_last_paid_at);
  RAISE EXCEPTION 'ROLLED BACK REPORT: %', r;
END
$t$;
