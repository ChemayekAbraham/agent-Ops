ALTER TABLE public.partner_lead_assignments REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.partner_lead_assignments;