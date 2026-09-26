-- Daily-aggregated analytics for the rent-access growth message.
-- One row per (user, surface, day) keeps writes bounded at scale.
CREATE TABLE IF NOT EXISTS public.rent_access_promo_engagement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  surface text NOT NULL,
  event_date date NOT NULL,
  impressions integer NOT NULL DEFAULT 0,
  clicks integer NOT NULL DEFAULT 0,
  first_event_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rent_access_promo_surface_ck CHECK (surface IN ('tenant_dashboard','daily_payment_card','repayment_dialog','pay_rent_flow')),
  CONSTRAINT rent_access_promo_unique UNIQUE (user_id, surface, event_date)
);

CREATE INDEX IF NOT EXISTS rent_access_promo_date_idx ON public.rent_access_promo_engagement (event_date DESC, surface);

GRANT SELECT ON public.rent_access_promo_engagement TO authenticated;
GRANT ALL ON public.rent_access_promo_engagement TO service_role;

ALTER TABLE public.rent_access_promo_engagement ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own promo engagement" ON public.rent_access_promo_engagement;
CREATE POLICY "Users can view own promo engagement"
ON public.rent_access_promo_engagement
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Ops can view promo engagement" ON public.rent_access_promo_engagement;
CREATE POLICY "Ops can view promo engagement"
ON public.rent_access_promo_engagement
FOR SELECT
TO authenticated
USING (
  public.has_role(auth.uid(), 'super_admin')
  OR public.has_role(auth.uid(), 'ceo')
  OR public.has_role(auth.uid(), 'coo')
  OR public.has_role(auth.uid(), 'cmo')
  OR public.has_role(auth.uid(), 'tenant_ops')
);

-- Recorder: only path that writes this table.
CREATE OR REPLACE FUNCTION public.track_rent_access_promo(p_surface text, p_event text DEFAULT 'view')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF v_uid IS NULL THEN
    RETURN;
  END IF;
  IF p_event NOT IN ('view','click') THEN
    RAISE EXCEPTION 'invalid event: %', p_event;
  END IF;

  INSERT INTO public.rent_access_promo_engagement (user_id, surface, event_date, impressions, clicks)
  VALUES (
    v_uid,
    p_surface,
    v_day,
    CASE WHEN p_event = 'view' THEN 1 ELSE 0 END,
    CASE WHEN p_event = 'click' THEN 1 ELSE 0 END
  )
  ON CONFLICT (user_id, surface, event_date) DO UPDATE
  SET impressions = public.rent_access_promo_engagement.impressions + CASE WHEN p_event = 'view' THEN 1 ELSE 0 END,
      clicks = public.rent_access_promo_engagement.clicks + CASE WHEN p_event = 'click' THEN 1 ELSE 0 END,
      last_event_at = now();
END;
$$;

REVOKE ALL ON FUNCTION public.track_rent_access_promo(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.track_rent_access_promo(text, text) TO authenticated;

-- Ops summary: per-surface reach and engagement over a window.
CREATE OR REPLACE FUNCTION public.get_rent_access_promo_stats(p_from date DEFAULT (now() AT TIME ZONE 'Africa/Kampala')::date - 29, p_to date DEFAULT (now() AT TIME ZONE 'Africa/Kampala')::date)
RETURNS TABLE (
  surface text,
  unique_tenants bigint,
  impressions bigint,
  clicks bigint,
  click_through_rate numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.surface,
         count(DISTINCT e.user_id) AS unique_tenants,
         COALESCE(sum(e.impressions), 0) AS impressions,
         COALESCE(sum(e.clicks), 0) AS clicks,
         CASE WHEN COALESCE(sum(e.impressions), 0) = 0 THEN 0
              ELSE round((COALESCE(sum(e.clicks), 0)::numeric / sum(e.impressions)::numeric) * 100, 2) END AS click_through_rate
  FROM public.rent_access_promo_engagement e
  WHERE e.event_date BETWEEN p_from AND p_to
    AND (
      public.has_role(auth.uid(), 'super_admin')
      OR public.has_role(auth.uid(), 'ceo')
      OR public.has_role(auth.uid(), 'coo')
      OR public.has_role(auth.uid(), 'cmo')
      OR public.has_role(auth.uid(), 'tenant_ops')
    )
  GROUP BY e.surface
  ORDER BY impressions DESC
$$;

REVOKE ALL ON FUNCTION public.get_rent_access_promo_stats(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_rent_access_promo_stats(date, date) TO authenticated;