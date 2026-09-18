-- ECHO: ENGREP-TOUCH-BATCH-20260918-Q Part 1
-- Batch companion to engrep_svc_record_file_touch. The single-row function is untouched.

create or replace function public.engrep_svc_record_file_touches(
  p_window_id uuid, p_evidence_ref text, p_source text,
  p_engineer_id uuid, p_touched_at timestamptz, p_files jsonb)
returns integer
language plpgsql security definer set search_path = public
as $$
declare v_n integer;
begin
  insert into public.engrep_file_touches
    (window_id, evidence_ref, path, blob_sha, engineer_id, source, touched_at)
  select p_window_id, p_evidence_ref, f->>'path', f->>'blob_sha',
         p_engineer_id, p_source, p_touched_at
    from jsonb_array_elements(p_files) f
   where coalesce(f->>'path','') <> '' and coalesce(f->>'blob_sha','') <> ''
  on conflict (window_id, evidence_ref, path) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
