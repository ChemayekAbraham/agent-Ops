-- Welile Schools: ops approve or reject a School Fees Plan request (Agent Ops → Welile Schools → Fee requests).
--
-- Only Welile Schools ops (welile_schools_ops_ok) may decide, and only on a 'submitted' request.
-- Approval needs the school's partnership to be approved first, because Welile can only pay a
-- school whose payout account ops have verified. A rejection needs a reason for the agent.
-- Every decision is written to audit_logs. NO MONEY MOVES here: paying the school comes later.

create or replace function public.welile_school_fee_request_review(
  p_request_id uuid,
  p_decision   text,   -- 'approve' | 'reject'
  p_note       text
) returns public.welile_school_fee_requests
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_row public.welile_school_fee_requests;
  v_new text;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED'; end if;
  if not public.welile_schools_ops_ok() then raise exception 'NOT_AUTHORIZED'; end if;
  v_new := case p_decision when 'approve' then 'approved' when 'reject' then 'rejected' end;
  if v_new is null then raise exception 'decision must be approve or reject'; end if;
  if v_new = 'rejected' and length(trim(coalesce(p_note,''))) < 5 then
    raise exception 'REASON_REQUIRED' using hint = 'Give the agent a reason (at least 5 characters).';
  end if;

  select * into v_row from public.welile_school_fee_requests where id = p_request_id for update;
  if v_row.id is null then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_row.status <> 'submitted' then raise exception 'REQUEST_NOT_PENDING' using hint = format('This request is already %s.', v_row.status); end if;

  if v_new = 'approved' and not exists (
       select 1 from public.welile_school_partnerships wp
        where wp.school_id = v_row.school_id and wp.status = 'approved') then
    raise exception 'SCHOOL_NOT_APPROVED' using hint = 'Approve the school''s partnership (payout account, terms and fees) first.';
  end if;

  update public.welile_school_fee_requests
     set status = v_new, reviewed_by = v_uid, reviewed_at = now(),
         review_note = nullif(trim(coalesce(p_note,'')),''), updated_at = now()
   where id = v_row.id
  returning * into v_row;

  insert into public.audit_logs (user_id, action_type, table_name, record_id, metadata)
  values (v_uid, 'welile_school_fee_request_' || v_new, 'welile_school_fee_requests', v_row.id::text,
          jsonb_build_object('school_id', v_row.school_id, 'profile_id', v_row.profile_id,
                             'term_fee', v_row.term_fee, 'note', v_row.review_note));
  return v_row;
end;
$$;
revoke all on function public.welile_school_fee_request_review(uuid,text,text) from public, anon;
grant execute on function public.welile_school_fee_request_review(uuid,text,text) to authenticated, service_role;
