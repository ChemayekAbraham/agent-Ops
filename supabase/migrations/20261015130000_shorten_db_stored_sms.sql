-- DB-stored SMS copy shortened to fit one 160-character segment (Yoola bills
-- per segment). Meaning unchanged. Companion to 20261015120000.
--
-- 1) system_config.momo_sender_signup_sms: thank-you + CTA + link were ~210
--    chars before the footer. Link and flags untouched.
-- 2) queue_tenant_rent_intake_stall_notices(): only the sms_text argument
--    (last argument of queue_tenant_rent_intake_notice) is shortened; the
--    in-app title/body, query, stages and counting are byte-identical to the
--    live definition read on 2026-10-15.
--
-- NOT changed here (needs a separate decision): settle_tenant_rent_from_deposit
-- (tenant_self_repayment_notices.sms_text) and the live campaign
-- renewal-survey-oct-2026 (216-225 chars incl. T&Cs line).

update public.system_config
   set value = (value::jsonb
        || jsonb_build_object(
             'thank_you_text', 'Thanks for sending {amount} via {provider}. Create a free Welile account to manage it.',
             'signup_prompt',  'Open your wallet:'
           ))
 where key = 'momo_sender_signup_sms';

CREATE OR REPLACE FUNCTION public.queue_tenant_rent_intake_stall_notices()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_stage text;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT id, status, updated_at, service_centre_name,
           floor(extract(epoch FROM (now() - updated_at)) / 172800)::int AS periods
      FROM public.tenant_rent_intake_requests
     WHERE status IN ('submitted','claimed','visit_verified','approved')
       AND updated_at < now() - interval '2 days'
  LOOP
    v_stage := 'reminder_' || r.status || '_' || r.periods::text;
    PERFORM public.queue_tenant_rent_intake_notice(
      r.id, v_stage,
      'Rent request still in progress',
      'Your rent request is still being worked on ('
        || CASE r.status
             WHEN 'submitted' THEN 'with ' || COALESCE(r.service_centre_name, 'the Service Centre')
             WHEN 'claimed' THEN 'agent review'
             WHEN 'visit_verified' THEN 'final review'
             ELSE 'rent plan being raised' END
        || '). We will update you as soon as it moves.',
      'Welile: Rent request in progress ('
        || CASE r.status
             WHEN 'submitted' THEN 'with ' || left(COALESCE(r.service_centre_name, 'the Service Centre'), 30)
             WHEN 'claimed' THEN 'agent review'
             WHEN 'visit_verified' THEN 'final review'
             ELSE 'Rent Plan being raised' END
        || '). We will update you when it moves.');
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END;
$function$;
