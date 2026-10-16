create or replace function public.ops_tutorial_claim_prepare(p_video_ids uuid[])
returns table(claim_id uuid, claim_code text, total_amount numeric, req_title text, req_reason text)
language plpgsql security definer set search_path = public as $$
declare v_n int; v_found int; v_draft text; v_bad record; v_total numeric; v_id uuid; v_code text; v_codes text;
begin
  if not public.ops_tutorial_is_member('creator') then raise exception 'Only a tutorial creator can do this'; end if;
  v_n := coalesce(array_length(p_video_ids, 1), 0);
  if v_n = 0 or (select count(distinct x) from unnest(p_video_ids) x where x is not null) <> v_n then
    raise exception 'Pick at least one video';
  end if;
  select c.claim_code into v_draft from public.ops_tutorial_claims c where c.creator_id = auth.uid() and c.status = 'draft' limit 1;
  if v_draft is not null then raise exception 'You have an unsent claim (%) — link or cancel it first', v_draft; end if;
  perform 1 from public.ops_tutorial_videos v where v.id = any(p_video_ids) for update;
  select count(*), sum(v.rate_amount), string_agg(v.video_code, ', ' order by v.video_code)
    into v_found, v_total, v_codes
    from public.ops_tutorial_videos v
   where v.id = any(p_video_ids) and v.uploaded_by = auth.uid() and v.status = 'accepted' and v.rate_amount > 0;
  if v_found <> v_n then raise exception 'Only your own accepted videos can be claimed'; end if;
  select c.claim_code, v.video_code into v_bad
    from public.ops_tutorial_claim_lines l
    join public.ops_tutorial_claims c on c.id = l.claim_id
    join public.ops_tutorial_videos v on v.id = l.video_id
   where l.video_id = any(p_video_ids) and l.released_at is null limit 1;
  if found then raise exception 'Already on claim %: %', v_bad.claim_code, v_bad.video_code; end if;
  insert into public.ops_tutorial_claims (creator_id, total_amount, status)
  values (auth.uid(), v_total, 'draft') returning id, ops_tutorial_claims.claim_code into v_id, v_code;
  insert into public.ops_tutorial_claim_lines (claim_id, video_id, amount)
  select v_id, v.id, v.rate_amount from public.ops_tutorial_videos v where v.id = any(p_video_ids);
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_claim_prepared', 'ops_tutorial_claims', v_id::text,
    jsonb_build_object('claim_code', v_code, 'total_amount', v_total, 'video_ids', to_jsonb(p_video_ids), 'video_codes', v_codes));
  return query select v_id, v_code, v_total, 'Tutorial videos claim ' || v_code,
    'Payment for ' || v_n || ' accepted tutorial video(s) on claim ' || v_code || ': ' || v_codes || '. Use "Watch tutorial videos" to view each one before approving.';
end $$;

create or replace function public.ops_tutorial_claim_link(p_claim_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare c public.ops_tutorial_claims; v_n int; v_req uuid; v_amt numeric;
begin
  select * into c from public.ops_tutorial_claims where id = p_claim_id for update;
  if not found or c.creator_id <> auth.uid() or c.status <> 'draft' then raise exception 'Nothing to link'; end if;
  select count(*), min(s.id::text)::uuid into v_n, v_req from public.staff_requisitions s
   where s.requester_id = auth.uid() and coalesce(s.request_kind, 'requisition') = 'requisition'
     and s.title = 'Tutorial videos claim ' || c.claim_code;
  if v_n = 0 then raise exception 'No requisition found for % — raise it first', c.claim_code; end if;
  if v_n > 1 then raise exception 'More than one requisition carries %', c.claim_code; end if;
  select s.amount into v_amt from public.staff_requisitions s where s.id = v_req;
  if v_amt is distinct from c.total_amount then raise exception 'Requisition amount does not match claim %', c.claim_code; end if;
  update public.ops_tutorial_claims set requisition_id = v_req, status = 'submitted', linked_at = now() where id = p_claim_id;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_claim_linked', 'ops_tutorial_claims', p_claim_id::text,
    jsonb_build_object('claim_code', c.claim_code, 'requisition_id', v_req, 'amount', v_amt));
  return v_req;
end $$;

create or replace function public.ops_tutorial_claim_cancel(p_claim_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c public.ops_tutorial_claims;
begin
  select * into c from public.ops_tutorial_claims where id = p_claim_id for update;
  if not found or c.creator_id <> auth.uid() or c.status <> 'draft' then raise exception 'Nothing to cancel'; end if;
  if exists (select 1 from public.staff_requisitions s where s.requester_id = auth.uid()
              and s.title = 'Tutorial videos claim ' || c.claim_code and s.stage <> 'rejected') then
    raise exception 'A requisition for % already exists — link it instead', c.claim_code;
  end if;
  update public.ops_tutorial_claims set status = 'cancelled', closed_at = now() where id = p_claim_id;
  update public.ops_tutorial_claim_lines set released_at = now() where claim_id = p_claim_id and released_at is null;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_claim_cancelled', 'ops_tutorial_claims', p_claim_id::text,
    jsonb_build_object('claim_code', c.claim_code));
end $$;

