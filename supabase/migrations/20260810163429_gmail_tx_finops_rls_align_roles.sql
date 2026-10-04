-- The SELECT policy on gmail_transactions / gmail_poll_state (from
-- 20260511152153_gmail_tx_finops_rls.sql) only granted read access to
-- manager/super_admin/cfo/coo/financial_ops. The /admin/financial-ops
-- route guard (src/App.tsx) allows a different, broader set of roles —
-- employee and operations can open the panel but were never in this RLS
-- policy, so their SELECT silently returned zero rows (RLS filters, it
-- doesn't error) even though gmail-poll-transactions was successfully
-- writing rows the whole time. Align to the same role set current
-- financial-ops RLS policies use elsewhere (super_admin, manager, cfo,
-- coo, ceo, operations), keeping financial_ops and adding employee too
-- so no role permitted by the route guard is excluded here.

drop policy if exists "staff can read gmail_transactions" on public.gmail_transactions;
create policy "staff can read gmail_transactions"
  on public.gmail_transactions for select
  using (
    has_role(auth.uid(), 'manager'::app_role)
    or has_role(auth.uid(), 'super_admin'::app_role)
    or has_role(auth.uid(), 'cfo'::app_role)
    or has_role(auth.uid(), 'coo'::app_role)
    or has_role(auth.uid(), 'ceo'::app_role)
    or has_role(auth.uid(), 'financial_ops'::app_role)
    or has_role(auth.uid(), 'operations'::app_role)
    or has_role(auth.uid(), 'employee'::app_role)
  );

drop policy if exists "staff can read gmail_poll_state" on public.gmail_poll_state;
create policy "staff can read gmail_poll_state"
  on public.gmail_poll_state for select
  using (
    has_role(auth.uid(), 'manager'::app_role)
    or has_role(auth.uid(), 'super_admin'::app_role)
    or has_role(auth.uid(), 'cfo'::app_role)
    or has_role(auth.uid(), 'coo'::app_role)
    or has_role(auth.uid(), 'ceo'::app_role)
    or has_role(auth.uid(), 'financial_ops'::app_role)
    or has_role(auth.uid(), 'operations'::app_role)
    or has_role(auth.uid(), 'employee'::app_role)
  );
