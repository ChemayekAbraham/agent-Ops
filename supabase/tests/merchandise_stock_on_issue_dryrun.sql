-- Read-only dry run of 20261104170000_merchandise_stock_recognise_on_issue against production (run through a read-only
-- transaction, e.g. qro_file.sh). Writes nothing. Shows: whether the preflight would pass (Phase 3 fingerprints, the queue
-- as Phase 3 left it, no other issued order with an unrecognised receivable), each of the 7 recognitions it would post
-- (DR A12 / CR R1 merchandise_revenue) with the A12 left per order, and A12 / R1 before and after.
with fp as (
  select
    (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure('public._merch_post_stock_recognition(uuid, text, text, uuid)')) = '02ef461b3be40455767aedf0582c9351'
    and (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure('public.cfo_post_merchandise_stock_recognition(uuid, text)')) = 'bd7bb30d5d5278a08c75c6633fdce853'
    and (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure('public._merch_stock_on_handover(uuid)')) = 'eb39ed08009547bc584c086c92bf2091'
    and (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure('public.trg_merch_stock_issue_event()')) = '6cc969e183f4d4733ba7e51c28eb3308'
    and (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure('public._merch_stock_queue(uuid, text)')) = '89553dbcc1749ad9ade915c8bd4ad19a'
    and (select md5(replace(prosrc, chr(13), '')) from pg_proc where oid = to_regprocedure('public._merch_stock_receivable_due(uuid)')) = '207408ebee59bc98fd0b0b37e2983857' phase3_ok,
    to_regprocedure('public._merch_order_marked_issued(text, text)') is not null already_applied,
    (select stock_issue_counterpart from merchandise_accounting_controls where id) counterpart),
q as (
  select r.id, r.sale_id, r.item_name, r.account, r.status, r.origin, r.amount queued, s.order_status, s.total_revenue, s.amount_paid,
    (public._merch_stock_receivable_due(r.sale_id)->>'due')::numeric due_now,
    (public._merch_receivable_net(r.sale_id, (select coalesce(array_agg(p.id), '{}') from merchandise_recovery_plans p where p.sale_id = r.sale_id), false)->>'a12')::numeric a12_now,
    (select full_name from profiles where id = s.customer_id) customer,
    exists (select 1 from general_ledger g where g.idempotency_key = 'merch_stock_recog:' || r.id::text) posted
  from merchandise_stock_recognitions r left join merchandise_sales s on s.id = r.sale_id),
outside as (
  select count(*) n from merchandise_sales s
  where s.order_status in ('issued', 'completed') and s.cfo_disbursed_at is null and s.disbursement_group_id is null and s.customer_id is not null
    and not exists (select 1 from merchandise_stock_recognitions r where r.sale_id = s.id)
    and coalesce((public._merch_stock_receivable_due(s.id)->>'due')::numeric, 0) > 0),
bal as (
  select account_code, sum(dr - cr) n from sofp_ledger_legs(now() + interval '1 day') where account_code in ('A12', 'R1') group by 1)
select jsonb_build_object(
  'phase3_ok', (select phase3_ok from fp), 'already_applied', (select already_applied from fp), 'counterpart', (select counterpart from fp),
  'pending', (select count(*) from q where status = 'pending' and origin = 'historical_20261104'),
  'pending_total', (select sum(queued) from q where status = 'pending'),
  'moved', (select count(*) from q where status <> 'pending' or origin <> 'historical_20261104' or order_status is distinct from 'issued'
                                     or due_now <> queued or posted),
  'issued_outside_queue_unrecognised', (select n from outside),
  'would_post', (select jsonb_agg(jsonb_build_object('sale', sale_id, 'customer', customer, 'item', item_name, 'status', order_status,
                   'price', total_revenue, 'paid', amount_paid, 'DR_A12_CR_R1', due_now, 'a12_after', a12_now + due_now) order by sale_id) from q where status = 'pending'),
  'A12_before', (select n from bal where account_code = 'A12'),
  'A12_after', (select n from bal where account_code = 'A12') + (select coalesce(sum(due_now), 0) from q where status = 'pending'),
  'R1_before', (select n from bal where account_code = 'R1'),
  'R1_after', (select n from bal where account_code = 'R1') - (select coalesce(sum(due_now), 0) from q where status = 'pending')) dry_run;
