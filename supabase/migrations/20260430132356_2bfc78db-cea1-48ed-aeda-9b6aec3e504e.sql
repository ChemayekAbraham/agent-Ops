DO $$
BEGIN
  PERFORM public.enforce_recipient_routing(
    p_user_id := '99890a2e-b842-4d44-8516-e2eafe0711ff'::uuid,
    p_amount := 300000::numeric,
    p_recipient_type := 'user'
  );
END $$;