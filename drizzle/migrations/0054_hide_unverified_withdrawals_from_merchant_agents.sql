-- A user counts as ID-verified once Financial Ops has verified one of their
-- payout destinations (the workflow that requires National ID + selfie).
create or replace function public.withdrawal_user_id_verified(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.payout_destination_verifications v
    where v.user_id = p_user_id
      and v.status = 'verified'
  )
$$;

revoke all on function public.withdrawal_user_id_verified(uuid) from public;
grant execute on function public.withdrawal_user_id_verified(uuid) to authenticated;

-- Merchant (cash-out) agents must not see, claim, or pay out a withdrawal
-- whose owner has not completed ID verification. Owners and office staff
-- keep full visibility; only the merchant-agent branch is gated.

drop policy if exists "Owners staff and assigned merchant agents can view withdrawals" on public.withdrawal_requests;
create policy "Owners staff and assigned merchant agents can view withdrawals"
on public.withdrawal_requests
for select
to public
using (
  (user_id = auth.uid())
  or is_withdrawal_staff(auth.uid())
  or (
    is_active_cashout_agent(auth.uid())
    and public.withdrawal_user_id_verified(user_id)
    and (
      (assigned_cashout_agent_id is null)
      or (assigned_cashout_agent_id = (
        select ca.id from public.cashout_agents ca
        where ca.agent_id = auth.uid()
        limit 1
      ))
      or (dispatch_claimed_by = auth.uid())
      or (processed_by = auth.uid())
    )
  )
);

drop policy if exists "Active merchant agents can claim or release payouts" on public.withdrawal_requests;
create policy "Active merchant agents can claim or release payouts"
on public.withdrawal_requests
for update
to authenticated
using (
  is_active_cashout_agent(auth.uid())
  and public.withdrawal_user_id_verified(user_id)
  and (status = any (array['pending'::text, 'requested'::text, 'approved'::text, 'manager_approved'::text, 'cfo_approved'::text, 'fin_ops_approved'::text]))
);