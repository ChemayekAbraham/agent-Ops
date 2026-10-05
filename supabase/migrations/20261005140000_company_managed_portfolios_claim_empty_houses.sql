-- Company-managed portfolios claim empty houses.
--
-- When Partner Ops or the COO creates a company-managed portfolio, the system
-- claims real empty houses whose rents add up to the principal. Those houses
-- leave the funder queue, so "Amount needed to fund houses" falls by the amount
-- claimed, and the portfolio can answer "how many homes am I supporting?".
--
-- Design agreed in docs/company-managed-portfolio-house-allocation-spec.md.
--
-- THE RULE THAT SHAPES EVERYTHING: claiming a house MOVES NO MONEY. No
-- landlord_payouts row, no agent_landlord_float_allocations, no CFO queue entry,
-- no ledger leg. The landlord is paid only when a real tenant takes the house
-- and a Rent Plan is funded through the normal flow. A claim is a commitment
-- against capital, not a payment, so the ROI owed to the funder is unchanged.
--
-- IT MUST NOT COLLIDE WITH THE SELF-MANAGED FLOW. Where a funder picks houses
-- or plans themselves, the selection is recorded in funder_pending_portfolios
-- (sources: self_managed, self_managed_house, rent_pool) and goes to review.
-- Measured 2026-10-05, one of the 48 company-managed portfolios already carries
-- such a row, so `pool_origin` alone is NOT a safe trigger. The allocator
-- refuses any portfolio that has a pending-selection row.
--
-- MEASURED BASELINE 2026-10-05: 6,451 houses in the queue worth UGX
-- 5,830,028,954; median rent 150,000; cheapest 10,000. A 20,000,000 portfolio
-- claims 31 houses oldest-first, uses 19,965,000 and leaves 35,000.

-- ---------------------------------------------------------------------------
-- 1. The allocation table
-- ---------------------------------------------------------------------------
--
-- promissory_note_house_intents cannot be reused: its note_id is NOT NULL with
-- an FK to promissory_notes, agent_id is NOT NULL, and it is UNIQUE
-- (note_id, house_id). A portfolio claim has neither a note nor an agent.
--
-- The table is polymorphic from day one. Phase one writes empty houses only.
--
-- TODO (SSENKAALI PIUS): Rent Plans will be attached to company-managed
-- portfolios too. The shape is already here — write rows with
-- target_type = 'rent_plan' and claimed_basis = 'plan_principal', widen the
-- candidate query, and split the dashboard by target_type. No schema change and
-- no backfill will be needed. See §11b.6 of the spec.
CREATE TABLE IF NOT EXISTS public.portfolio_allocations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id              uuid NOT NULL REFERENCES public.investor_portfolios(id) ON DELETE CASCADE,

  -- What is claimed.
  target_type               text NOT NULL,              -- 'empty_house' | 'rent_plan'
  house_id                  uuid REFERENCES public.house_listings(id) ON DELETE CASCADE,
  rent_request_id           uuid REFERENCES public.rent_requests(id),

  -- How much, snapshotted. A landlord may re-price the listing afterwards; the
  -- claim stands at the figure agreed when it was made, or the portfolio's
  -- supported total drifts silently.
  claimed_amount            numeric NOT NULL,
  claimed_basis             text NOT NULL,              -- 'monthly_rent' | 'plan_principal'

  status                    text NOT NULL DEFAULT 'reserved',  -- reserved|fulfilled|released
  created_at                timestamptz NOT NULL DEFAULT now(),
  fulfilled_at              timestamptz,
  fulfilled_rent_request_id uuid,
  released_at               timestamptz,
  release_reason            text,

  -- Denormalised on purpose: a claim is a historical fact and must keep saying
  -- what kind of money made it even if the portfolio is edited later.
  pool_origin               text NOT NULL,

  CONSTRAINT portfolio_allocations_target_shape CHECK (
    (target_type = 'empty_house' AND house_id IS NOT NULL AND rent_request_id IS NULL)
    OR
    (target_type = 'rent_plan'   AND rent_request_id IS NOT NULL AND house_id IS NULL)
  ),
  CONSTRAINT portfolio_allocations_basis_shape CHECK (
    (target_type = 'empty_house' AND claimed_basis = 'monthly_rent')
    OR
    (target_type = 'rent_plan'   AND claimed_basis = 'plan_principal')
  ),
  CONSTRAINT portfolio_allocations_status_shape CHECK (
    status IN ('reserved', 'fulfilled', 'released')
  ),
  CONSTRAINT portfolio_allocations_amount_positive CHECK (claimed_amount > 0)
);

