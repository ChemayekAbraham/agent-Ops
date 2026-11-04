-- Read-only dry run of 20261104160000_merchandise_phase3b_controls against production (run through a read-only
-- transaction, e.g. qro_file.sh). Writes nothing. Shows: the per-advance penalty evidence (L1 = X1) and the groups the
-- migration would post, the two paid sales with no money record, the recompute_wallet_buckets grants, the pledge-preview
-- plans the eligibility gate would exclude, and the resulting balances.
with pen as (
  select g.source_id adv,
    sum(case when g.ledger_scope = 'wallet' and g.wallet_bucket = 'advance_credit' then case when g.direction = 'cash_in' then g.amount else -g.amount end else 0 end) l1,
    sum(case when g.ledger_scope = 'platform' and g.category = 'interest_expense' then case when g.direction = 'cash_out' then g.amount else -g.amount end else 0 end) x1,
    count(*) filter (where g.ledger_scope = 'wallet') legs
  from general_ledger g
  where g.source_table = 'agent_advances'
    and ((g.ledger_scope = 'wallet' and g.wallet_bucket = 'advance_credit') or (g.ledger_scope = 'platform' and g.category = 'interest_expense'))
  group by 1),
cs(sale, paid) as (values ('e9b076af-6e03-445e-8a43-f5bede640223'::uuid, 60000::numeric), ('9381fee7-5f0b-4c98-b15f-f25ad85be144'::uuid, 35000::numeric)),
pv as (
  select distinct on (p.customer_id) p.customer_id, p.id plan, public.merchandise_plan_ineligible_reason(p.id) why
  from merchandise_recovery_plans p join merchandise_sales s on s.id = p.sale_id
  join smartphone_roi_pledges sp on sp.user_id = p.customer_id and sp.active
  where p.status = 'active' and p.outstanding_balance > 0 and not coalesce(p.is_bike_lease, false) and s.item_name ilike '%smartphone%'
  order by p.customer_id, p.created_at),
bal as (select account_code a, round(sum(dr) - sum(cr), 2) n from sofp_ledger_legs(now()) where account_code in ('L1', 'X1', 'A10') group by 1)
select json_build_object(
  'as_at', now(),
  'phase3_applied', exists (select 1 from ledger_account_map where category = 'merchandise_payment_retained'),
  'already_applied', exists (select 1 from ledger_account_map where category = 'agent_advance_memo_offset') or to_regclass('public.merchandise_unrecorded_sales') is not null,
  'penalty_advances', (select count(*) from pen where l1 > 0),
  'penalty_total', (select sum(l1) from pen where l1 > 0),
  'penalty_evidence_failures', (select count(*) from pen where l1 <> x1),
  'penalty_legs', (select sum(legs) from pen),
  'penalty_resolver_residual_note', 'advances whose reversal is admin_correction (excluded from the statement) keep that amount in L1 / X1 on the statement',
  'penalty_largest', (select json_agg(json_build_object('advance', adv, 'net', l1)) from (select * from pen where l1 > 0 order by l1 desc limit 5) z),
  'unrecorded_sales', (select json_agg(json_build_object('sale', s.id, 'item', s.item_name, 'qty', s.quantity, 'paid', s.amount_paid, 'status', s.order_status,
       'client_on_platform', s.customer_id is not null, 'recorded_by', (select full_name from profiles where id = s.created_by), 'sale_date', s.sale_date,
       'ledger_legs', (select count(*) from general_ledger g where g.source_id = s.id),
       'evidence_ok', s.amount_paid = cs.paid and s.order_status = 'completed' and not exists (select 1 from general_ledger g where g.source_id = s.id)))
     from cs join merchandise_sales s on s.id = cs.sale),
  'recompute_wallet_buckets_grants', json_build_object('anon', has_function_privilege('anon', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE'),
     'authenticated', has_function_privilege('authenticated', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE'),
     'service_role', has_function_privilege('service_role', 'public.recompute_wallet_buckets(uuid)', 'EXECUTE')),
  'pledge_preview_plans', (select json_agg(json_build_object('customer', customer_id, 'plan', plan, 'eligible', why is null, 'reason', why)) from pv),
  'balances_now', (select json_object_agg(a, n) from bal),
  'balances_after_migration', (select json_object_agg(a, n + case a when 'L1' then (select sum(l1) from pen where l1 > 0) when 'X1' then -(select sum(l1) from pen where l1 > 0) else 0 end) from bal)
) dry_run;
