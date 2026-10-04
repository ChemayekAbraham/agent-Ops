-- 1. Snapshot history table
CREATE TABLE public.welile_receivables_summary (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  computed_at timestamptz NOT NULL DEFAULT now(),
  source_table text NOT NULL,
  empty_receivable_total numeric NOT NULL DEFAULT 0,
  empty_houses_count bigint NOT NULL DEFAULT 0,
  unlisted_receivable_total numeric NOT NULL DEFAULT 0,
  unlisted_landlord_count bigint NOT NULL DEFAULT 0,
  known_rent_count bigint NOT NULL DEFAULT 0,
  missing_rent_count bigint NOT NULL DEFAULT 0,
  avg_known_monthly numeric NOT NULL DEFAULT 0,
  recorded_total numeric NOT NULL DEFAULT 0,
  estimated_full_total numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.welile_receivables_summary TO authenticated;
GRANT ALL ON public.welile_receivables_summary TO service_role;

ALTER TABLE public.welile_receivables_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops can read receivables summary"
ON public.welile_receivables_summary
FOR SELECT
TO authenticated
USING (public.is_ops_role(auth.uid()));

CREATE INDEX idx_welile_receivables_summary_computed_at
ON public.welile_receivables_summary (computed_at DESC);

-- 2. Recompute + store function (formula: ((rent + 33%) / 30) * 30 * 12 = rent * 1.33 * 12)
CREATE OR REPLACE FUNCTION public.recompute_receivables_summary(p_source text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_empty_total numeric;
  v_empty_count bigint;
  v_unlisted_total numeric;
  v_unlisted_count bigint;
  v_known_count bigint;
  v_missing_count bigint;
  v_avg_monthly numeric;
BEGIN
  SELECT
    COALESCE(SUM(((monthly_rent * 1.33) / 30) * 30 * 12), 0),
    COUNT(*)
  INTO v_empty_total, v_empty_count
  FROM public.house_listings
  WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false;

  SELECT
    COALESCE(SUM(((COALESCE(l.monthly_rent, l.desired_rent_from_welile, 0) * 1.33) / 30) * 30 * 12), 0),
    COUNT(*)
  INTO v_unlisted_total, v_unlisted_count
  FROM public.landlords l
  WHERE l.registered_by IS NOT NULL
    AND l.tenant_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id);

  -- known / missing / avg across the combined pool
  WITH pool AS (
    SELECT COALESCE(monthly_rent, 0) AS rent
    FROM public.house_listings
    WHERE tenant_id IS NULL AND status <> 'rejected' AND COALESCE(is_hidden, false) = false
    UNION ALL
    SELECT COALESCE(l.monthly_rent, l.desired_rent_from_welile, 0) AS rent
    FROM public.landlords l
    WHERE l.registered_by IS NOT NULL
      AND l.tenant_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.house_listings h WHERE h.landlord_id = l.id)
  )
  SELECT
    COUNT(*) FILTER (WHERE rent > 0),
    COUNT(*) FILTER (WHERE rent <= 0),
    COALESCE(AVG(rent) FILTER (WHERE rent > 0), 0)
  INTO v_known_count, v_missing_count, v_avg_monthly
  FROM pool;

  INSERT INTO public.welile_receivables_summary (
    source_table,
    empty_receivable_total, empty_houses_count,
    unlisted_receivable_total, unlisted_landlord_count,
    known_rent_count, missing_rent_count, avg_known_monthly,
    recorded_total, estimated_full_total
  ) VALUES (
    p_source,
    v_empty_total, v_empty_count,
    v_unlisted_total, v_unlisted_count,
    v_known_count, v_missing_count, v_avg_monthly,
    v_empty_total + v_unlisted_total,
    (v_empty_total + v_unlisted_total) + (v_missing_count * (((v_avg_monthly * 1.33) / 30) * 30 * 12))
  );
END;
$function$;

-- 3. Statement-level trigger function (one snapshot per insert statement — scale-safe)
CREATE OR REPLACE FUNCTION public.trg_recompute_receivables_summary()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public.recompute_receivables_summary(TG_TABLE_NAME);
  RETURN NULL;
END;
$function$;

-- 4. Triggers on insert
DROP TRIGGER IF EXISTS trg_receivables_summary_house_listings ON public.house_listings;
CREATE TRIGGER trg_receivables_summary_house_listings
AFTER INSERT ON public.house_listings
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_recompute_receivables_summary();

DROP TRIGGER IF EXISTS trg_receivables_summary_landlords ON public.landlords;
CREATE TRIGGER trg_receivables_summary_landlords
AFTER INSERT ON public.landlords
FOR EACH STATEMENT
EXECUTE FUNCTION public.trg_recompute_receivables_summary();

-- 5. Seed an initial baseline snapshot
SELECT public.recompute_receivables_summary('seed');