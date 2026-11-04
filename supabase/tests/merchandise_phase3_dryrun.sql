-- Read-only dry run of 20261104110000_merchandise_phase3_stock_phone_pledge against production (run through a
-- read-only transaction, e.g. qro_file.sh). Writes nothing. Shows: the evidence each one-off correction rests on, the
-- groups the migration would post, the company-stock receivables it would queue (not post), the rejected-bike review
-- rows, and the resulting balances.
with phones(sale, amt) as (values
    ('9b704619-2d97-44cb-a61e-5ba7ac6525f6'::uuid, 165000::numeric),
    ('8c6a5ae9-8b38-42cd-a8aa-486dc95a298e'::uuid, 165000::numeric),
    ('3d11c494-31b9-468a-a638-24921a83a0b5'::uuid, 700000::numeric),
    ('548c49eb-d62b-4901-a3dd-7f745377a469'::uuid, 1500000::numeric),
    ('85bce373-09ee-4d15-b130-8380e81fea0a'::uuid, 165000::numeric),
    ('0a128951-9353-47c3-b51a-203e257ab582'::uuid, 800000::numeric),
    ('561e4919-4a93-4961-a33f-5900d0f11276'::uuid, 800000::numeric),
    ('c60db3db-334d-453e-89b8-aa1557535778'::uuid, 950000::numeric)),
stock(sale, amt) as (values
    ('cdd33740-b2ee-47ab-b49d-1c7a4e23db7b'::uuid, 55000::numeric),
    ('9a8b2824-1241-40a1-b2ec-77519a66d2d4'::uuid, 55000::numeric),
    ('d99c3173-a6c9-4168-af94-02e695cb398c'::uuid, 55000::numeric),
    ('ded6710e-1a30-4f17-9f24-463de40081d4'::uuid, 55000::numeric),
    ('bf40085c-dedc-44ef-9e38-d6170a57209a'::uuid, 650000::numeric),
    ('4cf491c5-21b0-4366-9369-7a210b431013'::uuid, 110000::numeric),
    ('882c5336-b5b0-4108-bbc3-11b004dde5c3'::uuid, 35000::numeric)),
ph as (
  select p.sale, p.amt,
    (select count(*) from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = p.sale and g.ledger_scope = 'platform'
       and g.category = 'equipment_expense' and g.direction = 'cash_out' and g.amount = p.amt) x1_legs,
    (select min(g.transaction_group_id::text) from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = p.sale
       and g.category = 'equipment_expense' and g.direction = 'cash_out') x1_group,
    (select count(*) from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = p.sale and g.ledger_scope = 'wallet'
       and g.category = 'agent_advance_credit' and g.wallet_bucket = 'advance_credit' and g.direction = 'cash_in' and g.amount = p.amt) memo_legs,
    (select min(g.transaction_group_id::text) from general_ledger g where g.source_table = 'merchandise_sales' and g.source_id = p.sale
       and g.category = 'agent_advance_credit' and g.wallet_bucket = 'advance_credit') memo_group,
    exists (select 1 from general_ledger g where g.idempotency_key like 'merch_phase3_20261104:' || p.sale::text || ':%') already,
    (select full_name from profiles pr join merchandise_sales s on s.customer_id = pr.id where s.id = p.sale) agent
  from phones p),
st as (
  select v.sale, v.amt, s.item_name, s.order_status, s.total_revenue, s.amount_paid, s.handed_over_at,
    (select full_name from profiles where id = s.customer_id) customer,
    public._merch_receivable_net(v.sale, (select array_agg(p.id) from merchandise_recovery_plans p where p.sale_id = v.sale), false) net,
    (select coalesce(sum(case when g.direction = 'cash_in' then g.amount else -g.amount end), 0) from general_ledger g
       where g.category = 'access_fee_collected' and ((g.source_table = 'merchandise_sales' and g.source_id = v.sale)
          or (g.source_table = 'merchandise_recovery_plans' and g.source_id in (select id from merchandise_recovery_plans where sale_id = v.sale)))) charges
  from stock v join merchandise_sales s on s.id = v.sale),
bal as (select account_code a, round(sum(dr) - sum(cr), 2) n from sofp_ledger_legs(now()) where account_code in ('A12', 'A13', 'X1', 'L1', 'R1', 'E3') group by 1)
select json_build_object(
  'as_at', now(),
  'already_applied', to_regclass('public.merchandise_stock_recognitions') is not null
     or exists (select 1 from ledger_account_map where category in ('merchandise_revenue', 'merchandise_advance_memo_offset')),
  'prerequisites_27_corrections', (select count(distinct transaction_group_id) from general_ledger where idempotency_key like 'merch\_a12\_a13\_correction\_20261104:%'),
  'phones', (select json_agg(json_build_object('sale', sale, 'agent', agent, 'amount', amt, 'x1_group', x1_group, 'memo_group', memo_group,
       'evidence_ok', x1_legs = 1 and memo_legs = 1 and not already,
       'post', json_build_array('DR L1 merchandise_advance_memo_offset ' || amt, 'CR X1 equipment_expense ' || amt))) from ph),
  'phones_total', (select sum(amt) from ph), 'phones_evidence_failures', (select count(*) from ph where not (x1_legs = 1 and memo_legs = 1 and not already)),
  'stock_queue', (select json_agg(json_build_object('sale', sale, 'item', item_name, 'customer', customer, 'status', order_status,
       'handed_over', handed_over_at, 'principal', total_revenue, 'paid', amount_paid, 'a12_now', net->'a12', 'charges_recorded', charges,
       'would_queue', greatest(total_revenue - amount_paid + charges - (net->>'a12')::numeric, 0),
       'evidence_ok', order_status = 'issued' and total_revenue = amt and (net->>'a12')::numeric in (0, -6410))) from st),
  'stock_total', (select sum(greatest(total_revenue - amount_paid + charges - (net->>'a12')::numeric, 0)) from st),
  'rejected_bikes', (select json_agg(json_build_object('sale', s.id, 'customer', (select full_name from profiles where id = s.customer_id), 'status', s.order_status,
       'net', public._merch_receivable_net(s.id, (select array_agg(p.id) from merchandise_recovery_plans p where p.sale_id = s.id), true)))
     from merchandise_sales s where s.id in ('dddc2333-efb2-4855-9ab7-f3d5c3793873', '54c4c664-6004-4aab-a56c-b285050633cd')),
  'balances_now', (select json_object_agg(a, n) from bal),
  'balances_after_migration', (select json_object_agg(a, n + case a when 'X1' then -(select sum(amt) from ph) when 'L1' then (select sum(amt) from ph) else 0 end) from bal)
) dry_run;
