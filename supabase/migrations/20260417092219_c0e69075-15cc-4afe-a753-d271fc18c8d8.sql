-- Add tracking columns to short_links
ALTER TABLE public.short_links
  ADD COLUMN IF NOT EXISTS click_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_clicked_at timestamptz;

-- Clicks log table
CREATE TABLE IF NOT EXISTS public.short_link_clicks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  short_link_id uuid REFERENCES public.short_links(id) ON DELETE CASCADE,
  code text NOT NULL,
  clicked_at timestamptz NOT NULL DEFAULT now(),
  user_agent text,
  referrer text
);

CREATE INDEX IF NOT EXISTS idx_short_link_clicks_code ON public.short_link_clicks(code);
CREATE INDEX IF NOT EXISTS idx_short_link_clicks_clicked_at ON public.short_link_clicks(clicked_at DESC);

ALTER TABLE public.short_link_clicks ENABLE ROW LEVEL SECURITY;

-- Owner of the short link can read its clicks
DROP POLICY IF EXISTS "Owners can view their link clicks" ON public.short_link_clicks;
CREATE POLICY "Owners can view their link clicks"
ON public.short_link_clicks
FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM public.short_links sl
    WHERE sl.id = short_link_clicks.short_link_id
      AND sl.user_id = auth.uid()
  )
);

-- RPC to record a click (anon-callable, security definer)
CREATE OR REPLACE FUNCTION public.record_short_link_click(
  p_code text,
  p_user_agent text DEFAULT NULL,
  p_referrer text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link_id uuid;
BEGIN
  SELECT id INTO v_link_id FROM public.short_links WHERE code = p_code;
  IF v_link_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.short_links
     SET click_count = click_count + 1,
         last_clicked_at = now()
   WHERE id = v_link_id;

  INSERT INTO public.short_link_clicks (short_link_id, code, user_agent, referrer)
  VALUES (v_link_id, p_code, p_user_agent, p_referrer);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_short_link_click(text, text, text) TO anon, authenticated;