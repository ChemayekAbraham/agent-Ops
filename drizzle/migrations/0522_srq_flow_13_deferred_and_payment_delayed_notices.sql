ALTER TABLE public.staff_requisition_notices DROP CONSTRAINT staff_requisition_notices_kind_check;
ALTER TABLE public.staff_requisition_notices ADD CONSTRAINT staff_requisition_notices_kind_check
  CHECK (kind = ANY (ARRAY['moved','amount_changed','declined','returned','paid','deferred','payment_delayed']::text[]));

DROP FUNCTION public.staff_requisition_prompt_snooze();

CREATE FUNCTION public.staff_requisition_prompt_snooze(p_prompt_id uuid DEFAULT NULL)
 RETURNS timestamptz
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE
  v_until     timestamptz := now() + interval '1 hour';
  v_req_id    uuid;
  v_requester uuid;
  v_code      text;
  v_stage     text;
  v_office    text;
  v_name      text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in.';
  END IF;

  UPDATE public.staff_requisition_prompts
     SET state = 'snoozed',
         snooze_until = v_until,
         snooze_count = snooze_count + 1
   WHERE approver_id = auth.uid()
     AND state <> 'resolved';

  IF p_prompt_id IS NOT NULL THEN
    SELECT r.id, r.requester_id, r.requisition_code, p.stage
      INTO v_req_id, v_requester, v_code, v_stage
      FROM public.staff_requisition_prompts p
      JOIN public.staff_requisitions r ON r.id = p.requisition_id
     WHERE p.id = p_prompt_id
       AND p.approver_id = auth.uid()
       AND r.stage = p.stage;

    IF v_req_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.staff_requisition_notices n
       WHERE n.requisition_id = v_req_id
         AND n.kind = 'deferred'
         AND n.from_stage = v_stage
         AND (n.created_at AT TIME ZONE 'Africa/Kampala')::date = (now() AT TIME ZONE 'Africa/Kampala')::date
    ) THEN
      v_office := CASE v_stage WHEN 'supervisor' THEN 'Department head' WHEN 'coo' THEN 'COO'
                    WHEN 'ceo' THEN 'CEO' WHEN 'cfo' THEN 'CFO' ELSE upper(coalesce(v_stage, '')) END;
      SELECT full_name INTO v_name FROM public.profiles WHERE id = auth.uid();
      INSERT INTO public.staff_requisition_notices
        (requisition_id, recipient_id, kind, from_stage, to_stage, actor_name, title, body)
      VALUES (v_req_id, v_requester, 'deferred', v_stage, v_stage, v_name,
        v_code || ' set aside for now',
        'The ' || v_office || ' (' || coalesce(v_name, '') || ') has seen your requisition and set it aside for now. It is still with them and they will be reminded.');
    END IF;
  END IF;

  RETURN v_until;
END
$function$;

