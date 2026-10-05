CREATE TABLE public.staff_requisition_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requisition_id uuid NOT NULL REFERENCES public.staff_requisitions(id),
  recipient_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('moved','amount_changed','declined','returned','paid')),
  from_stage text,
  to_stage text,
  amount_before numeric,
  amount_after numeric,
  actor_name text,
  title text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  last_pushed_at timestamptz,
  push_count smallint NOT NULL DEFAULT 0
);
CREATE INDEX idx_srq_notices_open ON public.staff_requisition_notices (recipient_id, created_at)
  WHERE acknowledged_at IS NULL;
GRANT SELECT ON public.staff_requisition_notices TO authenticated;
GRANT ALL ON public.staff_requisition_notices TO service_role;
ALTER TABLE public.staff_requisition_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Recipients read their own requisition notices" ON public.staff_requisition_notices
  FOR SELECT TO authenticated USING (recipient_id = auth.uid());

CREATE OR REPLACE FUNCTION public.tg_staff_requisition_notice()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
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
      END IF;
      -- No notice for: -> approved, approved -> cfo (rollback), returned -> any stage.

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

CREATE TRIGGER tg_staff_requisition_notice
  AFTER UPDATE ON public.staff_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.tg_staff_requisition_notice();

CREATE OR REPLACE FUNCTION public.staff_requisition_my_notices()
 RETURNS TABLE(id uuid, requisition_id uuid, requisition_code text, kind text, from_stage text, to_stage text,
               amount_before numeric, amount_after numeric, actor_name text, title text, body text, created_at timestamptz)
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path = public
AS $function$
  SELECT n.id, n.requisition_id, s.requisition_code, n.kind, n.from_stage, n.to_stage,
         n.amount_before, n.amount_after, n.actor_name, n.title, n.body, n.created_at
    FROM public.staff_requisition_notices n
    JOIN public.staff_requisitions s ON s.id = n.requisition_id
   WHERE n.recipient_id = auth.uid()
     AND n.acknowledged_at IS NULL
   ORDER BY n.created_at ASC
   LIMIT 20;
$function$;
REVOKE ALL ON FUNCTION public.staff_requisition_my_notices() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_my_notices() TO authenticated;

CREATE OR REPLACE FUNCTION public.staff_requisition_notice_ack(p_notice_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
BEGIN
  UPDATE public.staff_requisition_notices
     SET acknowledged_at = now()
   WHERE id = p_notice_id
     AND recipient_id = auth.uid()
     AND acknowledged_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Not found.';
  END IF;
END
$function$;
REVOKE ALL ON FUNCTION public.staff_requisition_notice_ack(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_requisition_notice_ack(uuid) TO authenticated;