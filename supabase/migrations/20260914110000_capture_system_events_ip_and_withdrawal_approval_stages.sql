-- Item 47 of tying every action to an IP address: withdrawal approval
-- stage transitions -- the item explicitly called out as "high-risk
-- authorization" in the original proposal, and confirmed missing while
-- investigating it.
--
-- The manager-approval stage transition (WithdrawalRequestsManager.tsx)
-- is a direct client-side UPDATE on withdrawal_requests.status, not routed
-- through any edge function. The only status-change trigger on that table,
-- log_withdrawal_status_event(), fired ONLY for the final approved/
-- completed/rejected transitions -- the intermediate manager_approved,
-- cfo_approved, and fin_ops_approved stages generated no event at all, so
-- there was no record of who approved that stage or when, let alone IP.
--
-- Fix has two parts:
--
-- 1. system_events -- a fourth previously-untouched central table
--    (199,768 rows, 94 distinct event_type values as of this migration,
--    written to by log_system_event() from many call sites across the
--    codebase) gets IP/user-agent capture via one BEFORE INSERT trigger,
--    same pattern as audit_logs (item 8) and login_phase_events (item 6),
--    and already includes the edge-runtime-spoofing guard from the
--    correction in 20260914100000 (a SupabaseEdgeRuntime user-agent is
--    recognised and excluded, not trusted) -- learned before this table
--    was ever exposed to the bug, not after.
--
-- 2. log_withdrawal_status_event() is extended to also fire for
--    manager_approved / cfo_approved / fin_ops_approved, attributing the
--    event to the actual approver for that stage (manager_approved_by /
--    cfo_approved_by / fin_ops_approved_by -- all three confirmed to exist
--    on withdrawal_requests before this migration was written), tagged
--    with which stage in metadata. Uses the existing 'withdrawal_approved'
--    enum value rather than adding new system_event_type labels.

ALTER TABLE public.system_events
  ADD COLUMN IF NOT EXISTS ip_address text,
  ADD COLUMN IF NOT EXISTS user_agent text;

CREATE OR REPLACE FUNCTION public.capture_system_event_ip()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
BEGIN
  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
  EXCEPTION WHEN OTHERS THEN
    v_headers := '{}'::jsonb;
  END;

  v_ua := v_headers ->> 'user-agent';
  IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
    RETURN NEW;
  END IF;

  v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
  IF v_ip IS NULL THEN
    v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
  END IF;

  NEW.ip_address := coalesce(NEW.ip_address, v_ip);
  NEW.user_agent := coalesce(NEW.user_agent, v_ua);

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_capture_system_event_ip ON public.system_events;
CREATE TRIGGER trg_capture_system_event_ip
  BEFORE INSERT ON public.system_events
  FOR EACH ROW EXECUTE FUNCTION public.capture_system_event_ip();

CREATE OR REPLACE FUNCTION public.log_withdrawal_status_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'approved' OR NEW.status = 'completed' THEN
      PERFORM public.log_system_event(
        'withdrawal_approved'::system_event_type,
        COALESCE(NEW.processed_by, NEW.user_id),
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id, 'stage', NEW.status)
      );
    ELSIF NEW.status IN ('manager_approved', 'cfo_approved', 'fin_ops_approved') THEN
      -- Each approval stage is a high-risk authorization step in its own
      -- right (a manager/CFO/FinOps operator vouching for this payout) --
      -- previously only the FINAL approved/completed transition generated
      -- any event at all, so intermediate stage approvals left no trace of
      -- who approved that stage or when.
      PERFORM public.log_system_event(
        'withdrawal_approved'::system_event_type,
        COALESCE(
          CASE NEW.status
            WHEN 'manager_approved' THEN NEW.manager_approved_by
            WHEN 'cfo_approved' THEN NEW.cfo_approved_by
            WHEN 'fin_ops_approved' THEN NEW.fin_ops_approved_by
            ELSE NULL
          END,
          NEW.processed_by, NEW.user_id
        ),
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id, 'stage', NEW.status)
      );
    ELSIF NEW.status = 'rejected' THEN
      PERFORM public.log_system_event(
        'withdrawal_rejected'::system_event_type,
        COALESCE(NEW.processed_by, NEW.user_id),
        'withdrawal_requests',
        NEW.id::text,
        jsonb_build_object('amount', NEW.amount, 'user_id', NEW.user_id, 'reason', NEW.rejection_reason)
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
