begin;

revoke insert, update, delete, truncate, references, trigger on public.v_pso_officers from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.v_pso_note_events from authenticated;

grant select on public.v_pso_officers to authenticated;
grant select on public.v_pso_note_events to authenticated;

commit;