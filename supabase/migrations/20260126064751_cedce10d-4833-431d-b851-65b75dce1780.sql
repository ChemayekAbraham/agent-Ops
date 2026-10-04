
-- Create enum for event types
CREATE TYPE public.system_event_type AS ENUM (
  'payment_missed',
  'payment_made',
  'payment_overdue',
  'tenant_created',
  'agent_created',
  'supporter_created',
  'funds_added',
  'funds_withdrawn',
  'rent_request_created',
  'rent_request_approved',
  'rent_request_funded',
  'rent_request_disbursed',
  'account_activated',
  'account_inactive',
  'risk_score_changed',
  'account_flagged',
  'reminder_sent'
);

-- Create enum for action types
CREATE TYPE public.automation_action_type AS ENUM (
  'send_notification',
  'send_push',
  'update_risk_score',
  'flag_account',
  'unflag_account',
  'send_reminder',
  'escalate_to_manager',
  'apply_late_fee',
  'restrict_access'
);

-- Create enum for flag severity
CREATE TYPE public.flag_severity AS ENUM ('low', 'medium', 'high', 'critical');

-- System Events Table - logs all key events
CREATE TABLE public.system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type system_event_type NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  related_entity_type TEXT, -- 'rent_request', 'repayment', 'wallet', etc.
  related_entity_id UUID,
  metadata JSONB DEFAULT '{}',
  processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Index for efficient event processing
CREATE INDEX idx_system_events_unprocessed ON public.system_events (created_at) WHERE processed = false;
CREATE INDEX idx_system_events_user ON public.system_events (user_id, created_at);
CREATE INDEX idx_system_events_type ON public.system_events (event_type, created_at);

-- Automation Actions Log - audit trail of all automated actions
CREATE TABLE public.automation_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type automation_action_type NOT NULL,
  triggered_by_event_id UUID REFERENCES public.system_events(id) ON DELETE SET NULL,
  target_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  rule_name TEXT NOT NULL,
  action_details JSONB DEFAULT '{}',
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_automation_actions_user ON public.automation_actions (target_user_id, created_at);
CREATE INDEX idx_automation_actions_type ON public.automation_actions (action_type, created_at);

-- User Risk Scores Table
CREATE TABLE public.user_risk_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  risk_score INTEGER DEFAULT 50 CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_level TEXT GENERATED ALWAYS AS (
    CASE 
      WHEN risk_score >= 80 THEN 'critical'
      WHEN risk_score >= 60 THEN 'high'
      WHEN risk_score >= 40 THEN 'medium'
      ELSE 'low'
    END
  ) STORED,
  consecutive_on_time_payments INTEGER DEFAULT 0,
  consecutive_missed_payments INTEGER DEFAULT 0,
  total_missed_payments INTEGER DEFAULT 0,
  total_on_time_payments INTEGER DEFAULT 0,
  last_payment_date TIMESTAMPTZ,
  last_risk_update TIMESTAMPTZ DEFAULT now(),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_risk_scores_level ON public.user_risk_scores (risk_level);
CREATE INDEX idx_risk_scores_score ON public.user_risk_scores (risk_score DESC);

-- Account Flags Table
CREATE TABLE public.account_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  flag_type TEXT NOT NULL,
  severity flag_severity NOT NULL DEFAULT 'medium',
  reason TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  resolved BOOLEAN DEFAULT false,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES auth.users(id),
  resolution_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_account_flags_user ON public.account_flags (user_id) WHERE resolved = false;
CREATE INDEX idx_account_flags_severity ON public.account_flags (severity, created_at) WHERE resolved = false;

-- Enable RLS
ALTER TABLE public.system_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_risk_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_flags ENABLE ROW LEVEL SECURITY;

-- RLS Policies - Managers can view all, users can view their own
CREATE POLICY "Managers can view all system events"
  ON public.system_events FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Users can view their own system events"
  ON public.system_events FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Managers can view all automation actions"
  ON public.automation_actions FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can view all risk scores"
  ON public.user_risk_scores FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Users can view their own risk score"
  ON public.user_risk_scores FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Managers can view all account flags"
  ON public.account_flags FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

CREATE POLICY "Managers can manage account flags"
  ON public.account_flags FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'manager'));

