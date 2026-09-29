CREATE OR REPLACE FUNCTION public.welile_transfer_items()
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT ARRAY[
    'Welile Rent', 'Welile Gift', 'Welile Bread', 'Welile Chapati', 'Welile Eggs',
    'Welile Fuel', 'Welile Reward', 'Welile Boda fees', 'Welile tax'
  ]::text[];
$function$;