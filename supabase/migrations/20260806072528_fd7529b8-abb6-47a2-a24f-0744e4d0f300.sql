UPDATE public.partner_agreements
SET status = 'signed',
    countersigned_at = NULL,
    countersigned_by = NULL,
    agreement_date = '2026-08-03',
    updated_at = now()
WHERE id = 'd7d10ee2-fe8f-4e88-9677-2bca085bf4b3';