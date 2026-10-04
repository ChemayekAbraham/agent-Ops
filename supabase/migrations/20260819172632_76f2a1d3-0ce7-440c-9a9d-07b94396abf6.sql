CREATE SEQUENCE public.hr_ticket_ref_seq;

ALTER TABLE public.hr_tickets
  ALTER COLUMN ref SET DEFAULT ('TKT-'::text || lpad((nextval('hr_ticket_ref_seq'::regclass))::text, 5, '0'::text));

GRANT USAGE ON SEQUENCE public.hr_ticket_ref_seq TO authenticated;
REVOKE ALL ON SEQUENCE public.hr_ticket_ref_seq FROM anon;