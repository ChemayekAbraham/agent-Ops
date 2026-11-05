-- For each destination advance: its disbursement / top-up groups (all legs), any reversal of the wallet credit, and the
-- agent's wallet movements of 50,000+ in the week after. Read-only.
with d(agent, adv, t0) as (values
  ('e0cd274c-7a35-4fdf-a101-a284c742cff4'::uuid, '7612edc4-0e2e-48f0-9510-e0ffc427d4da'::uuid, '2026-09-25 11:12+00'::timestamptz),
  ('3f87c1f3-6564-478d-a08d-43da24614c80'::uuid, 'c73ab9a3-c2db-4ec7-9642-c4d1866d3ac1'::uuid, '2026-10-20 09:30+00'::timestamptz),
  ('bd59c006-c2cd-472d-9aa9-7ca8939a982d'::uuid, '4909a09a-13d0-4a48-865a-5a338b6a142b'::uuid, '2026-10-23 07:42+00'::timestamptz),
  ('e4f07815-7991-422f-946f-7f351b38e954'::uuid, '3a4f5957-a32f-4971-af14-501b90cd5ef8'::uuid, '2026-10-20 15:41+00'::timestamptz),
  ('3f87c1f3-6564-478d-a08d-43da24614c80'::uuid, '288cbab8-0c82-4ac6-9632-11c44e724ef4'::uuid, '2026-10-27 17:41+00'::timestamptz)),
grp as (
  select distinct d.adv, g.transaction_group_id gid from d join general_ledger g
    on (g.source_table = 'agent_advances' and g.source_id = d.adv)
    or (g.source_table = 'agent_advance_requests' and g.source_id = (select request_id from agent_advances where id = d.adv))
    or (g.source_table = 'agent_advance_topups' and g.source_id in (select id from agent_advance_topups where advance_id = d.adv))
  where g.category in ('rent_disbursement', 'agent_advance_disbursement', 'agent_advance_credit', 'agent_advance_access_fee_charged',
                       'agent_advance_registration_fee_charged', 'agent_advance_topup'))
select json_agg(jsonb_build_object(
  'adv', d.adv, 'who', (select full_name from profiles where id = d.agent),
  'record', (select jsonb_build_object('status', a.status, 'principal', a.principal, 'fee', a.access_fee, 'reg', a.registration_fee, 'outstanding', a.outstanding_balance,
             'issued', a.issued_at, 'recovery', a.recovery_source, 'roi_pct', a.roi_recovery_percent) from agent_advances a where a.id = d.adv),
  'groups', (select jsonb_agg(jsonb_build_object('gid', left(grp.gid::text, 8), 'legs', (select jsonb_agg(jsonb_build_object('sc', g.ledger_scope, 'c', g.category, 'd', g.direction,
              'a', g.amount, 'bk', g.wallet_bucket, 'who', (select full_name from profiles where id = g.user_id), 'cls', g.classification, 'k', g.idempotency_key, 'at', g.created_at))
              from general_ledger g where g.transaction_group_id = grp.gid))) from grp where grp.adv = d.adv),
  'wallet_after', (select jsonb_agg(jsonb_build_object('at', g.created_at, 'gid', left(g.transaction_group_id::text, 8), 'c', g.category, 'd', g.direction, 'a', g.amount,
              'bk', g.wallet_bucket, 'cls', g.classification, 'desc', left(g.description, 110),
              'other', (select string_agg(distinct coalesce((select full_name from profiles where id = o.user_id), '-') || ':' || o.ledger_scope || ':' || o.category || ':' || o.direction, ' | ')
                        from general_ledger o where o.transaction_group_id = g.transaction_group_id and o.id <> g.id)) order by g.created_at)
            from general_ledger g where g.user_id = d.agent and g.ledger_scope = 'wallet' and g.amount >= 50000
              and g.created_at between d.t0 - interval '5 minutes' and d.t0 + interval '7 days'),
  'wallet_now', (select jsonb_build_object('wd', w.withdrawable_balance, 'fl', w.float_balance, 'adv', w.advance_balance) from wallets w where w.user_id = d.agent)
)) j from d;
