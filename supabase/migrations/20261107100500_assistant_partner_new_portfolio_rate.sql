-- Assistant, partner persona: "what would a new portfolio earn for me". The caller's own rate only.
-- Partner Returns Phase 4 (4a-assistant). Separate file because guard:assistant-readonly scans assistant_*
-- migrations. Identity is auth.uid() (no parameter); assistant_require_partner() refuses non-partners.
-- The rate comes from partner_rate_now (the one rule); any failure answers {available:false}, never a number.
-- Needs Phase 1/2 (partner_rate_now) and 20261105110000_assistant_partner_tools (assistant_require_partner).
-- Rollback: supabase/rollbacks/20261107100500_assistant_partner_new_portfolio_rate.rollback.sql
create or replace function public.assistant_partner_new_portfolio_rate()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v numeric;
begin
  perform public.assistant_require_partner();
  begin v := public.partner_rate_now((select auth.uid())); exception when others then v := null; end;
  return case when v is null then jsonb_build_object('available', false)
              else jsonb_build_object('available', true, 'rate_percent', v) end;
end $$;
revoke all on function public.assistant_partner_new_portfolio_rate() from public, anon, service_role;
grant execute on function public.assistant_partner_new_portfolio_rate() to authenticated;
comment on function public.assistant_partner_new_portfolio_rate() is
  'Agent assistant (partner persona): the monthly Returns rate a new portfolio would open at for the signed-in partner. {available:false} when it cannot be decided.';
