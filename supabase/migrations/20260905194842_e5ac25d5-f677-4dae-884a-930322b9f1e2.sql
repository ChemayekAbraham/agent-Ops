DO $do$
DECLARE src text; old text; new text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO src
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_tenant_rent_from_deposit';

  old := $old$      'Welile: Rent payment received. UGX %s applied to your Rent Plan%s. Remaining balance: UGX %s. Plan status: %s.',
      to_char(v_applied, 'FM999,999,999'),
      CASE WHEN v_surplus > 0 THEN format(', UGX %s kept for your next payment', to_char(v_surplus, 'FM999,999,999')) ELSE '' END,
      to_char(GREATEST(0, v_out - v_applied), 'FM999,999,999'),
      COALESCE(v_new_status, 'repaying')$old$;

  new := $new$      'Hi %s, your rent payment of UGX %s has been applied successfully. Remaining UGX %s today. Remaining to complete UGX %s.%s Thank you for your payment.',
      COALESCE(NULLIF(split_part(COALESCE(v_dep.full_name, ''), ' ', 1), ''), 'there'),
      to_char(v_applied, 'FM999,999,999'),
      to_char(GREATEST(0, v_due - v_applied), 'FM999,999,999'),
      to_char(GREATEST(0, v_out - v_applied), 'FM999,999,999'),
      CASE WHEN v_surplus > 0 THEN format(' UGX %s kept in your wallet for your next payment.', to_char(v_surplus, 'FM999,999,999')) ELSE '' END$new$;

  IF position(old in src) = 0 THEN
    RAISE EXCEPTION 'tenant notice text not found in settle_tenant_rent_from_deposit';
  END IF;

  EXECUTE replace(src, old, new);
END
$do$;