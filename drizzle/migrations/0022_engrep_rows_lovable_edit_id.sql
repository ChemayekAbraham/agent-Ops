alter table public.engrep_rows add column if not exists lovable_edit_id text;
alter table public.engrep_rows add column if not exists edit_title text;

create index if not exists engrep_rows_lovable_edit_id
  on public.engrep_rows (lovable_edit_id) where lovable_edit_id is not null;

create or replace function public.engrep_svc_set_edit_meta(p_evidence_ref text, p_edit_id text)
returns void
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_locked boolean;
begin
  if p_evidence_ref is null or p_edit_id is null then
    return;
  end if;

  select exists (
    select 1
    from public.engrep_rows r
    join public.engrep_windows w on w.id = r.window_id
    where r.evidence_ref = p_evidence_ref
      and r.source = 'lovable_edit'
      and w.status = 'locked'
  ) into v_locked;

  if v_locked then
    raise exception 'engrep row % belongs to a locked window; edit metadata refused', p_evidence_ref;
  end if;

  update public.engrep_rows
     set lovable_edit_id = p_edit_id
   where evidence_ref = p_evidence_ref
     and source = 'lovable_edit';
end;
$$;

revoke all on function public.engrep_svc_set_edit_meta(text, text) from public, anon, authenticated;
grant execute on function public.engrep_svc_set_edit_meta(text, text) to service_role;