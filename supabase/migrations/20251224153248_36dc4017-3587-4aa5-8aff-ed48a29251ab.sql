-- Create table for financial alert thresholds
CREATE TABLE public.financial_thresholds (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  metric_name TEXT NOT NULL UNIQUE,
  threshold_value NUMERIC NOT NULL,
  comparison_type TEXT NOT NULL DEFAULT 'exceeds', -- 'exceeds', 'below', 'equals'
  enabled BOOLEAN NOT NULL DEFAULT true,
  notification_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.financial_thresholds ENABLE ROW LEVEL SECURITY;

-- Managers can view and manage thresholds
CREATE POLICY "Managers can view thresholds" 
ON public.financial_thresholds 
FOR SELECT 
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can insert thresholds" 
ON public.financial_thresholds 
FOR INSERT 
WITH CHECK (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can update thresholds" 
ON public.financial_thresholds 
FOR UPDATE 
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "Managers can delete thresholds" 
ON public.financial_thresholds 
FOR DELETE 
USING (has_role(auth.uid(), 'manager'::app_role));

-- Create trigger for updated_at
CREATE TRIGGER update_financial_thresholds_updated_at
BEFORE UPDATE ON public.financial_thresholds
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Create table for tracking triggered alerts
CREATE TABLE public.financial_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  threshold_id UUID REFERENCES public.financial_thresholds(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  current_value NUMERIC NOT NULL,
  threshold_value NUMERIC NOT NULL,
  triggered_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMP WITH TIME ZONE
);

-- Enable RLS
ALTER TABLE public.financial_alerts ENABLE ROW LEVEL SECURITY;

-- Managers can view and manage alerts
CREATE POLICY "Managers can view alerts" 
ON public.financial_alerts 
FOR SELECT 
USING (has_role(auth.uid(), 'manager'::app_role));

CREATE POLICY "System can insert alerts" 
ON public.financial_alerts 
FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Managers can update alerts" 
ON public.financial_alerts 
FOR UPDATE 
USING (has_role(auth.uid(), 'manager'::app_role));