-- A house, and later a plan, can carry only ONE live claim. This is what makes
-- two portfolios created in the same instant safe: the loser simply skips that
-- house and takes the next.
CREATE UNIQUE INDEX IF NOT EXISTS portfolio_allocations_one_live_house
  ON public.portfolio_allocations (house_id)
  WHERE status IN ('reserved', 'fulfilled') AND house_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS portfolio_allocations_one_live_plan
  ON public.portfolio_allocations (rent_request_id)
  WHERE status IN ('reserved', 'fulfilled') AND rent_request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS portfolio_allocations_by_portfolio
  ON public.portfolio_allocations (portfolio_id, status);

CREATE INDEX IF NOT EXISTS portfolio_allocations_pool
  ON public.portfolio_allocations (pool_origin, status, target_type);

COMMENT ON TABLE public.portfolio_allocations IS
  'What a portfolio is supporting. One row per claimed empty house (and later '
  'per claimed Rent Plan). Writing a row moves no money: the landlord is paid '
  'only when a real tenant takes the house and a Rent Plan is funded.';

ALTER TABLE public.portfolio_allocations ENABLE ROW LEVEL SECURITY;

-- Readable by staff who can already see portfolios; written only by the
-- SECURITY DEFINER allocator below.
DROP POLICY IF EXISTS portfolio_allocations_staff_read ON public.portfolio_allocations;
CREATE POLICY portfolio_allocations_staff_read ON public.portfolio_allocations
  FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo'::public.app_role)
    OR public.has_role(auth.uid(), 'coo'::public.app_role)
    OR public.has_role(auth.uid(), 'ceo'::public.app_role)
    OR public.has_role(auth.uid(), 'cto'::public.app_role)
    OR public.has_role(auth.uid(), 'manager'::public.app_role)
    OR public.has_role(auth.uid(), 'super_admin'::public.app_role)
    OR public.has_role(auth.uid(), 'operations'::public.app_role)
  );

-- ---------------------------------------------------------------------------
-- 2. One definition of "this house is already claimed"
-- ---------------------------------------------------------------------------
--
-- Two mechanisms can claim a house: a promissory-note intent (the funder picks
-- it) and a portfolio allocation (this feature). Every reader must honour both
-- or the funder card, the map cells and the allocator will disagree within a
-- week.
--
-- LANGUAGE sql and STABLE on purpose: a single-SELECT SQL function is inlinable
-- by the planner, so calling it across 6,451 candidate rows costs one EXISTS
-- subplan rather than 6,451 function invocations.
CREATE OR REPLACE FUNCTION public.house_has_live_claim(p_house_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.promissory_note_house_intents i
     WHERE i.house_id = p_house_id
       -- 'funded' counts as claimed. It did not before, which is why a house
       -- whose intent completed fell straight back into the "still needed"
       -- queue. Under this feature `fulfilled`/`funded` is the normal end state
       -- of every successful claim, so the old test would overstate the queue
       -- by design.
       AND i.status IN ('reserved', 'funded')
    UNION ALL
    SELECT 1 FROM public.portfolio_allocations a
     WHERE a.house_id = p_house_id
       AND a.status IN ('reserved', 'fulfilled')
  );
$function$;

COMMENT ON FUNCTION public.house_has_live_claim(uuid) IS
  'True when an empty house is already spoken for, by either a promissory-note '
  'intent or a company-managed portfolio allocation. The single source of truth '
  'for the funder queue, the map cells and the portfolio allocator.';

