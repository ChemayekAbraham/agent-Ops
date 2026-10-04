-- Add category column to message_templates table
ALTER TABLE public.message_templates 
ADD COLUMN IF NOT EXISTS category TEXT DEFAULT NULL;

-- Create an index for faster category filtering
CREATE INDEX IF NOT EXISTS idx_message_templates_category ON public.message_templates(category);