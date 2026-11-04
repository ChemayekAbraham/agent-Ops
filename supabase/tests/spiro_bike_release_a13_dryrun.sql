-- Read-only dry run of 20261104210000_spiro_bike_release_a13_corrections against production (qro_file.sh). Writes
-- nothing. Per bike: the release, the opening and J7, recoveries, the plan split, the order's current X1 / E3 / A13 (as the
-- balance sheet resolves them), whether anything already recognises the release, and the expected position after.
with f(sale, plan, who) as (values
  ('a544f375-e454-4ed6-a794-81a500916c8a'::uuid, '93d95269-34da-45f0-9845-fff6b7312220'::uuid, 'ALPHA SSEMA'),
  ('a3228b88-6f28-459b-9ef4-48bfd11d3e44'::uuid, 'bfe58c27-4f9e-41f0-a5ff-fdbfa4c8fda9'::uuid, 'PIUS MATA')),
grp as (
  select distinct f.sale, g.transaction_group_id gid from f join general_ledger g
    on (g.source_table = 'merchandise_sales' and g.source_id = f.sale) or (g.source_table = 'merchandise_recovery_plans' and g.source_id = f.plan)),
res as (
  select grp.sale, l.account_code a, l.category c, sum(l.dr - l.cr) n
  from sofp_ledger_legs(now()) l join grp on grp.gid = l.transaction_group_id group by 1, 2, 3)
select json_agg(jsonb_build_object(
  'who', f.who, 'sale', f.sale, 'plan', f.plan, 'agent', (select full_name from profiles where id = s.customer_id), 'agent_id', s.customer_id,
  'release', (select jsonb_agg(jsonb_build_object('gid', g.transaction_group_id, 'at', g.created_at, 'key', g.idempotency_key, 'scope', g.ledger_scope,
                'category', g.category, 'direction', g.direction, 'amount', g.amount, 'bucket', g.wallet_bucket, 'class', g.classification))
              from general_ledger g where g.idempotency_key = 'bike-lease-disbursement-' || f.sale::text),
  'opening', (select jsonb_agg(jsonb_build_object('gid', g.transaction_group_id, 'at', g.created_at, 'key', g.idempotency_key, 'category', g.category,
                'direction', g.direction, 'amount', g.amount) order by g.created_at)
              from general_ledger g where g.source_table = 'merchandise_recovery_plans' and g.source_id = f.plan
                and g.category in ('bike_recovery_receivable_opening', 'receivable_restatement_equity')),
  'already_recognised', exists (select 1 from general_ledger g where g.ledger_scope = 'platform' and g.category = 'bike_recovery_repayment'
                and g.direction = 'cash_out' and ((g.source_table = 'merchandise_sales' and g.source_id = f.sale) or (g.source_table = 'merchandise_recovery_plans' and g.source_id = f.plan))),
  'correction_posted', exists (select 1 from general_ledger g where g.idempotency_key like 'spiro\_release\_a13\_20261104:' || f.sale::text || ':%'),
  'recoveries', (select jsonb_build_object('groups', count(distinct g.transaction_group_id),
                 'wallet_taken', sum(g.amount) filter (where g.ledger_scope = 'wallet' and g.category = 'agent_repayment' and g.direction = 'cash_out'),
                 'principal_a13', sum(g.amount) filter (where g.ledger_scope = 'platform' and g.category = 'bike_recovery_repayment' and g.direction = 'cash_in'),
                 'charges_r1', sum(g.amount) filter (where g.category = 'access_fee_collected' and g.direction = 'cash_in'),
                 'first', min(g.created_at), 'last', max(g.created_at))
               from general_ledger g where g.source_table = 'merchandise_recovery_plans' and g.source_id = f.plan
                 and g.category in ('agent_repayment', 'bike_recovery_repayment', 'access_fee_collected')),
  'plan', (select jsonb_build_object('status', p.status, 'original', p.original_amount, 'outstanding', p.outstanding_balance, 'recovered', p.amount_recovered,
             'principal_total', p.principal_total, 'principal_recovered', p.principal_recovered, 'fee_total', p.fee_total, 'fee_recovered', p.fee_recovered)
           from merchandise_recovery_plans p where p.id = f.plan),
  'lease', (select jsonb_build_object('status', l.status, 'valuation', l.valuation_amount, 'disbursed', l.disbursed_amount, 'paid', l.amount_paid, 'outstanding', l.amount_outstanding)
            from agent_bike_leases l where l.sale_id = f.sale limit 1),
  'deductions', (select jsonb_build_object('n', count(*), 'sum', sum(d.amount)) from merchandise_recovery_deductions d where d.plan_id = f.plan),
  'now', (select jsonb_object_agg(a, n) from (select a, round(sum(n), 2) n from res where res.sale = f.sale group by a having round(sum(n), 2) <> 0) z),
  'now_by_category', (select jsonb_agg(jsonb_build_object('a', a, 'c', c, 'n', n) order by a, c) from res where res.sale = f.sale and a in ('A13', 'X1', 'E3')),
  'expected_after', (select jsonb_build_object(
       'A13', round(sum(n) filter (where a = 'A13'), 2) + 210000,
       'X1', round(coalesce(sum(n) filter (where a = 'X1'), 0), 2) - 710000,
       'E3', round(coalesce(sum(n) filter (where a = 'E3'), 0), 2) + 500000,
       'A13_gross', round(sum(n) filter (where a = 'A13'), 2) + 210000 + (select principal_recovered from merchandise_recovery_plans where id = f.plan))
     from res where res.sale = f.sale)
) order by f.who) j
from f join merchandise_sales s on s.id = f.sale;
