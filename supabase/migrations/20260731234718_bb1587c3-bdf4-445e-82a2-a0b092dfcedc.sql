-- STEP 2 + STEP 3.5: build candidate from a single snapshot of v_user_wallet_strict, then prove it.
CREATE TABLE IF NOT EXISTS public.ledger_balance_pivot_candidate (
  user_id uuid NOT NULL,
  bucket text NOT NULL,
  balance_sum numeric NOT NULL DEFAULT 0,
  last_updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, bucket)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.ledger_balance_pivot_candidate TO service_role;
ALTER TABLE public.ledger_balance_pivot_candidate ENABLE ROW LEVEL SECURITY;
CREATE POLICY "candidate pivot service only"
  ON public.ledger_balance_pivot_candidate FOR ALL
  USING (false) WITH CHECK (false);

-- Single consistent snapshot of strict wallet truth
CREATE TEMP TABLE _strict_snap ON COMMIT DROP AS
SELECT user_id,
       COALESCE(withdrawable, 0)::numeric    AS withdrawable,
       COALESCE(float_balance, 0)::numeric   AS float_balance,
       COALESCE(advance_balance, 0)::numeric AS advance_balance
FROM public.v_user_wallet_strict
WHERE user_id IS NOT NULL;

TRUNCATE public.ledger_balance_pivot_candidate;

INSERT INTO public.ledger_balance_pivot_candidate (user_id, bucket, balance_sum)
SELECT user_id, 'withdrawable', withdrawable FROM _strict_snap
UNION ALL
SELECT user_id, 'float', float_balance FROM _strict_snap
UNION ALL
SELECT user_id, 'advance', advance_balance FROM _strict_snap;

DO $$
DECLARE
  s_w numeric; s_f numeric; s_a numeric;
  c_w numeric; c_f numeric; c_a numeric;
  s_users bigint; c_users bigint; dups bigint;
  s_sum text; c_sum text;
BEGIN
  SELECT sum(withdrawable), sum(float_balance), sum(advance_balance), count(*)
    INTO s_w, s_f, s_a, s_users FROM _strict_snap;

  SELECT sum(balance_sum) FILTER (WHERE bucket='withdrawable'),
         sum(balance_sum) FILTER (WHERE bucket='float'),
         sum(balance_sum) FILTER (WHERE bucket='advance'),
         count(DISTINCT user_id)
    INTO c_w, c_f, c_a, c_users FROM public.ledger_balance_pivot_candidate;

  IF s_w IS DISTINCT FROM c_w THEN RAISE EXCEPTION 'INVARIANT FAIL withdrawable sum: strict=% candidate=%', s_w, c_w; END IF;
  IF s_f IS DISTINCT FROM c_f THEN RAISE EXCEPTION 'INVARIANT FAIL float sum: strict=% candidate=%', s_f, c_f; END IF;
  IF s_a IS DISTINCT FROM c_a THEN RAISE EXCEPTION 'INVARIANT FAIL advance sum: strict=% candidate=%', s_a, c_a; END IF;
  IF s_users IS DISTINCT FROM c_users THEN RAISE EXCEPTION 'INVARIANT FAIL user count: strict=% candidate=%', s_users, c_users; END IF;

  SELECT count(*) INTO dups FROM (
    SELECT user_id, bucket FROM public.ledger_balance_pivot_candidate
    GROUP BY 1,2 HAVING count(*) > 1
  ) d;
  IF dups > 0 THEN RAISE EXCEPTION 'INVARIANT FAIL duplicate (user_id,bucket) rows: %', dups; END IF;

  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO s_sum
    FROM (SELECT user_id::text || ':' || withdrawable::text || ':' || float_balance::text || ':' || advance_balance::text AS t
          FROM _strict_snap) x;

  SELECT md5(string_agg(t, '|' ORDER BY t)) INTO c_sum
    FROM (SELECT user_id::text || ':' ||
                 max(balance_sum) FILTER (WHERE bucket='withdrawable')::text || ':' ||
                 max(balance_sum) FILTER (WHERE bucket='float')::text || ':' ||
                 max(balance_sum) FILTER (WHERE bucket='advance')::text AS t
          FROM public.ledger_balance_pivot_candidate GROUP BY user_id) y;

  IF s_sum IS DISTINCT FROM c_sum THEN
    RAISE EXCEPTION 'INVARIANT FAIL checksum: strict=% candidate=%', s_sum, c_sum;
  END IF;

  RAISE NOTICE 'INVARIANTS PASSED users=% w=% f=% a=% checksum=%', s_users, s_w, s_f, s_a, s_sum;
END $$;