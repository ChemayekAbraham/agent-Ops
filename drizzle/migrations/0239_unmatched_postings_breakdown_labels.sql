CREATE OR REPLACE FUNCTION public.get_unmatched_postings_breakdown(p_as_at timestamp with time zone DEFAULT now())
 RETURNS TABLE(group_label text, legs bigint, amount numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
begin
  if auth.uid() is null
     or not (
       has_role(auth.uid(),'cfo') or has_role(auth.uid(),'ceo') or has_role(auth.uid(),'coo')
       or has_role(auth.uid(),'manager') or has_role(auth.uid(),'financial_ops')
       or has_role(auth.uid(),'super_admin') or has_role(auth.uid(),'cto')
     ) then
    raise exception 'Not authorised to view the statement of financial position';
  end if;

  return query
  with raw as (
    select l.category,
           count(*) as legs,
           round(sum(l.dr - l.cr)) as amount
    from sofp_ledger_legs(p_as_at) l
    where l.group_one_sided
      and l.account_code <> 'E4'
    group by l.category
  ), labelled as (
    select case
             when abs(amount) < 50000 then 'Other small entries'
             when category = 'roi_payout' then 'Returns paid to supporters'
             when category = 'wallet_withdrawal' then 'Wallet withdrawals'
             when category = 'pending_portfolio_topup' then 'Portfolio top-ups awaiting merge'
             when category = 'agent_proxy_investment' then 'Supporter funding captured by agents'
             when category = 'supporter_rent_fund' then 'Supporter rent funding'
             when category = 'coo_proxy_investment' then 'Supporter funding recorded by operations'
             when category = 'coo_proxy_investment_reversal' then 'Reversal of supporter funding recorded by operations'
             when category = 'rent_obligation' then 'Rent Plan obligations raised'
             when category = 'rent_obligation_reversal_adjustment' then 'Rent Plan obligation reversals'
             when category = 'test_funds_cleanup' then 'Clean-up of test funds'
             when category = 'rent_float_funding' then 'Rent float funding'
             when category = 'pool_rent_deployment' then 'Rent funded from the supporter pool'
             when category = 'referral_bonus' then 'Referral bonuses'
             when category = 'rent_payment_for_tenant' then 'Rent paid on behalf of tenants'
             when category = 'wallet_deposit' then 'Wallet deposits'
             when category in ('rent_repayment','tenant_repayment','tenant_repayment_collected') then 'Tenant rent repayments'
             when category = 'proxy_partner_withdrawal' then 'Supporter withdrawals via agents'
             when category = 'rent_disbursement' then 'Rent disbursed to landlords'
             when category = 'agent_commission' then 'Agent commission'
             when category = 'agent_bonus' then 'Agent bonuses'
             when category = 'wallet_transfer' then 'Wallet transfers'
             when category = 'wallet_to_investment' then 'Wallet moved into supporter funding'
             when category = 'agent_float_used_for_rent' then 'Agent float used to pay rent'
             when category = 'tenant_access_fee' then 'Tenant access fees'
             when category = 'orphan_reversal' then 'Reversals with no original entry'
             when category = 'angel_pool_investment' then 'Angel pool funding'
             when category = 'landlord_rent_payment' then 'Rent paid to landlords'
             else initcap(replace(category, '_', ' '))
           end as group_label,
           legs, amount
    from raw
  )
  select group_label, sum(legs)::bigint as legs, sum(amount) as amount
  from labelled
  group by group_label
  order by abs(sum(amount)) desc;
end;
$function$;