-- Function to log system events
CREATE OR REPLACE FUNCTION public.log_system_event(
  p_event_type system_event_type,
  p_user_id UUID,
  p_related_entity_type TEXT DEFAULT NULL,
  p_related_entity_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_id UUID;
BEGIN
  INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
  VALUES (p_event_type, p_user_id, p_related_entity_type, p_related_entity_id, p_metadata)
  RETURNING id INTO v_event_id;
  
  RETURN v_event_id;
END;
$$;

-- Function to update risk score
CREATE OR REPLACE FUNCTION public.update_user_risk_score(
  p_user_id UUID,
  p_score_change INTEGER,
  p_reason TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_score INTEGER;
  v_old_score INTEGER;
BEGIN
  -- Get or create risk score record
  INSERT INTO public.user_risk_scores (user_id, risk_score)
  VALUES (p_user_id, 50)
  ON CONFLICT (user_id) DO NOTHING;
  
  -- Update score
  UPDATE public.user_risk_scores
  SET 
    risk_score = GREATEST(0, LEAST(100, risk_score + p_score_change)),
    notes = COALESCE(p_reason, notes),
    last_risk_update = now(),
    updated_at = now()
  WHERE user_id = p_user_id
  RETURNING risk_score INTO v_new_score;
  
  -- Log the event
  PERFORM public.log_system_event(
    'risk_score_changed'::system_event_type,
    p_user_id,
    'risk_score',
    NULL,
    jsonb_build_object('score_change', p_score_change, 'new_score', v_new_score, 'reason', p_reason)
  );
  
  RETURN v_new_score;
END;
$$;

-- Trigger: Log event when repayment is made
CREATE OR REPLACE FUNCTION public.trigger_log_repayment_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_schedule RECORD;
  v_is_on_time BOOLEAN;
BEGIN
  -- Check if payment is on time (within due date)
  SELECT * INTO v_schedule
  FROM public.repayment_schedules
  WHERE rent_request_id = NEW.rent_request_id
    AND status = 'pending'
  ORDER BY due_date ASC
  LIMIT 1;
  
  v_is_on_time := v_schedule.due_date IS NULL OR NEW.payment_date <= v_schedule.due_date;
  
  -- Log the payment event
  PERFORM public.log_system_event(
    'payment_made'::system_event_type,
    NEW.tenant_id,
    'repayment',
    NEW.id,
    jsonb_build_object(
      'amount', NEW.amount,
      'rent_request_id', NEW.rent_request_id,
      'is_on_time', v_is_on_time
    )
  );
  
  -- Update risk score based on payment behavior
  IF v_is_on_time THEN
    UPDATE public.user_risk_scores
    SET 
      consecutive_on_time_payments = consecutive_on_time_payments + 1,
      consecutive_missed_payments = 0,
      total_on_time_payments = total_on_time_payments + 1,
      last_payment_date = NEW.payment_date,
      risk_score = GREATEST(0, risk_score - 2), -- Decrease risk for on-time payment
      updated_at = now()
    WHERE user_id = NEW.tenant_id;
    
    -- Create record if doesn't exist
    IF NOT FOUND THEN
      INSERT INTO public.user_risk_scores (user_id, risk_score, consecutive_on_time_payments, total_on_time_payments, last_payment_date)
      VALUES (NEW.tenant_id, 48, 1, 1, NEW.payment_date);
    END IF;
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_repayment_log_event
AFTER INSERT ON public.repayments
FOR EACH ROW
EXECUTE FUNCTION public.trigger_log_repayment_event();

-- Trigger: Log event when tenant created (profile with tenant role)
CREATE OR REPLACE FUNCTION public.trigger_log_user_created_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type system_event_type;
BEGIN
  -- Determine event type based on role
  IF NEW.role = 'tenant' THEN
    v_event_type := 'tenant_created';
  ELSIF NEW.role = 'agent' THEN
    v_event_type := 'agent_created';
  ELSIF NEW.role = 'supporter' THEN
    v_event_type := 'supporter_created';
  ELSE
    RETURN NEW;
  END IF;
  
  -- Log the event
  PERFORM public.log_system_event(
    v_event_type,
    NEW.user_id,
    'user_role',
    NEW.id,
    jsonb_build_object('role', NEW.role)
  );
  
  -- Initialize risk score for tenants
  IF NEW.role = 'tenant' THEN
    INSERT INTO public.user_risk_scores (user_id, risk_score)
    VALUES (NEW.user_id, 50)
    ON CONFLICT (user_id) DO NOTHING;
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_user_role_created_log_event
AFTER INSERT ON public.user_roles
FOR EACH ROW
EXECUTE FUNCTION public.trigger_log_user_created_event();

-- Trigger: Log event when wallet balance changes
CREATE OR REPLACE FUNCTION public.trigger_log_wallet_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_change NUMERIC;
BEGIN
  v_change := NEW.balance - OLD.balance;
  
  IF v_change > 0 THEN
    PERFORM public.log_system_event(
      'funds_added'::system_event_type,
      NEW.user_id,
      'wallet',
      NEW.id,
      jsonb_build_object('amount', v_change, 'new_balance', NEW.balance)
    );
  ELSIF v_change < 0 THEN
    PERFORM public.log_system_event(
      'funds_withdrawn'::system_event_type,
      NEW.user_id,
      'wallet',
      NEW.id,
      jsonb_build_object('amount', ABS(v_change), 'new_balance', NEW.balance)
    );
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_wallet_balance_change_log_event
AFTER UPDATE OF balance ON public.wallets
FOR EACH ROW
WHEN (OLD.balance IS DISTINCT FROM NEW.balance)
EXECUTE FUNCTION public.trigger_log_wallet_event();

-- Trigger: Log rent request status changes
CREATE OR REPLACE FUNCTION public.trigger_log_rent_request_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event_type system_event_type;
BEGIN
  -- On insert
  IF TG_OP = 'INSERT' THEN
    PERFORM public.log_system_event(
      'rent_request_created'::system_event_type,
      NEW.tenant_id,
      'rent_request',
      NEW.id,
      jsonb_build_object('rent_amount', NEW.rent_amount, 'duration_days', NEW.duration_days)
    );
    RETURN NEW;
  END IF;
  
  -- On status change
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status = 'approved' THEN
      v_event_type := 'rent_request_approved';
    ELSIF NEW.status = 'funded' THEN
      v_event_type := 'rent_request_funded';
    ELSIF NEW.status = 'disbursed' THEN
      v_event_type := 'rent_request_disbursed';
    ELSE
      RETURN NEW;
    END IF;
    
    PERFORM public.log_system_event(
      v_event_type,
      NEW.tenant_id,
      'rent_request',
      NEW.id,
      jsonb_build_object('status', NEW.status, 'rent_amount', NEW.rent_amount)
    );
  END IF;
  
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_rent_request_log_event
AFTER INSERT OR UPDATE ON public.rent_requests
FOR EACH ROW
EXECUTE FUNCTION public.trigger_log_rent_request_event();

-- Enable realtime for automation tables
ALTER PUBLICATION supabase_realtime ADD TABLE public.system_events;
ALTER PUBLICATION supabase_realtime ADD TABLE public.account_flags;
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_risk_scores;
