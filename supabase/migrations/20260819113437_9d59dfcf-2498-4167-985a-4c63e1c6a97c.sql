ALTER TABLE public.evidence_2026_08_13_field_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.evidence_2026_08_13_field_audit FROM anon;
REVOKE ALL ON TABLE public.evidence_2026_08_13_field_audit FROM authenticated;
REVOKE ALL ON TABLE public.hr_tickets FROM anon;
REVOKE ALL ON TABLE public.hr_ticket_surfaces FROM anon;
REVOKE ALL ON TABLE public.hr_review_weeks FROM anon;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.hr_tickets FROM authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.hr_ticket_surfaces FROM authenticated;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON TABLE public.hr_review_weeks FROM authenticated;