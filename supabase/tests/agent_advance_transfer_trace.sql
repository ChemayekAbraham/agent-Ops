with c(id) as (values ('9ef03c86-ec7a-4730-b32c-d86092feb81a'::uuid), ('288cbab8-0c82-4ac6-9632-11c44e724ef4'::uuid),
  ('b94abec1-37b7-4eb0-8af5-200373aa140b'::uuid), ('d2a3bbc1-9775-4ad3-a0a1-1accb83a4762'::uuid), ('d1ec4c4c-8e00-4d38-bcbf-3a010aecbcf2'::uuid)),
ca as (select a.* from agent_advances a join c using (id))
select json_agg(jsonb_build_object(
  'cancelled', jsonb_build_object('id', ca.id, 'who', (select full_name from profiles where id = ca.agent_id), 'agent', ca.agent_id,
     'principal', ca.principal, 'fee', ca.access_fee, 'issued', ca.issued_at, 'cancelled_at', ca.cancelled_at, 'by', (select full_name from profiles where id = ca.cancelled_by),
     'mode', ca.cancellation_mode, 'why', ca.cancellation_reason, 'pre_cancel', ca.pre_cancel_outstanding, 'recovery_source', ca.recovery_source),
  'audit', (select jsonb_agg(jsonb_build_object('at', x.created_at, 'type', x.action_type, 'tbl', x.table_name, 'rec', left(x.record_id, 8), 'who', (select full_name from profiles where id = x.user_id),
              'reason', left(x.reason, 200), 'meta', left(x.metadata::text, 600)) order by x.created_at)
            from audit_logs x where x.record_id = ca.id::text or x.metadata::text like '%' || ca.id::text || '%'),
  'same_agent_advances', (select jsonb_agg(jsonb_build_object('id', o.id, 'status', o.status, 'principal', o.principal, 'fee', o.access_fee, 'issued', o.issued_at,
              'outstanding', o.outstanding_balance, 'request', o.request_id, 'recovery_source', o.recovery_source, 'roi_pct', o.roi_recovery_percent,
              'kind', (select r.request_kind from agent_advance_requests r where r.id = o.request_id),
              'parent', (select r.parent_advance_id from agent_advance_requests r where r.id = o.request_id),
              'req_reason', (select left(r.reason, 160) from agent_advance_requests r where r.id = o.request_id)) order by o.issued_at)
            from agent_advances o where o.agent_id = ca.agent_id and o.id <> ca.id),
  'topups_after', (select jsonb_agg(jsonb_build_object('advance', left(t.advance_id::text, 8), 'amount', t.amount, 'at', t.created_at, 'reason', left(t.reason, 120)))
            from agent_advance_topups t join agent_advances o on o.id = t.advance_id where o.agent_id = ca.agent_id and t.created_at >= ca.issued_at),
  'requests_parent', (select jsonb_agg(jsonb_build_object('id', r.id, 'status', r.status, 'kind', r.request_kind, 'principal', r.principal, 'at', r.created_at))
            from agent_advance_requests r where r.parent_advance_id = ca.id),
  'wallet_around_cancel', (select jsonb_agg(jsonb_build_object('at', g.created_at, 'cat', g.category, 'dir', g.direction, 'amt', g.amount, 'bk', g.wallet_bucket,
              'cls', g.classification, 'st', g.source_table, 'd', left(g.description, 90)) order by g.created_at)
            from general_ledger g where g.user_id = ca.agent_id and g.ledger_scope = 'wallet' and g.amount >= 50000
              and g.created_at between coalesce(ca.cancelled_at, now()) - interval '2 days' and coalesce(ca.cancelled_at, now()) + interval '3 days'),
  'portfolios', (select jsonb_agg(jsonb_build_object('id', p.id, 'created', p.created_at, 'status', p.status, 'amount', p.investment_amount))
            from investor_portfolios p where p.investor_id = ca.agent_id)
)) j from ca;
