-- Add email statement preference to welile_homes_subscriptions
ALTER TABLE public.welile_homes_subscriptions 
ADD COLUMN email_statements_enabled BOOLEAN DEFAULT false,
ADD COLUMN last_statement_sent_at TIMESTAMP WITH TIME ZONE;