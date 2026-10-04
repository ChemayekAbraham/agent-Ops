INSERT INTO public.payout_codes (withdrawal_request_id, user_id, code, qr_data, amount, status, expires_at)
SELECT wr.id, wr.user_id,
       'WPO-LGC' || lpad((row_number() OVER (ORDER BY wr.created_at))::text, 2, '0'),
       'legacy:' || wr.id::text,
       wr.amount, 'pending', now() + interval '7 days'
FROM public.withdrawal_requests wr
WHERE wr.id IN (
  '5f92267a-1b7f-4f17-9e7b-a449cac506f5',
  '05fb0c57-22cb-4830-bda0-700487150138',
  '790c0b10-9601-415e-8be4-f1bdc493439c',
  '0e6d6436-e0b5-4f69-a133-063ca88e4af8',
  '1be5d26b-1957-45ea-b357-6f263d96fca7'
)
AND NOT EXISTS (SELECT 1 FROM public.payout_codes pc WHERE pc.withdrawal_request_id = wr.id);