GRANT EXECUTE ON FUNCTION public.house_has_live_claim(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Portfolio-level counters
-- ---------------------------------------------------------------------------
--
-- Two counters, not one: a house claim is ONE RENT CYCLE of monthly rent while
-- a plan claim is a FULL principal, so a single mixed total would be a
-- meaningless number on a dashboard.
ALTER TABLE public.investor_portfolios
  ADD COLUMN IF NOT EXISTS houses_claimed_count  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS plans_claimed_count   integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS principal_allocated   numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS principal_unallocated numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allocation_note       text;

COMMENT ON COLUMN public.investor_portfolios.principal_unallocated IS
  'Principal no house could absorb. Deliberately NOT re-swept later: a second '
  'pass reopens FIFO and reconciliation questions for a few thousand shillings. '
  'principal_allocated + principal_unallocated must always equal '
  'investment_amount.';

-- ---------------------------------------------------------------------------
-- 4. The allocator
-- ---------------------------------------------------------------------------
--
-- ONE round trip. The whole selection is a single INSERT ... SELECT with two
-- window passes; there is no row-by-row loop and no N+1:
--
--   pass 1  greedy prefix, OLDEST LISTING FIRST. A running SUM() is monotonic
--           because every rent is > 0, so `running <= principal` is exactly
--           "take houses in order until the next would overshoot".
--   pass 2  best-fit-decreasing over what is left, within the remainder. This
--           is the classic BFD heuristic, not optimal bin packing (which is
--           NP-hard and not worth it here). With 207 houses at <= 35,000 and
--           723 at <= 50,000 it closes most remainders to a few thousand.
--
-- NEVER OVERSHOOT: no house is claimed whose rent exceeds the principal still
-- unclaimed.
--
-- ALLOCATION IS BEST-EFFORT AND NEVER BLOCKS PORTFOLIO CREATION. Claiming
-- nothing is a valid outcome — a small principal, an empty queue, or no fitting
-- house. The reason is recorded in allocation_note so Ops can see WHY nothing
-- was claimed rather than wondering whether it broke.
CREATE OR REPLACE FUNCTION public.allocate_company_managed_portfolio(p_portfolio_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_principal numeric;
  v_origin    text;
  v_claimed   numeric := 0;
  v_count     integer := 0;
  v_note      text;
BEGIN
  SELECT COALESCE(investment_amount, 0), COALESCE(pool_origin, '')
    INTO v_principal, v_origin
    FROM public.investor_portfolios
   WHERE id = p_portfolio_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'portfolio_not_found');
  END IF;

  IF v_origin <> 'company_managed' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_company_managed');
  END IF;

  -- The self-managed flow: the funder picked houses or plans themselves and the
  -- selection is awaiting review. That path owns its own linkage; this one must
  -- not touch it.
  IF EXISTS (SELECT 1 FROM public.funder_pending_portfolios f
              WHERE f.portfolio_id = p_portfolio_id) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'self_managed_selection_exists');
  END IF;

  -- Idempotent: a second call never double-claims.
  IF EXISTS (SELECT 1 FROM public.portfolio_allocations a
              WHERE a.portfolio_id = p_portfolio_id
                AND a.status IN ('reserved', 'fulfilled')) THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_allocated');
  END IF;

  IF v_principal <= 0 THEN
    UPDATE public.investor_portfolios
       SET principal_allocated = 0, principal_unallocated = 0,
           houses_claimed_count = 0, allocation_note = 'no_principal'
     WHERE id = p_portfolio_id;
    RETURN jsonb_build_object('ok', true, 'claimed_count', 0, 'reason', 'no_principal');
  END IF;

  WITH candidates AS (
    SELECT h.id, COALESCE(h.monthly_rent, 0)::numeric AS rent, h.created_at
      FROM public.house_listings h
     WHERE h.status = 'available'
       AND h.tenant_id IS NULL
       AND COALESCE(h.is_hidden, false) = false
       AND COALESCE(h.monthly_rent, 0) > 0
       AND NOT public.house_has_live_claim(h.id)
  ),
  pass1 AS (                                   -- greedy prefix, oldest first
    SELECT id, rent FROM (
      SELECT id, rent,
             SUM(rent) OVER (ORDER BY created_at, id ROWS UNBOUNDED PRECEDING) AS running
        FROM candidates
    ) q
     WHERE running <= v_principal
  ),
  remainder AS (
    SELECT v_principal - COALESCE((SELECT SUM(rent) FROM pass1), 0) AS left_over
  ),
  pass2 AS (                                   -- best-fit-decreasing fill
    SELECT id, rent FROM (
      SELECT c.id, c.rent,
             SUM(c.rent) OVER (ORDER BY c.rent DESC, c.id ROWS UNBOUNDED PRECEDING) AS running
        FROM candidates c
       WHERE NOT EXISTS (SELECT 1 FROM pass1 p WHERE p.id = c.id)
         AND c.rent <= (SELECT left_over FROM remainder)
    ) q
     WHERE running <= (SELECT left_over FROM remainder)
  ),
  picked AS (
    SELECT id, rent FROM pass1
    UNION ALL
    SELECT id, rent FROM pass2
  ),
  inserted AS (
    INSERT INTO public.portfolio_allocations
      (portfolio_id, target_type, house_id, claimed_amount, claimed_basis, status, pool_origin)
    SELECT p_portfolio_id, 'empty_house', picked.id, picked.rent, 'monthly_rent', 'reserved', v_origin
      FROM picked
    -- Another portfolio may have claimed the same house a moment earlier; the
    -- partial unique index catches it and this one simply skips it.
    ON CONFLICT DO NOTHING
    RETURNING claimed_amount
  )
  SELECT COUNT(*), COALESCE(SUM(claimed_amount), 0) INTO v_count, v_claimed FROM inserted;

  v_note := CASE
    WHEN v_count > 0 THEN NULL
    WHEN NOT EXISTS (
      SELECT 1 FROM public.house_listings h
       WHERE h.status = 'available' AND h.tenant_id IS NULL
         AND COALESCE(h.is_hidden, false) = false
         AND COALESCE(h.monthly_rent, 0) > 0
         AND NOT public.house_has_live_claim(h.id)
    ) THEN 'queue_empty'
    ELSE 'principal_below_cheapest_house'
  END;

  UPDATE public.investor_portfolios
     SET houses_claimed_count  = v_count,
         principal_allocated   = v_claimed,
         principal_unallocated = v_principal - v_claimed,
         allocation_note       = v_note
   WHERE id = p_portfolio_id;

  RETURN jsonb_build_object(
    'ok', true,
    'portfolio_id', p_portfolio_id,
    'claimed_count', v_count,
    'principal', v_principal,
    'allocated', v_claimed,
    'unallocated', v_principal - v_claimed,
    'note', v_note);
