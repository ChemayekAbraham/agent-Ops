CREATE OR REPLACE FUNCTION public.get_partner_ops_recent_withdrawals(p_limit integer DEFAULT 10)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_limit integer := greatest(1, least(100, coalesce(p_limit, 10)));
  v_rows jsonb;
begin
  if not (
    has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'coo') or has_role(auth.uid(), 'ceo')
    or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
    or has_role(auth.uid(), 'partner_ops') or has_role(auth.uid(), 'financial_ops')
    or has_role(auth.uid(), 'operations')
  ) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(x order by x_ord desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
             'id', w.id,
             'partner_id', partner_id,
             'partner_name', coalesce(pr.full_name, pr.email, w.mobile_money_name, w.bank_account_name, 'Unknown partner'),
             'amount', coalesce(w.amount, 0),
             'status', w.status,
             'requested_at', w.created_at,
             'processing_date', coalesce(w.processed_at, w.fin_ops_approved_at, w.cfo_approved_at,
                                         w.coo_approved_at, w.manager_approved_at, w.created_at),
             'portfolio_code', ip.portfolio_code,
             'portfolio_name', coalesce(nullif(narration_portfolio, ''), ip.account_name),
             'portfolio_id', ip.id,
             'roi_percentage', ip.roi_percentage,
             'roi_amount', case when ip.investment_amount is not null and ip.roi_percentage is not null
                                then round(ip.investment_amount * ip.roi_percentage / 100.0) end,
             'proxy_agent_name', px.proxy_name,
             'proxy_managed', px.is_managed_account
           ) as x,
           coalesce(w.processed_at, w.fin_ops_approved_at, w.cfo_approved_at,
                    w.coo_approved_at, w.manager_approved_at, w.created_at) as x_ord
    from (
      select w.*,
             coalesce(w.linked_party, w.proxy_partner_id) as partner_id,
             (regexp_match(coalesce(w.reason, ''), 'Portfolio:\s*([^|;\n]+)'))[1] as narration_portfolio,
             (regexp_match(coalesce(w.reason, ''), 'Route:\s*portfolio\s+([0-9a-fA-F-]{36})'))[1] as narration_portfolio_id
      from withdrawal_requests w
      where (w.linked_party is not null or w.proxy_partner_id is not null)
    ) w
    left join profiles pr on pr.id = w.partner_id
    left join lateral (
      select p.id, p.portfolio_code, p.account_name, p.investment_amount, p.roi_percentage
      from investor_portfolios p
      where (w.narration_portfolio_id is not null and p.id = w.narration_portfolio_id::uuid)
         or (w.narration_portfolio_id is null and coalesce(p.investor_id, p.agent_id) = w.partner_id)
      order by (p.id::text = coalesce(w.narration_portfolio_id, '')) desc,
               (p.status = 'active') desc, p.investment_amount desc nulls last, p.created_at desc
      limit 1
    ) ip on true
    left join lateral (
      select coalesce(ap.full_name, ap.email) as proxy_name, a.is_managed_account
      from proxy_agent_assignments a
      left join profiles ap on ap.id = a.agent_id
      where a.beneficiary_id = w.partner_id
        and a.is_active = true
        and coalesce(a.approval_status, 'approved') = 'approved'
      order by a.is_managed_account desc nulls last, a.created_at desc
      limit 1
    ) px on true
    order by x_ord desc
    limit v_limit
  ) q;

  return jsonb_build_object('rows', v_rows);
end;
$function$;