create or replace function public.ops_tutorial_claim_release(p_claim_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c public.ops_tutorial_claims; v_stage text;
begin
  select * into c from public.ops_tutorial_claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found'; end if;
  if not (c.creator_id = auth.uid() or public.ops_tutorial_is_member('reviewer')) then raise exception 'Not allowed'; end if;
  if c.status <> 'submitted' then raise exception 'Only a submitted claim can be released'; end if;
  select s.stage into v_stage from public.staff_requisitions s where s.id = c.requisition_id;
  if v_stage is distinct from 'rejected' then raise exception 'Videos are released only after the requisition is declined'; end if;
  update public.ops_tutorial_claims set status = 'released', closed_at = now() where id = p_claim_id;
  update public.ops_tutorial_claim_lines set released_at = now() where claim_id = p_claim_id and released_at is null;
  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (auth.uid(), 'ops_tutorial_claim_released', 'ops_tutorial_claims', p_claim_id::text,
    jsonb_build_object('claim_code', c.claim_code, 'requisition_id', c.requisition_id));
end $$;

create or replace function public.ops_tutorial_claims_list()
returns table(claim_id uuid, claim_code text, creator_id uuid, status text, total_amount numeric,
  video_count int, video_ids uuid[], created_at timestamptz, requisition_id uuid, requisition_code text, req_stage text,
  req_amount numeric, req_approved_amount numeric, wallet_credit_status text, credited_at timestamptz, rejection_reason text)
language plpgsql stable security definer set search_path = public as $$
declare v_all boolean := public.hr_is_admin() or public.ops_tutorial_is_member('reviewer');
begin
  return query
  select c.id, c.claim_code, c.creator_id, c.status, c.total_amount,
         (select count(*)::int from public.ops_tutorial_claim_lines l where l.claim_id = c.id),
         (select array_agg(l.video_id order by l.created_at) from public.ops_tutorial_claim_lines l where l.claim_id = c.id),
         c.created_at, c.requisition_id, s.requisition_code::text, s.stage::text, s.amount, s.approved_amount,
         coalesce(w.status, s.wallet_credit_status)::text, w.credited_at, s.rejection_reason::text
    from public.ops_tutorial_claims c
    left join public.staff_requisitions s on s.id = c.requisition_id
    left join public.requisition_wallet_credits w on w.source_table = 'staff_requisitions' and w.requisition_id = c.requisition_id
   where v_all or c.creator_id = auth.uid()
   order by c.created_at desc;
end $$;

create or replace function public.ops_tutorial_claim_for_requisition(p_requisition_id uuid)
returns table(claim_id uuid, claim_code text, total_amount numeric, requisition_amount numeric, videos jsonb)
language plpgsql stable security definer set search_path = public as $$
declare c public.ops_tutorial_claims;
begin
  select * into c from public.ops_tutorial_claims where ops_tutorial_claims.requisition_id = p_requisition_id;
  if not found then return; end if;
  if not coalesce(public.ops_tutorial_can_view_claim(c.id), false) then raise exception 'Not allowed'; end if;
  return query
  select c.id, c.claim_code, c.total_amount,
         (select coalesce(s.approved_amount, s.amount) from public.staff_requisitions s where s.id = p_requisition_id),
         coalesce((select jsonb_agg(jsonb_build_object(
            'video_id', v.id, 'video_code', v.video_code, 'title', v.title, 'duration_seconds', v.duration_seconds,
            'storage_path', v.storage_path,
            'my_max_position_seconds', coalesce((select e.max_position_seconds from public.ops_tutorial_view_events e
               where e.video_id = v.id and e.viewer_id = auth.uid() and e.context = 'approval' and e.requisition_id = p_requisition_id), 0))
            order by v.video_code)
          from public.ops_tutorial_claim_lines l join public.ops_tutorial_videos v on v.id = l.video_id
         where l.claim_id = c.id and l.released_at is null), '[]'::jsonb);
end $$;

create or replace function public.ops_tutorial_approver_watch_status(p_requisition_id uuid)
returns table(video_count int, started_count int)
language plpgsql stable security definer set search_path = public as $$
declare c public.ops_tutorial_claims;
begin
  select * into c from public.ops_tutorial_claims where ops_tutorial_claims.requisition_id = p_requisition_id;
  if not found then return query select 0, 0; return; end if;
  if not coalesce(public.ops_tutorial_can_view_claim(c.id), false) then raise exception 'Not allowed'; end if;
  return query
  select count(*)::int,
         count(*) filter (where exists (select 1 from public.ops_tutorial_view_events e
            where e.video_id = l.video_id and e.viewer_id = auth.uid() and e.context = 'approval'
              and e.requisition_id = p_requisition_id and e.max_position_seconds > 0))::int
    from public.ops_tutorial_claim_lines l where l.claim_id = c.id and l.released_at is null;
end $$;

revoke all on function public.ops_tutorial_claim_prepare(uuid[]) from public, anon;
revoke all on function public.ops_tutorial_claim_link(uuid) from public, anon;
revoke all on function public.ops_tutorial_claim_cancel(uuid) from public, anon;
revoke all on function public.ops_tutorial_claim_release(uuid) from public, anon;
revoke all on function public.ops_tutorial_claims_list() from public, anon;
revoke all on function public.ops_tutorial_claim_for_requisition(uuid) from public, anon;
revoke all on function public.ops_tutorial_approver_watch_status(uuid) from public, anon;
grant execute on function public.ops_tutorial_claim_prepare(uuid[]) to authenticated;
grant execute on function public.ops_tutorial_claim_link(uuid) to authenticated;
grant execute on function public.ops_tutorial_claim_cancel(uuid) to authenticated;
grant execute on function public.ops_tutorial_claim_release(uuid) to authenticated;
grant execute on function public.ops_tutorial_claims_list() to authenticated;
grant execute on function public.ops_tutorial_claim_for_requisition(uuid) to authenticated;
grant execute on function public.ops_tutorial_approver_watch_status(uuid) to authenticated;