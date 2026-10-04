
-- 1. Alerts table for unbalanced ledger groups
CREATE TABLE IF NOT EXISTS public.ledger_group_imbalance_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_group_id uuid NOT NULL,
  net_imbalance numeric NOT NULL,
  leg_count integer NOT NULL,
  first_leg_at timestamptz,
  categories text[],
  resolved boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  resolved_by uuid,
  notes text,
  detected_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON public.ledger_group_imbalance_alerts TO authenticated;
GRANT ALL ON public.ledger_group_imbalance_alerts TO service_role;

ALTER TABLE public.ledger_group_imbalance_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "CFO can view imbalance alerts"
  ON public.ledger_group_imbalance_alerts FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'));

CREATE POLICY "CFO can update imbalance alerts"
  ON public.ledger_group_imbalance_alerts FOR UPDATE
  TO authenticated
  USING (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'))
  WITH CHECK (public.has_role(auth.uid(), 'cfo') OR public.has_role(auth.uid(), 'manager'));

CREATE INDEX IF NOT EXISTS idx_ledger_imbalance_unresolved
  ON public.ledger_group_imbalance_alerts (resolved, detected_at DESC);

-- 2. Cutoff timestamp so only NEW writes are enforced
CREATE TABLE IF NOT EXISTS public.ledger_integrity_config (
  id boolean PRIMARY KEY DEFAULT true,
  enforce_from timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id)
);
INSERT INTO public.ledger_integrity_config (id) VALUES (true)
  ON CONFLICT (id) DO NOTHING;

GRANT SELECT ON public.ledger_integrity_config TO authenticated;
GRANT ALL ON public.ledger_integrity_config TO service_role;
ALTER TABLE public.ledger_integrity_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone auth reads integrity config"
  ON public.ledger_integrity_config FOR SELECT TO authenticated USING (true);

-- 3. Deferred constraint trigger function
CREATE OR REPLACE FUNCTION public.enforce_ledger_group_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_net numeric;
  v_cutoff timestamptz;
  v_first_at timestamptz;
BEGIN
  IF NEW.transaction_group_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT enforce_from INTO v_cutoff FROM public.ledger_integrity_config WHERE id = true;
  IF v_cutoff IS NULL THEN v_cutoff := now(); END IF;

  -- Only enforce on new production groups created after cutoff
  SELECT MIN(created_at) INTO v_first_at
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id;

  IF v_first_at IS NULL OR v_first_at < v_cutoff THEN
    RETURN NEW;
  END IF;

  IF NEW.classification IS DISTINCT FROM 'production' THEN
    RETURN NEW;
  END IF;

  SELECT SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END)
    INTO v_net
    FROM public.general_ledger
   WHERE transaction_group_id = NEW.transaction_group_id
     AND classification = 'production';

  IF v_net IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Ledger group % is unbalanced (net=%). Every wallet activity must post balanced double-entry legs.',
      NEW.transaction_group_id, v_net
      USING HINT = 'Use create_ledger_transaction with matching credit/debit legs.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_ledger_group_balance ON public.general_ledger;
CREATE CONSTRAINT TRIGGER trg_enforce_ledger_group_balance
  AFTER INSERT ON public.general_ledger
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_ledger_group_balance();

-- 4. Backfill alerts for known unbalanced groups (last 90 days)
INSERT INTO public.ledger_group_imbalance_alerts (
  transaction_group_id, net_imbalance, leg_count, first_leg_at, categories
)
SELECT
  transaction_group_id,
  SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) AS net,
  COUNT(*),
  MIN(created_at),
  array_agg(DISTINCT category)
FROM public.general_ledger
WHERE created_at > now() - interval '90 days'
  AND classification = 'production'
  AND transaction_group_id IS NOT NULL
GROUP BY transaction_group_id
HAVING SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) <> 0
ON CONFLICT DO NOTHING;

-- 5. Detection RPC for cron / dashboards
CREATE OR REPLACE FUNCTION public.detect_ledger_group_imbalances(p_since_hours integer DEFAULT 24)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count int := 0;
BEGIN
  WITH new_alerts AS (
    INSERT INTO public.ledger_group_imbalance_alerts (
      transaction_group_id, net_imbalance, leg_count, first_leg_at, categories
    )
    SELECT tgi, net, cnt, first_at, cats
    FROM (
      SELECT transaction_group_id AS tgi,
             SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) AS net,
             COUNT(*) AS cnt,
             MIN(created_at) AS first_at,
             array_agg(DISTINCT category) AS cats
      FROM public.general_ledger
      WHERE created_at > now() - make_interval(hours => p_since_hours)
        AND classification = 'production'
        AND transaction_group_id IS NOT NULL
      GROUP BY transaction_group_id
      HAVING SUM(CASE WHEN direction IN ('cash_in','credit') THEN amount ELSE -amount END) <> 0
    ) s
    WHERE NOT EXISTS (
      SELECT 1 FROM public.ledger_group_imbalance_alerts a
       WHERE a.transaction_group_id = s.tgi
    )
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM new_alerts;
  RETURN v_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.detect_ledger_group_imbalances(integer) TO authenticated, service_role;
