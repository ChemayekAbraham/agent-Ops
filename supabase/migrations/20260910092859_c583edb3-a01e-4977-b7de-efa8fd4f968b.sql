drop index if exists public.engrep_engineers_code_uq;
drop index if exists public.engrep_engineers_staff_uq;

revoke all on function public.engrep_capture_catalog(p_day date) from public, anon;
revoke all on function public.engrep_capture_catalog(p_day date) from authenticated;
grant execute on function public.engrep_capture_catalog(p_day date) to service_role;

revoke all on function public.engrep_catalog_delta(p_day date) from public, anon;
revoke all on function public.engrep_catalog_delta(p_day date) from authenticated;
grant execute on function public.engrep_catalog_delta(p_day date) to service_role;

revoke all on function public.engrep_is_adjudicator() from public, anon;
grant execute on function public.engrep_is_adjudicator() to authenticated, service_role;

revoke all on function public.engrep_adjudicate(p_row_id uuid, p_band hr_difficulty_band, p_basis text) from public, anon;
grant execute on function public.engrep_adjudicate(p_row_id uuid, p_band hr_difficulty_band, p_basis text) to authenticated, service_role;

revoke all on function public.engrep_lock_window(p_window_id uuid) from public, anon;
grant execute on function public.engrep_lock_window(p_window_id uuid) to authenticated, service_role;

revoke all on function public.engrep_set_liveness(p_row_id uuid, p_verdict text) from public, anon;
grant execute on function public.engrep_set_liveness(p_row_id uuid, p_verdict text) to authenticated, service_role;

revoke all on function public.engrep_open_window(p_granularity text, p_period_start date) from public, anon;
grant execute on function public.engrep_open_window(p_granularity text, p_period_start date) to authenticated, service_role;

revoke all on function public.engrep_ingest_row(p_window_id uuid, p_source text, p_evidence_ref text, p_commit_subject text, p_change_classes text[], p_engineer_code text, p_author_email text, p_claims_schema boolean, p_migration_bearing boolean, p_untagged boolean, p_fenced_breach boolean, p_fence_path text, p_self_fix boolean, p_self_fix_of uuid, p_claimed_objects text[]) from public, anon;
grant execute on function public.engrep_ingest_row(p_window_id uuid, p_source text, p_evidence_ref text, p_commit_subject text, p_change_classes text[], p_engineer_code text, p_author_email text, p_claims_schema boolean, p_migration_bearing boolean, p_untagged boolean, p_fenced_breach boolean, p_fence_path text, p_self_fix boolean, p_self_fix_of uuid, p_claimed_objects text[]) to authenticated, service_role;

revoke all on function public.engrep_detect_unclaimed(p_window_id uuid) from public, anon;
grant execute on function public.engrep_detect_unclaimed(p_window_id uuid) to authenticated, service_role;

revoke all on function public.engrep_mark_harvested(p_window_id uuid) from public, anon;
grant execute on function public.engrep_mark_harvested(p_window_id uuid) to authenticated, service_role;

revoke all on function public.engrep_check_fence(p_engineer_code text, p_paths text[], p_on date) from public, anon;
grant execute on function public.engrep_check_fence(p_engineer_code text, p_paths text[], p_on date) to authenticated, service_role;

revoke all on function public.engrep_apply_zeroing() from public, anon;
grant execute on function public.engrep_apply_zeroing() to authenticated, service_role;

revoke all on function public.engrep_guard_locked_row() from public, anon;
grant execute on function public.engrep_guard_locked_row() to authenticated, service_role;