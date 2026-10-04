DO $$
DECLARE v_ids uuid[] := ARRAY[
  '4b0f8174-38a9-4c61-b6d6-af8726e80ed3',
  '6132d7bc-a6a1-4c6c-ae93-fc002522caca',
  'b9dd78a0-ca44-449a-bc6b-91747e901b7a'
]::uuid[];
BEGIN
  DELETE FROM public.withdrawal_notification_log WHERE withdrawal_id = ANY(v_ids);
  DELETE FROM public.withdrawal_release_events WHERE withdrawal_id = ANY(v_ids);
  DELETE FROM public.merchant_float_reservations WHERE withdrawal_id = ANY(v_ids);
  DELETE FROM public.withdrawal_requests WHERE id = ANY(v_ids);
END $$;