END;
$function$;

REVOKE ALL ON FUNCTION public.allocate_company_managed_portfolio(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.allocate_company_managed_portfolio(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Fire it on creation, without ever blocking creation
-- ---------------------------------------------------------------------------
--
-- The EXCEPTION block is the whole point: a portfolio must be created even if
-- allocation fails outright. A funder's capital does not depend on whether we
-- found houses for it.
CREATE OR REPLACE FUNCTION public.trg_allocate_company_managed_portfolio()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  BEGIN
    PERFORM public.allocate_company_managed_portfolio(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'company-managed allocation failed for portfolio %: %', NEW.id, SQLERRM;
    UPDATE public.investor_portfolios
       SET allocation_note = 'allocation_error: ' || left(SQLERRM, 180)
     WHERE id = NEW.id;
  END;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_allocate_company_managed_portfolio ON public.investor_portfolios;
CREATE TRIGGER trg_allocate_company_managed_portfolio
  AFTER INSERT ON public.investor_portfolios
  FOR EACH ROW
  WHEN (NEW.pool_origin = 'company_managed' AND NEW.status IN ('active', 'locked'))
  EXECUTE FUNCTION public.trg_allocate_company_managed_portfolio();

-- ---------------------------------------------------------------------------
-- 6. The funder queue honours both kinds of claim
-- ---------------------------------------------------------------------------
--
-- Previously this excluded a house only when a promissory-note intent was
-- 'reserved'. It now defers entirely to house_has_live_claim(), so portfolio
-- claims drop out of the queue and 'funded' intents stop re-entering it.
CREATE OR REPLACE FUNCTION public.empty_house_opportunity_summary()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
WITH base AS (
  SELECT h.id, COALESCE(h.monthly_rent, 0) AS rent,
         NULLIF(TRIM(COALESCE(h.district, '')), '') AS district,
         h.landlord_id,
         public.house_has_live_claim(h.id) AS is_funded
  FROM public.house_listings h
  WHERE h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden, false) = false
    AND COALESCE(h.monthly_rent, 0) > 0
),
avail AS (SELECT * FROM base WHERE NOT is_funded),
districts AS (
  SELECT jsonb_agg(d ORDER BY (d->>'total_rent_needed')::numeric DESC) AS rows
  FROM (
    SELECT jsonb_build_object(
      'district', COALESCE(district, 'Unspecified'),
      'house_count', COUNT(*),
      'total_rent_needed', COALESCE(SUM(rent), 0),
      'monthly_return', COALESCE(SUM(ROUND(rent * 0.15)), 0)
    ) AS d
    FROM avail
    GROUP BY COALESCE(district, 'Unspecified')
    ORDER BY SUM(rent) DESC
    LIMIT 12
  ) t
),
landlords AS (
  SELECT jsonb_agg(l ORDER BY (l->>'total_rent_needed')::numeric DESC) AS rows
  FROM (
    SELECT jsonb_build_object(
      'landlord_name', TRIM(p.name),
      'house_count', COUNT(*),
      'total_rent_needed', COALESCE(SUM(a.rent), 0),
      'monthly_return', COALESCE(SUM(ROUND(a.rent * 0.15)), 0)
    ) AS l
    FROM avail a
    JOIN public.landlords p ON p.id = a.landlord_id
    WHERE NULLIF(TRIM(COALESCE(p.name, '')), '') IS NOT NULL
    GROUP BY TRIM(p.name)
    ORDER BY SUM(a.rent) DESC
    LIMIT 8
  ) t
)
SELECT jsonb_build_object(
  'house_count', (SELECT COUNT(*) FROM avail),
  'total_rent_needed', (SELECT COALESCE(SUM(rent), 0) FROM avail),
  'monthly_return_if_all_funded', (SELECT COALESCE(SUM(ROUND(rent * 0.15)), 0) FROM avail),
  'avg_monthly_rent', (SELECT COALESCE(ROUND(AVG(rent)), 0) FROM avail),
  'funded_count', (SELECT COUNT(*) FROM base WHERE is_funded),
  'funded_rent', (SELECT COALESCE(SUM(rent), 0) FROM base WHERE is_funded),
  'total_listed', (SELECT COUNT(*) FROM base),
  'districts', COALESCE((SELECT rows FROM districts), '[]'::jsonb),
  'landlords', COALESCE((SELECT rows FROM landlords), '[]'::jsonb)
);
$function$;

-- ---------------------------------------------------------------------------
-- 7. Release a claim when the house goes to a real tenant
-- ---------------------------------------------------------------------------
--
-- A reservation must never block an actual letting. When a house stops being
-- available the claim is released and the principal returns to the portfolio's
-- unallocated balance, so the books still tally.
CREATE OR REPLACE FUNCTION public.release_portfolio_claim_on_house_taken()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_portfolio uuid; v_amount numeric;
BEGIN
  IF NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id
     AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS NULL AND NEW.status = 'available' THEN
    RETURN NEW;
  END IF;

  UPDATE public.portfolio_allocations
     SET status = 'released', released_at = now(), release_reason = 'let_to_tenant'
   WHERE house_id = NEW.id AND status = 'reserved'
  RETURNING portfolio_id, claimed_amount INTO v_portfolio, v_amount;

  IF v_portfolio IS NOT NULL THEN
    UPDATE public.investor_portfolios
       SET houses_claimed_count  = GREATEST(0, houses_claimed_count - 1),
           principal_allocated   = GREATEST(0, principal_allocated - v_amount),
           principal_unallocated = principal_unallocated + v_amount
     WHERE id = v_portfolio;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_release_portfolio_claim_on_house_taken ON public.house_listings;
CREATE TRIGGER trg_release_portfolio_claim_on_house_taken
  AFTER UPDATE ON public.house_listings
  FOR EACH ROW
  EXECUTE FUNCTION public.release_portfolio_claim_on_house_taken();
