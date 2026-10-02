create or replace function public._cto_dossier_allowed()
returns boolean language sql stable security definer set search_path to 'public'
as $$ select exists(select 1 from user_roles where user_id=auth.uid() and role='cto' and coalesce(enabled,true)); $$;
revoke execute on function public._cto_dossier_allowed() from public, anon;
grant execute on function public._cto_dossier_allowed() to authenticated, service_role;
revoke execute on function public.cto_user_dossier_search(text), public.cto_user_dossier_profile(uuid), public.cto_user_dossier_partner(uuid), public.cto_user_dossier_activity(uuid), public.cto_user_dossier_money(uuid,text,text,date,date,text,integer) from public, anon;