REVOKE ALL ON FUNCTION public.staff_requisition_prompt_snooze(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_prompt_snooze(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.tg_staff_requisition_notice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_office_old text;
  v_office_new text;
  v_actor_id uuid;
  v_actor text;
  v_before numeric;
  v_after numeric;
  v_amount_changed boolean;
  v_reason text;
  v_body text;
BEGIN
  IF coalesce(NEW.request_kind, 'requisition') <> 'requisition' THEN
    RETURN NEW;
  END IF;

  BEGIN
    -- Never notify for a change the requester made themself.
    IF auth.uid() IS NOT NULL AND auth.uid() = NEW.requester_id THEN
      RETURN NEW;
    END IF;

    v_office_old := CASE OLD.stage WHEN 'supervisor' THEN 'Department head' WHEN 'coo' THEN 'COO'
                      WHEN 'ceo' THEN 'CEO' WHEN 'cfo' THEN 'CFO' ELSE upper(coalesce(OLD.stage, '')) END;
    v_office_new := CASE NEW.stage WHEN 'supervisor' THEN 'Department head' WHEN 'coo' THEN 'COO'
                      WHEN 'ceo' THEN 'CEO' WHEN 'cfo' THEN 'CFO' ELSE upper(coalesce(NEW.stage, '')) END;

    v_actor_id := CASE OLD.stage
                    WHEN 'supervisor' THEN NEW.supervisor_decided_by
                    WHEN 'coo' THEN NEW.coo_decided_by
                    WHEN 'ceo' THEN NEW.ceo_decided_by
                    WHEN 'cfo' THEN NEW.cfo_decided_by
                  END;
    SELECT full_name INTO v_actor FROM public.profiles WHERE id = v_actor_id;
    v_actor := coalesce(v_actor, 'the ' || v_office_old);

    v_before := coalesce(OLD.approved_amount, OLD.amount);
    v_after  := coalesce(NEW.approved_amount, NEW.amount);
    v_amount_changed := v_before IS DISTINCT FROM v_after;

    -- d. Paid
    IF NEW.wallet_credit_status = 'credited'
       AND OLD.wallet_credit_status IS DISTINCT FROM 'credited' THEN
      INSERT INTO public.staff_requisition_notices
        (requisition_id, recipient_id, kind, from_stage, to_stage, amount_after, actor_name, title, body)
      VALUES (NEW.id, NEW.requester_id, 'paid', OLD.stage, NEW.stage, v_after, v_actor,
        NEW.requisition_code || ' paid',
        'UGX ' || to_char(v_after, 'FM999,999,999,999,990') ||
          ' has been credited to your Welile wallet. Ref ' || coalesce(NEW.wallet_transaction_id, '-') || '.');
    END IF;

    IF OLD.stage IS DISTINCT FROM NEW.stage THEN
      -- a. Forward move
      IF OLD.stage IN ('supervisor','coo','ceo') AND NEW.stage IN ('coo','ceo','cfo') THEN
        v_body := 'Approved by ' || v_actor || '. It is now with the ' || v_office_new || '.';
        IF v_amount_changed THEN
          v_body := v_body || ' Amount changed from UGX ' || to_char(v_before, 'FM999,999,999,999,990') ||
                    ' to UGX ' || to_char(v_after, 'FM999,999,999,999,990') || '.';
        END IF;
        INSERT INTO public.staff_requisition_notices
          (requisition_id, recipient_id, kind, from_stage, to_stage, amount_before, amount_after, actor_name, title, body)
        VALUES (NEW.id, NEW.requester_id, 'moved', OLD.stage, NEW.stage,
          CASE WHEN v_amount_changed THEN v_before END,
          CASE WHEN v_amount_changed THEN v_after END,
          v_actor,
          NEW.requisition_code || ' approved by the ' || v_office_old, v_body);

      -- b. Declined (reason from rejection_reason, written by staff-requisition-decide)
      ELSIF NEW.stage = 'rejected' THEN
        INSERT INTO public.staff_requisition_notices
          (requisition_id, recipient_id, kind, from_stage, to_stage, actor_name, title, body)
        VALUES (NEW.id, NEW.requester_id, 'declined', OLD.stage, NEW.stage, v_actor,
          NEW.requisition_code || ' declined at the ' || v_office_old,
          'Declined by ' || v_actor || ': ' || coalesce(NEW.rejection_reason, ''));

      -- c. Sent back (reason from the <stage>_note column, written by staff-requisition-decide)
      ELSIF NEW.stage = 'returned' THEN
        v_reason := CASE OLD.stage
                      WHEN 'supervisor' THEN NEW.supervisor_note
                      WHEN 'coo' THEN NEW.coo_note
                      WHEN 'ceo' THEN NEW.ceo_note
                      WHEN 'cfo' THEN NEW.cfo_note
                    END;
        INSERT INTO public.staff_requisition_notices
          (requisition_id, recipient_id, kind, from_stage, to_stage, actor_name, title, body)
        VALUES (NEW.id, NEW.requester_id, 'returned', OLD.stage, NEW.stage, v_actor,
          NEW.requisition_code || ' sent back to you',
          'The ' || v_office_old || ' needs more information: ' || coalesce(v_reason, ''));

      -- f. CFO approved but the wallet credit failed (approved -> cfo rollback)
      ELSIF OLD.stage = 'approved' AND NEW.stage = 'cfo'
            AND NEW.wallet_credit_status = 'failed' THEN
        INSERT INTO public.staff_requisition_notices
          (requisition_id, recipient_id, kind, from_stage, to_stage, amount_after, actor_name, title, body)
        VALUES (NEW.id, NEW.requester_id, 'payment_delayed', OLD.stage, NEW.stage, v_after,
          coalesce((SELECT full_name FROM public.profiles WHERE id = NEW.cfo_decided_by), 'the CFO'),
          NEW.requisition_code || ' approved — payment delayed',
          'The CFO approved UGX ' || to_char(v_after, 'FM999,999,999,999,990') ||
            ', but the wallet credit did not go through yet. Finance will retry; you will be notified when it is paid.');
      END IF;
      -- No notice for: -> approved, approved -> cfo (rollback) unless the credit failed, returned -> any stage.

    -- e. Amount changed with no stage change
    ELSIF v_amount_changed AND auth.uid() IS DISTINCT FROM NEW.requester_id THEN
      INSERT INTO public.staff_requisition_notices
        (requisition_id, recipient_id, kind, from_stage, to_stage, amount_before, amount_after, title, body)
      VALUES (NEW.id, NEW.requester_id, 'amount_changed', NEW.stage, NEW.stage, v_before, v_after,
        NEW.requisition_code || ' amount changed',
        'The ' || v_office_new || ' changed the amount from UGX ' || to_char(v_before, 'FM999,999,999,999,990') ||
          ' to UGX ' || to_char(v_after, 'FM999,999,999,999,990') || '.');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'tg_staff_requisition_notice skipped for %: %', NEW.id, SQLERRM;
  END;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.staff_requisition_pending_prompt()
 RETURNS TABLE(prompt_id uuid, stage text, requisition_id uuid, requisition_code text, requester_name text, department_key text, title text, reason text, amount numeric, approved_amount numeric, currency text, attachment_urls text[], raised_at timestamp with time zone, coo_approver_name text, ceo_approver_name text, snooze_count smallint, total_pending bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH mine AS (
    SELECT p.*
      FROM public.staff_requisition_prompts p
      JOIN public.staff_requisitions r ON r.id = p.requisition_id
     WHERE p.approver_id = auth.uid()
       AND p.state <> 'resolved'
       AND r.stage = p.stage
  )
  SELECT
    m.id,
    m.stage,
    r.id,
    r.requisition_code,
    coalesce(pr.full_name, r.requester_name),
    r.department_key,
    r.title,
    r.reason,
    r.amount,
    r.approved_amount,
    r.currency,
    r.attachment_urls,
    r.created_at,
    coo.full_name,
    ceo.full_name,
    m.snooze_count,
    (SELECT count(*) FROM mine)
  FROM mine m
  JOIN public.staff_requisitions r ON r.id = m.requisition_id
  LEFT JOIN public.profiles pr ON pr.id = r.requester_id
  LEFT JOIN public.profiles coo ON coo.id = r.coo_decided_by
  LEFT JOIN public.profiles ceo ON ceo.id = r.ceo_decided_by
 ORDER BY m.created_at
 LIMIT 1
$function$;