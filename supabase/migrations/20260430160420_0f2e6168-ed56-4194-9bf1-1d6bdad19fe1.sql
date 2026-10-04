-- Add new system event type
ALTER TYPE public.system_event_type ADD VALUE IF NOT EXISTS 'ledger_classification_backfilled';