DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.hr_pay_post_staff_reinvestment(uuid)'::regprocedure);
  IF position('''pending_ops_approval'', lpad(' in d) = 0 THEN
    RAISE EXCEPTION 'WSR-SIGN-01: expected status literal not found';
  END IF;
  EXECUTE replace(d, '''pending_ops_approval'', lpad(', '''awaiting_partner_details'', lpad(');
END $$;

WITH moved AS (
  UPDATE public.investor_portfolios p
     SET status = 'awaiting_partner_details'
   WHERE p.status = 'pending_ops_approval'
     AND public.hr_pay_is_staff_reinvest_portfolio(p.id)
  RETURNING p.id, p.portfolio_code
)
INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
SELECT NULL, 'wsr_awaiting_partner_details', 'investor_portfolios', m.id::text,
       'Staff reinvestment portfolio returned to awaiting partner details for signature',
       jsonb_build_object('portfolio_code', m.portfolio_code, 'reason',
         'created at pending_ops_approval without a signed agreement; staff could not sign, Ops could not approve')
FROM moved m;

CREATE OR REPLACE FUNCTION public.hr_pay_my_reinvest_signing_link()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_pid  uuid;
  v_code text;
  v_raw  text;
  v_email text;
  v_phone text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;

  SELECT p.id, p.portfolio_code INTO v_pid, v_code
    FROM public.investor_portfolios p
   WHERE p.investor_id = v_uid
     AND p.status = 'awaiting_partner_details'
     AND public.hr_pay_is_staff_reinvest_portfolio(p.id)
   ORDER BY p.created_at
   LIMIT 1;
  IF v_pid IS NULL THEN RETURN jsonb_build_object('status', 'none'); END IF;

  SELECT email, phone INTO v_email, v_phone FROM public.profiles WHERE id = v_uid;
  v_raw := encode(extensions.gen_random_bytes(24), 'hex');

  INSERT INTO public.portfolio_completion_tokens
    (portfolio_id, partner_id, token_hash, email_snapshot, phone_snapshot, expires_at, created_by)
  VALUES (v_pid, v_uid, encode(extensions.digest(v_raw, 'sha256'), 'hex'), v_email, v_phone, now() + interval '7 days', v_uid)
  ON CONFLICT (portfolio_id) DO UPDATE
    SET token_hash = EXCLUDED.token_hash, email_snapshot = EXCLUDED.email_snapshot,
        phone_snapshot = EXCLUDED.phone_snapshot, expires_at = EXCLUDED.expires_at,
        consumed_at = NULL, created_by = EXCLUDED.created_by;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, metadata)
  VALUES (v_uid, 'wsr_signing_link_issued', 'investor_portfolios', v_pid::text,
          'Staff opened their reinvestment signing link', jsonb_build_object('portfolio_code', v_code));

  RETURN jsonb_build_object('status', 'ok', 'portfolio_id', v_pid, 'portfolio_code', v_code,
    'url', '/partners/' || v_uid::text || '/portfolios/' || v_pid::text || '/complete?token=' || v_raw);
END $function$;

REVOKE ALL ON FUNCTION public.hr_pay_my_reinvest_signing_link() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.hr_pay_my_reinvest_signing_link() TO authenticated;