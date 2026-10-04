
-- Helper: identify Welile staff members allowed to raise / view requisitions
CREATE OR REPLACE FUNCTION public.is_welile_staff(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id
      AND enabled = true
      AND role IN ('ceo','cfo','coo','cto','cmo','crm','hr','manager','super_admin','operations','employee')
  );
$$;

-- Sequence powering human-friendly requisition codes (REQ-00001)
CREATE SEQUENCE IF NOT EXISTS public.director_requisition_seq START 1;

-- Requisitions
CREATE TABLE public.director_requisitions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  requisition_code text NOT NULL UNIQUE DEFAULT ('REQ-' || lpad(nextval('public.director_requisition_seq')::text, 5, '0')),
  title text NOT NULL,
  amount numeric NOT NULL CHECK (amount > 0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','more_info')),
  requester_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requester_name text,
  requester_role text,
  approver_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approver_name text,
  director_comment text,
  decided_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT ON public.director_requisitions TO authenticated;
GRANT ALL ON public.director_requisitions TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.director_requisition_seq TO authenticated, service_role;

ALTER TABLE public.director_requisitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view requisitions"
  ON public.director_requisitions FOR SELECT
  TO authenticated
  USING (public.is_welile_staff(auth.uid()));

CREATE POLICY "Staff can create own requisitions"
  ON public.director_requisitions FOR INSERT
  TO authenticated
  WITH CHECK (public.is_welile_staff(auth.uid()) AND auth.uid() = requester_id);

-- Audit trail of actions/comments
CREATE TABLE public.director_requisition_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  requisition_id uuid NOT NULL REFERENCES public.director_requisitions(id) ON DELETE CASCADE,
  actor_id uuid,
  actor_name text,
  action text NOT NULL CHECK (action IN ('created','approved','rejected','more_info_requested','comment','resubmitted')),
  comment text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

GRANT SELECT ON public.director_requisition_events TO authenticated;
GRANT ALL ON public.director_requisition_events TO service_role;

ALTER TABLE public.director_requisition_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view requisition events"
  ON public.director_requisition_events FOR SELECT
  TO authenticated
  USING (public.is_welile_staff(auth.uid()));

CREATE INDEX idx_director_requisitions_status ON public.director_requisitions(status, created_at DESC);
CREATE INDEX idx_director_requisitions_requester ON public.director_requisitions(requester_id, created_at DESC);
CREATE INDEX idx_director_requisition_events_req ON public.director_requisition_events(requisition_id, created_at DESC);

-- keep updated_at fresh
CREATE TRIGGER update_director_requisitions_updated_at
  BEFORE UPDATE ON public.director_requisitions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Realtime for live director dashboard
ALTER PUBLICATION supabase_realtime ADD TABLE public.director_requisitions;

-- Allow in-app notifications of type 'director_requisition' through the block trigger
CREATE OR REPLACE FUNCTION public.block_all_notification_inserts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF COALESCE(NEW.type, '') IN ('merchandise_recovery', 'director_requisition') THEN
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$function$;
