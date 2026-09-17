revoke all on function public.engrep_svc_record_file_touches(uuid, text, text, uuid, timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.engrep_svc_record_file_touches(uuid, text, text, uuid, timestamptz, jsonb) to service_role;

revoke all on function public.engrep_refresh_catalog_movement(date) from public, anon, authenticated;
grant execute on function public.engrep_refresh_catalog_movement(date) to service_role;

revoke all on public.engrep_catalog_movement from authenticated;
revoke all on public.engrep_file_touches from authenticated;
revoke all on public.engrep_work_units from authenticated;
revoke all on public.engrep_repetition from authenticated;
revoke all on public.engrep_claim_noise from authenticated;

grant select on public.engrep_catalog_movement to authenticated;
grant select on public.engrep_file_touches to authenticated;
grant select on public.engrep_work_units to authenticated;
grant select on public.engrep_repetition to authenticated;
grant select on public.engrep_claim_noise to authenticated;