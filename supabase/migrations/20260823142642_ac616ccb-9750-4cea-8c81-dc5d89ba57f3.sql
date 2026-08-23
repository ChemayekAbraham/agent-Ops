DROP FUNCTION IF EXISTS public.get_merchant_float_positions_signed();

CREATE OR REPLACE FUNCTION public.get_merchant_float_positions_signed(p_include_retired boolean DEFAULT false)
 RETURNS SETOF public.v_merchant_float_position
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (has_role(auth.uid(), 'cfo') or has_role(auth.uid(), 'financial_ops')
       or has_role(auth.uid(), 'manager') or has_role(auth.uid(), 'super_admin')
       or has_role(auth.uid(), 'ceo') or has_role(auth.uid(), 'coo')) then
    raise exception 'forbidden';
  end if;

  -- A retired desk is NOT a merchant float holder: its wallet float is ordinary
  -- operational float. Including it double-counts the same money.
  return query
  select * from public.v_merchant_float_position v
  where p_include_retired or v.is_active = true
  order by v.net_position asc;
end
$function$;

GRANT EXECUTE ON FUNCTION public.get_merchant_float_positions_signed(boolean) TO authenticated, service_role;