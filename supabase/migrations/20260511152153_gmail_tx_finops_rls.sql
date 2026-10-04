drop policy if exists "staff can read gmail_transactions" on public.gmail_transactions;
create policy "staff can read gmail_transactions"
  on public.gmail_transactions for select
  using (
    has_role(auth.uid(), 'manager'::app_role)
    or has_role(auth.uid(), 'super_admin'::app_role)
    or has_role(auth.uid(), 'cfo'::app_role)
    or has_role(auth.uid(), 'coo'::app_role)
    or has_role(auth.uid(), 'financial_ops'::app_role)
  );

drop policy if exists "staff can read gmail_poll_state" on public.gmail_poll_state;
create policy "staff can read gmail_poll_state"
  on public.gmail_poll_state for select
  using (
    has_role(auth.uid(), 'manager'::app_role)
    or has_role(auth.uid(), 'super_admin'::app_role)
    or has_role(auth.uid(), 'cfo'::app_role)
    or has_role(auth.uid(), 'coo'::app_role)
    or has_role(auth.uid(), 'financial_ops'::app_role)
  );
