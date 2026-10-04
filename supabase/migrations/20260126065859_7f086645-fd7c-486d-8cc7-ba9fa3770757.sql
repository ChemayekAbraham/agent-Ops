-- AI Brain Infrastructure

-- Status enum for AI recommendations
CREATE TYPE public.ai_recommendation_status AS ENUM ('pending', 'approved', 'rejected', 'auto_executed', 'expired');

-- Priority enum for recommendations  
CREATE TYPE public.ai_priority AS ENUM ('low', 'medium', 'high', 'critical');

-- AI Recommendations table - stores AI-generated recommendations for manager approval
CREATE TABLE public.ai_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recommendation_type TEXT NOT NULL, -- 'risk_adjustment', 'notification', 'collection_action', 'account_flag'
  priority ai_priority NOT NULL DEFAULT 'medium',
  target_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  reasoning TEXT, -- AI's explanation for the recommendation
  suggested_action JSONB NOT NULL, -- Action to execute if approved
  context_data JSONB, -- Relevant data that led to this recommendation
  confidence_score NUMERIC(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1), -- 0-1 confidence
  status ai_recommendation_status DEFAULT 'pending',
  auto_approve_threshold NUMERIC(3,2) DEFAULT 0.95, -- Auto-approve if confidence >= threshold
  requires_approval BOOLEAN DEFAULT true,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  executed_at TIMESTAMPTZ,
  execution_result JSONB,
  expires_at TIMESTAMPTZ DEFAULT (now() + interval '24 hours'),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- AI Analysis Sessions - tracks each AI analysis run
CREATE TABLE public.ai_analysis_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_type TEXT NOT NULL, -- 'scheduled', 'triggered', 'manual'
  trigger_event_id UUID REFERENCES system_events(id),
  events_processed INTEGER DEFAULT 0,
  recommendations_generated INTEGER DEFAULT 0,
  auto_executed_actions INTEGER DEFAULT 0,
  analysis_summary JSONB,
  model_used TEXT DEFAULT 'google/gemini-3-flash-preview',
  tokens_used INTEGER,
  duration_ms INTEGER,
  status TEXT DEFAULT 'running', -- 'running', 'completed', 'failed'
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- AI Notification Templates - intelligent notification patterns
CREATE TABLE public.ai_notification_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT NOT NULL,
  trigger_conditions JSONB NOT NULL, -- Conditions that trigger this pattern
  message_template TEXT NOT NULL, -- Template with placeholders
  channels TEXT[] DEFAULT ARRAY['in_app'], -- 'in_app', 'push', 'sms', 'whatsapp'
  personalization_rules JSONB, -- Rules for personalizing based on user behavior
  optimal_send_times JSONB, -- Best times to send based on user engagement
  success_rate NUMERIC(5,2), -- Historical success rate
  response_rate NUMERIC(5,2), -- How often users respond/act
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Collection Strategies - AI-optimized collection approaches
CREATE TABLE public.ai_collection_strategies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  rent_request_id UUID REFERENCES rent_requests(id),
  current_strategy TEXT NOT NULL, -- 'gentle_reminder', 'escalated', 'final_notice', 'agent_intervention'
  escalation_level INTEGER DEFAULT 1,
  last_contact_at TIMESTAMPTZ,
  next_contact_at TIMESTAMPTZ,
  contact_attempts INTEGER DEFAULT 0,
  successful_contacts INTEGER DEFAULT 0,
  ai_notes TEXT, -- AI analysis of user's payment behavior
  recommended_approach TEXT, -- AI's recommended next step
  optimal_contact_time TEXT, -- Best time to contact based on history
  response_likelihood NUMERIC(3,2), -- Predicted likelihood of response
  payment_likelihood NUMERIC(3,2), -- Predicted likelihood of payment
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- User Behavior Patterns - for AI learning
CREATE TABLE public.ai_user_behavior_patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL UNIQUE,
  payment_consistency_score NUMERIC(3,2), -- 0-1 how consistent are payments
  avg_payment_delay_days NUMERIC(5,2), -- Average days late/early
  preferred_payment_day INTEGER, -- Day of week they usually pay (0=Sun, 6=Sat)
  preferred_payment_time TEXT, -- Time range they usually pay
  notification_response_rate NUMERIC(3,2), -- How often they respond to notifications
  best_contact_channel TEXT, -- Most effective channel
  income_pattern TEXT, -- 'daily', 'weekly', 'monthly', 'irregular'
  risk_trajectory TEXT, -- 'improving', 'stable', 'declining'
  last_analyzed_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.ai_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_analysis_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_notification_patterns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_collection_strategies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_user_behavior_patterns ENABLE ROW LEVEL SECURITY;

-- RLS Policies
-- Managers can view all recommendations
CREATE POLICY "Managers can view all recommendations" ON public.ai_recommendations
  FOR SELECT USING (public.has_role(auth.uid(), 'manager'));

-- Managers can update recommendations (approve/reject)
CREATE POLICY "Managers can update recommendations" ON public.ai_recommendations
  FOR UPDATE USING (public.has_role(auth.uid(), 'manager'));

-- System can insert recommendations
CREATE POLICY "System can insert recommendations" ON public.ai_recommendations
  FOR INSERT WITH CHECK (true);

-- Managers can view analysis sessions
CREATE POLICY "Managers can view analysis sessions" ON public.ai_analysis_sessions
  FOR SELECT USING (public.has_role(auth.uid(), 'manager'));

-- System can manage analysis sessions
CREATE POLICY "System can manage analysis sessions" ON public.ai_analysis_sessions
  FOR ALL WITH CHECK (true);

-- Managers can view notification patterns
CREATE POLICY "Managers can manage notification patterns" ON public.ai_notification_patterns
  FOR ALL USING (public.has_role(auth.uid(), 'manager'));

-- Managers can view collection strategies
CREATE POLICY "Managers can view collection strategies" ON public.ai_collection_strategies
  FOR SELECT USING (public.has_role(auth.uid(), 'manager'));

-- System can manage collection strategies
CREATE POLICY "System can manage collection strategies" ON public.ai_collection_strategies
  FOR ALL WITH CHECK (true);

-- Managers can view behavior patterns
CREATE POLICY "Managers can view behavior patterns" ON public.ai_user_behavior_patterns
  FOR SELECT USING (public.has_role(auth.uid(), 'manager'));

-- System can manage behavior patterns  
CREATE POLICY "System can manage behavior patterns" ON public.ai_user_behavior_patterns
  FOR ALL WITH CHECK (true);

-- Create indexes for performance
CREATE INDEX idx_ai_recommendations_status ON public.ai_recommendations(status);
CREATE INDEX idx_ai_recommendations_target_user ON public.ai_recommendations(target_user_id);
CREATE INDEX idx_ai_recommendations_priority ON public.ai_recommendations(priority);
CREATE INDEX idx_ai_collection_strategies_user ON public.ai_collection_strategies(user_id);
CREATE INDEX idx_ai_behavior_patterns_user ON public.ai_user_behavior_patterns(user_id);

-- Enable realtime for recommendations
ALTER PUBLICATION supabase_realtime ADD TABLE public.ai_recommendations;