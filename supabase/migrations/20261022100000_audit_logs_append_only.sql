-- 2026-10-22 (doc 248): Information and Security Policy section 10: logs "protected against alteration".
-- audit_logs (492k rows since 2026-03-09) was alterable at privilege level: authenticated held UPDATE/DELETE/TRUNCATE (blocked only because no RLS policy exists for
-- UPDATE/DELETE; TRUNCATE ignores RLS) and anon held SELECT. Now append-only for everyone:
--   1. privileges: anon none; authenticated keeps INSERT and SELECT only.
--   2. triggers refuse UPDATE, DELETE and TRUNCATE unless the transaction sets app.audit_correction = 'on'.
--   3. the one legitimate editor, cfo_correct_trail_entry (CFO-only, service role, keeps edit_history of previous values), sets that flag for its own UPDATE.
-- Retention: no purge job touches audit_logs; a defined retention period is a DPO/CEO decision (policy section 10).
-- Applied to production 2026-10-22. Undo: drop the three triggers and function audit_logs_block_alteration; re-grant privileges if ever needed.
revoke all on table public.audit_logs from anon;
revoke update, delete, truncate, references, trigger on table public.audit_logs from authenticated;

create or replace function public.audit_logs_block_alteration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('app.audit_correction', true), '') = 'on' then
    return new;
  end if;
  raise exception 'audit_logs is append-only (% refused)', tg_op using errcode = '42501';
end;
$$;
revoke all on function public.audit_logs_block_alteration() from public, anon, authenticated;

drop trigger if exists trg_audit_logs_no_update_delete on public.audit_logs;
create trigger trg_audit_logs_no_update_delete before update or delete on public.audit_logs
  for each row execute function public.audit_logs_block_alteration();
drop trigger if exists trg_audit_logs_no_truncate on public.audit_logs;
create trigger trg_audit_logs_no_truncate before truncate on public.audit_logs
  for each statement execute function public.audit_logs_block_alteration();

do $do$
declare d text := pg_get_functiondef('public.cfo_correct_trail_entry(uuid,text,text,uuid,text)'::regprocedure);
  o text := E'  UPDATE public.audit_logs\n';
  n text := E'  PERFORM set_config(''app.audit_correction'', ''on'', true);\n  UPDATE public.audit_logs\n';
begin
  if position('app.audit_correction' in d) > 0 then return; end if;
  if (length(d) - length(replace(d, o, '')))/length(o) <> 1 then raise exception 'cfo_correct_trail_entry: UPDATE anchor not unique'; end if;
  execute replace(d, o, n);
end $do$;
