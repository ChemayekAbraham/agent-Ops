ALTER TABLE public.email_routing_history DROP CONSTRAINT IF EXISTS email_routing_history_route_check;
ALTER TABLE public.email_routing_history ADD CONSTRAINT email_routing_history_route_check
  CHECK (route = ANY (ARRAY['personal_deposit'::text, 'operational_float'::text, 'withdrawable_debit'::text]));