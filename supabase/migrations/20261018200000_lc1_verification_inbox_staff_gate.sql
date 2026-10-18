-- 2026-10-18 (doc 247, step 15): v_lc1_verification_inbox (LC1 chairperson phones, villages, verifying staff, linked rent requests; 24,564 rows)
-- was an owner-rights view selectable by any signed-in user. Browser readers: Lc1VerificationInboxPanel, useLandlordOpsToday,
-- useLandlordOpsBadgeCounts (landlord-ops staff). DB readers: ops_lc1_verification_report and ops_landlord_ops_home_range
-- (both SECURITY DEFINER with their own role checks; the view gate uses the caller's auth.uid(), so they keep working for the same callers).
-- A security_invoker switch was rejected: is_ops_role omits landlord_ops/ceo/cfo/cto, so the underlying RLS would blank those staff.
-- Gate: service role, or is_ops_role / is_landlord_ops / is_landlord_ops_staff / enabled landlord_ops, coo, cfo, ceo, cto.
-- Already applied to production 2026-10-18.
create or replace function public.can_view_lc1_verification_inbox(_uid uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $f$
  select coalesce(auth.role(), 'service_role') = 'service_role'
      or (_uid is not null and (
           public.is_ops_role(_uid) or public.is_landlord_ops(_uid) or public.is_landlord_ops_staff(_uid)
           or exists (select 1 from public.user_roles ur where ur.user_id = _uid and ur.enabled = true
                        and ur.role in ('landlord_ops','coo','cfo','ceo','cto'))));
$f$;
revoke all on function public.can_view_lc1_verification_inbox(uuid) from public, anon;
grant execute on function public.can_view_lc1_verification_inbox(uuid) to authenticated, service_role;

-- Wraps the existing definition (33 columns, unchanged) in the gate.
do $$
declare d text;
begin
  d := regexp_replace(pg_get_viewdef('public.v_lc1_verification_inbox'::regclass), ';\s*$', '');
  execute 'create or replace view public.v_lc1_verification_inbox as select * from (' || d || ') q where public.can_view_lc1_verification_inbox(auth.uid())';
end $$;
