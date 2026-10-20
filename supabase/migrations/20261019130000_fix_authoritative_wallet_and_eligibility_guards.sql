-- 2026-10-19 (doc 247, step 26): regression fix. Step 22 put a STAFF-ONLY check on get_authoritative_wallet, but the app also calls it for non-staff:
-- fetchOpsWallet (get_authoritative_wallet) is used by useAgentEarnings (an agent's own earnings) and RepaymentHistoryDrawer (a tenant's own repayments).
-- get_agent_daily_eligibility had an own-id-only check, which refused team views. Both refused real signed-in users (671 and 666 HTTP 403 responses between
-- 20:00 UTC on 18 Oct and the fix). Both now allow: staff, the user themselves, or someone in their network (agent_wallet_network_ids), on direct calls only.
-- Lesson: classifying a function "staff only" from the file paths of its callers is not enough; check the API log for 403s on signed-in users after any new guard.
-- Already applied to production 2026-10-19.
do $$
declare d text; old_guard text := 'if not (pg_trigger_depth() > 0 or public.can_view_staff_reports(auth.uid())) then raise exception ''not authorized'' using errcode = ''42501''; end if;'; new_guard text; oid_ oid; s int; e int;
begin
  select p.oid into oid_ from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'get_authoritative_wallet';
  d := pg_get_functiondef(oid_);
  if position(old_guard in d) > 0 then
    new_guard := 'if public._direct_client_call() then if not (public.can_view_staff_reports(auth.uid()) or coalesce(p_user_id = auth.uid(), false) or coalesce(p_user_id in (select public.agent_wallet_network_ids(auth.uid())), false)) then raise exception ''not authorized'' using errcode = ''42501''; end if; end if;';
    execute replace(d, old_guard, new_guard);
  end if;

  select p.oid into oid_ from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'get_agent_daily_eligibility';
  d := pg_get_functiondef(oid_);
  if d not like '%_direct_client_call()%' then
    s := position('begin if not (' in lower(d));
    e := position('end if;' in substr(d, s)) + 6;
    if s > 0 and e > 6 then
      new_guard := 'begin if public._direct_client_call() then if not (public.can_view_staff_reports(auth.uid()) or not exists (select 1 from unnest(p_agent_ids) a(id) where a.id is distinct from auth.uid() and a.id not in (select public.agent_wallet_network_ids(auth.uid())))) then raise exception ''not authorized'' using errcode = ''42501''; end if; end if';
      execute substr(d, 1, s - 1) || new_guard || substr(d, s + e - 1);
    end if;
  end if;
end $$;
