-- Landlord float budget cap: the CFO sets how much landlord float may go out per day and per week, and the COO
-- can only forward rent requests to the CFO while they fit inside it.
--
-- Rules (agreed with Josh / ops, 2026-10-16):
--   * The CFO (the designated approver, public.is_cfo_approver) sets a DAILY and a WEEKLY budget. Days and weeks follow
--     Africa/Kampala; weeks run Monday to Sunday. Each period resets on its own; nothing rolls over.
--   * A daily budget above that week's weekly budget (or a weekly budget below a daily budget inside it) is allowed, but
--     only with a written reason, which is stored.
--   * The COO approves against the room left = least(daily remaining, weekly remaining), measured on rent_amount.
--     No daily or no weekly budget for today means COO approvals are blocked.
--   * A request that does not fit stays at the COO step. The COO may ask the CFO for a per-request "miscellaneous"
--     approval with a reason; once the CFO approves it the request moves to the CFO stage outside the cap.
--   * The CFO may change a budget mid-period. If what is already approved is then above it, the CFO and COO are notified
--     with the excess; approved requests are not blocked.
--   * A CFO rejection at the disbursement step returns the request to the COO step and gives its amount back to the budget.
--   * Every budget (including superseded ones) and every approval made against it is kept as history.
--
-- Accounting: this is a budget control, not a money movement. Nothing here posts to general_ledger, touches a wallet or
-- changes ledger_account_map. The amount measured is rent_requests.rent_amount, which is exactly what
-- fund-agent-landlord-float later funds to the agent's landlord float, so the budget and the books measure the same thing.
--
-- Enforcement: the COO step (partner_ops_approved -> coo_approved) is refused by trigger unless it comes through
-- coo_approve_rent_requests / cfo_decide_landlord_float_misc, so a direct table write cannot bypass the cap.
-- Allocations are released by trigger whenever a request moves back before the COO step, so every return path
-- (CFO return, rejection, cancellation) gives the amount back in one place.

-- ─── Clock helpers ───────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.landlord_float_budget_today()
RETURNS date
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT (now() AT TIME ZONE 'Africa/Kampala')::date $$;

CREATE OR REPLACE FUNCTION public.landlord_float_week_start(p_day date)
RETURNS date
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT p_day - (extract(isodow FROM p_day)::int - 1) $$;

-- ─── Tables ──────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.landlord_float_budgets (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_type          text NOT NULL CHECK (period_type IN ('daily', 'weekly')),
  period_start         date NOT NULL,
  period_end           date NOT NULL,
  amount               numeric(14,2) NOT NULL CHECK (amount > 0),
  reason               text,
  over_weekly_warning  boolean NOT NULL DEFAULT false,
  set_by               uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  superseded_at        timestamptz,
  superseded_by        uuid REFERENCES public.landlord_float_budgets(id),
  CONSTRAINT landlord_float_budgets_period_shape CHECK (
    (period_type = 'daily'  AND period_end = period_start)
    OR (period_type = 'weekly' AND period_end = period_start + 6 AND extract(isodow FROM period_start) = 1)
  ),
  CONSTRAINT landlord_float_budgets_warning_needs_reason CHECK (
    NOT over_weekly_warning OR length(btrim(COALESCE(reason, ''))) >= 10
  )
);

-- One live budget per period; superseded rows stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS landlord_float_budgets_one_active
  ON public.landlord_float_budgets (period_type, period_start) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS landlord_float_budgets_history
  ON public.landlord_float_budgets (period_start DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS public.landlord_float_misc_requests (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id  uuid NOT NULL REFERENCES public.rent_requests(id),
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  reason           text NOT NULL CHECK (length(btrim(reason)) >= 10),
  room_at_request  numeric(14,2) NOT NULL,
  budget_date      date NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  requested_by     uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  cfo_decided_by   uuid,
  cfo_decided_at   timestamptz,
  cfo_note         text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS landlord_float_misc_one_pending
  ON public.landlord_float_misc_requests (rent_request_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS landlord_float_misc_by_status
  ON public.landlord_float_misc_requests (status, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.landlord_float_budget_allocations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id     uuid NOT NULL REFERENCES public.rent_requests(id),
  kind                text NOT NULL CHECK (kind IN ('within_cap', 'miscellaneous')),
  amount              numeric(14,2) NOT NULL CHECK (amount >= 0),
  budget_date         date NOT NULL,
  week_start          date NOT NULL,
  daily_budget_id     uuid REFERENCES public.landlord_float_budgets(id),
  weekly_budget_id    uuid REFERENCES public.landlord_float_budgets(id),
  misc_request_id     uuid REFERENCES public.landlord_float_misc_requests(id),
  approved_by         uuid NOT NULL,
  approved_at         timestamptz NOT NULL DEFAULT now(),
  released_at         timestamptz,
  released_reason     text,
  released_to_status  text,
  CONSTRAINT landlord_float_alloc_week CHECK (week_start = public.landlord_float_week_start(budget_date)),
  CONSTRAINT landlord_float_alloc_misc_link CHECK ((kind = 'miscellaneous') = (misc_request_id IS NOT NULL))
);

-- A request holds at most one live allocation; released ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS landlord_float_alloc_one_active
  ON public.landlord_float_budget_allocations (rent_request_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS landlord_float_alloc_active_week
  ON public.landlord_float_budget_allocations (week_start, budget_date) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS landlord_float_alloc_by_week
  ON public.landlord_float_budget_allocations (week_start, approved_at DESC);

-- ─── Access: COO and CFO read; every write goes through the functions below ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.landlord_float_budget_can_view(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT _user_id IS NOT NULL
     AND (public.has_role(_user_id, 'coo'::public.app_role) OR public.has_role(_user_id, 'cfo'::public.app_role))
$$;

ALTER TABLE public.landlord_float_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landlord_float_misc_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.landlord_float_budget_allocations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "COO and CFO read landlord float budgets" ON public.landlord_float_budgets;
CREATE POLICY "COO and CFO read landlord float budgets" ON public.landlord_float_budgets
  FOR SELECT TO authenticated USING (public.landlord_float_budget_can_view(auth.uid()));

DROP POLICY IF EXISTS "COO and CFO read landlord float misc requests" ON public.landlord_float_misc_requests;
CREATE POLICY "COO and CFO read landlord float misc requests" ON public.landlord_float_misc_requests
  FOR SELECT TO authenticated USING (public.landlord_float_budget_can_view(auth.uid()));

DROP POLICY IF EXISTS "COO and CFO read landlord float allocations" ON public.landlord_float_budget_allocations;
CREATE POLICY "COO and CFO read landlord float allocations" ON public.landlord_float_budget_allocations
  FOR SELECT TO authenticated USING (public.landlord_float_budget_can_view(auth.uid()));

REVOKE ALL ON public.landlord_float_budgets, public.landlord_float_misc_requests, public.landlord_float_budget_allocations
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.landlord_float_budgets, public.landlord_float_misc_requests, public.landlord_float_budget_allocations
  TO authenticated;

-- ─── Internal helpers ────────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._landlord_float_ugx(p_amount numeric)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public', 'pg_temp'
AS $$ SELECT 'UGX ' || to_char(round(COALESCE(p_amount, 0)), 'FM999,999,999,999,990') $$;

-- One period (daily or weekly) as JSON. b is the live budget row (all NULL when none is set).
CREATE OR REPLACE FUNCTION public._landlord_float_period_json(
  b public.landlord_float_budgets, p_used numeric, p_misc numeric, p_count integer)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT jsonb_build_object(
    'budget_id',           b.id,
    'amount',              b.amount,
    'used',                p_used,
    'misc_used',           p_misc,
    'approved_count',      p_count,
    'remaining',           CASE WHEN b.id IS NULL THEN NULL ELSE greatest(b.amount - p_used, 0) END,
    'excess',              CASE WHEN b.id IS NULL THEN 0 ELSE greatest(p_used - b.amount, 0) END,
    'reason',              b.reason,
    'over_weekly_warning', COALESCE(b.over_weekly_warning, false),
    'set_by',              b.set_by,
    'set_by_name',         (SELECT p.full_name FROM public.profiles p WHERE p.id = b.set_by),
    'set_at',              b.created_at
  )
$$;

-- The budget position for one Kampala day: both periods, what is used, and the room the COO has left.
-- "used" counts live within-cap allocations; miscellaneous approvals are reported separately and never eat the cap.
CREATE OR REPLACE FUNCTION public._landlord_float_position(p_day date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ws      date := public.landlord_float_week_start(p_day);
  v_d       public.landlord_float_budgets%ROWTYPE;
  v_w       public.landlord_float_budgets%ROWTYPE;
  v_d_used  numeric; v_d_misc numeric; v_d_count integer;
  v_w_used  numeric; v_w_misc numeric; v_w_count integer;
  v_blocked text;
  v_room    numeric;
BEGIN
  SELECT * INTO v_d FROM public.landlord_float_budgets
   WHERE period_type = 'daily' AND period_start = p_day AND superseded_at IS NULL;
  SELECT * INTO v_w FROM public.landlord_float_budgets
   WHERE period_type = 'weekly' AND period_start = v_ws AND superseded_at IS NULL;

  -- One pass over the week's live allocations gives both periods.
  SELECT COALESCE(sum(amount) FILTER (WHERE kind = 'within_cap'    AND budget_date = p_day), 0),
         COALESCE(sum(amount) FILTER (WHERE kind = 'miscellaneous' AND budget_date = p_day), 0),
         (count(*) FILTER (WHERE budget_date = p_day))::int,
         COALESCE(sum(amount) FILTER (WHERE kind = 'within_cap'), 0),
         COALESCE(sum(amount) FILTER (WHERE kind = 'miscellaneous'), 0),
         count(*)::int
    INTO v_d_used, v_d_misc, v_d_count, v_w_used, v_w_misc, v_w_count
    FROM public.landlord_float_budget_allocations
   WHERE week_start = v_ws AND released_at IS NULL;

  v_blocked := CASE WHEN v_d.id IS NULL THEN 'no_daily_budget'
                    WHEN v_w.id IS NULL THEN 'no_weekly_budget' END;
  v_room := CASE WHEN v_blocked IS NULL
                 THEN least(greatest(v_d.amount - v_d_used, 0), greatest(v_w.amount - v_w_used, 0))
                 ELSE 0 END;

  RETURN jsonb_build_object(
    'day',            p_day,
    'week_start',     v_ws,
    'week_end',       v_ws + 6,
    'blocked',        v_blocked IS NOT NULL,
    'blocked_reason', v_blocked,
    'room',           v_room,
    'daily',          public._landlord_float_period_json(v_d, v_d_used, v_d_misc, v_d_count),
    'weekly',         public._landlord_float_period_json(v_w, v_w_used, v_w_misc, v_w_count)
  );
END;
$$;

-- In-app notification to everyone holding one of p_roles (one row per person, however many roles they hold).
CREATE OR REPLACE FUNCTION public._landlord_float_notify(
  p_roles text[], p_title text, p_message text, p_metadata jsonb, p_event_key text, p_link text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path, event_key)
  SELECT ur.user_id, p_title, p_message, 'budget', p_metadata,
         COALESCE(p_link, CASE WHEN bool_or(ur.role::text = 'cfo') THEN '/cfo/dashboard' ELSE '/coo/dashboard' END),
         p_event_key
    FROM public.user_roles ur
   WHERE ur.enabled AND ur.role::text = ANY (p_roles)
   GROUP BY ur.user_id
$$;

-- Human message for a request that cannot be decided at the COO step, or NULL when it can.
CREATE OR REPLACE FUNCTION public._landlord_float_coo_step_problem(p_row public.rent_requests, p_uid uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN p_row.id IS NULL THEN
      jsonb_build_object('reason', 'not_found', 'message', 'Rent request not found')
    WHEN p_row.status IS DISTINCT FROM 'partner_ops_approved' THEN
      jsonb_build_object('reason', 'already_moved',
                         'message', format('This rent request is at "%s", not waiting for the COO', p_row.status))
    WHEN COALESCE(p_row.registration_type, 'normal') = 'outstanding_balance' THEN
      jsonb_build_object('reason', 'outstanding_balance',
                         'message', 'Outstanding-balance rent requests do not go through COO approval')
    WHEN p_uid = p_row.agent_id OR p_uid = p_row.assigned_agent_id THEN
      jsonb_build_object('reason', 'own_request',
                         'message', 'You cannot decide a rent request you registered or are assigned to')
    WHEN COALESCE(p_row.rent_amount, 0) <= 0 THEN
      jsonb_build_object('reason', 'no_rent_amount', 'message', 'This rent request has no rent amount')
  END
$$;

-- ─── Triggers on rent_requests ───────────────────────────────────────────────────────────────────────────────

-- The COO step may only be taken by the budget-aware functions (they set app.landlord_float_cap_checked).
CREATE OR REPLACE FUNCTION public.landlord_float_guard_coo_step()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF OLD.status = 'partner_ops_approved' AND NEW.status = 'coo_approved'
     AND COALESCE(current_setting('app.landlord_float_cap_checked', true), '') <> 'on' THEN
    RAISE EXCEPTION 'COO approval must go through coo_approve_rent_requests so the landlord float budget is applied'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_landlord_float_guard_coo_step ON public.rent_requests;
CREATE TRIGGER trg_landlord_float_guard_coo_step
  BEFORE UPDATE OF status ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.landlord_float_guard_coo_step();

-- Keeps allocations and miscellaneous asks in step with the request:
--   * moving back before the COO step (or out of the pipeline) releases the live allocation -> amount returns to the budget;
--   * leaving the COO step any way cancels a still-pending miscellaneous ask;
--   * a rent_amount edit re-measures the live allocation and the pending ask.
CREATE OR REPLACE FUNCTION public.landlord_float_sync_rent_request()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status IN ('rejected', 'cancelled', 'deleted_by_agent', 'pending', 'service_center_review', 'agent_verified',
                      'agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved') THEN
      UPDATE public.landlord_float_budget_allocations
         SET released_at        = now(),
             released_reason    = COALESCE(NULLIF(current_setting('app.landlord_float_release_reason', true), ''),
                                           format('Rent request moved from %s to %s', OLD.status, NEW.status)),
             released_to_status = NEW.status
       WHERE rent_request_id = NEW.id AND released_at IS NULL;
    END IF;

    IF OLD.status = 'partner_ops_approved' THEN
      UPDATE public.landlord_float_misc_requests
         SET status     = 'cancelled',
             cfo_note   = COALESCE(cfo_note, format('Closed without a CFO decision: the rent request moved to %s', NEW.status)),
             updated_at = now()
       WHERE rent_request_id = NEW.id AND status = 'pending';
    END IF;
  END IF;

  IF NEW.rent_amount IS DISTINCT FROM OLD.rent_amount THEN
    UPDATE public.landlord_float_budget_allocations
       SET amount = greatest(COALESCE(NEW.rent_amount, 0), 0)
     WHERE rent_request_id = NEW.id AND released_at IS NULL;
    UPDATE public.landlord_float_misc_requests
       SET amount = greatest(COALESCE(NEW.rent_amount, 0), 0), updated_at = now()
     WHERE rent_request_id = NEW.id AND status = 'pending' AND COALESCE(NEW.rent_amount, 0) > 0;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_landlord_float_sync_rent_request ON public.rent_requests;
CREATE TRIGGER trg_landlord_float_sync_rent_request
  AFTER UPDATE OF status, rent_amount ON public.rent_requests
  FOR EACH ROW EXECUTE FUNCTION public.landlord_float_sync_rent_request();

-- ─── CFO: set a budget ───────────────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.cfo_set_landlord_float_budget(
  p_period_type  text,
  p_amount       numeric,
  p_reason       text DEFAULT NULL,
  p_period_start date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_today     date := public.landlord_float_budget_today();
  v_type      text := lower(btrim(COALESCE(p_period_type, '')));
  v_reason    text := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_start     date;
  v_current   date;
  v_old      public.landlord_float_budgets%ROWTYPE;
  v_new_id    uuid;
  v_weekly    numeric;
  v_over      boolean := false;
  v_used      numeric;
  v_excess    numeric;
  v_label     text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the designated CFO can set the landlord float budget' USING ERRCODE = '42501';
  END IF;
  IF v_type NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'Budget period must be daily or weekly' USING ERRCODE = 'check_violation';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount >= 1e12 THEN
    RAISE EXCEPTION 'Enter a budget amount above zero' USING ERRCODE = 'check_violation';
  END IF;

  v_start := COALESCE(p_period_start,
                      CASE WHEN v_type = 'daily' THEN v_today ELSE public.landlord_float_week_start(v_today) END);
  IF v_type = 'weekly' AND v_start <> public.landlord_float_week_start(v_start) THEN
    RAISE EXCEPTION 'A weekly budget starts on a Monday' USING ERRCODE = 'check_violation';
  END IF;
  -- (No CASE inside an IF condition: PL/pgSQL ends the condition at the first THEN.)
  v_current := CASE WHEN v_type = 'daily' THEN v_today ELSE public.landlord_float_week_start(v_today) END;
  IF v_start < v_current THEN
    RAISE EXCEPTION 'A budget cannot be set for a period that has already ended' USING ERRCODE = 'check_violation';
  END IF;

  -- Serialises against COO approvals, which lock the same live row.
  SELECT * INTO v_old FROM public.landlord_float_budgets
   WHERE period_type = v_type AND period_start = v_start AND superseded_at IS NULL
   FOR UPDATE;

  IF v_type = 'daily' THEN
    SELECT amount INTO v_weekly FROM public.landlord_float_budgets
     WHERE period_type = 'weekly' AND period_start = public.landlord_float_week_start(v_start) AND superseded_at IS NULL;
    v_over := v_weekly IS NOT NULL AND p_amount > v_weekly;
  ELSE
    v_over := EXISTS (
      SELECT 1 FROM public.landlord_float_budgets
       WHERE period_type = 'daily' AND superseded_at IS NULL
         AND period_start BETWEEN v_start AND v_start + 6
         AND amount > p_amount);
  END IF;

  IF v_over AND length(COALESCE(v_reason, '')) < 10 THEN
    RAISE EXCEPTION 'OVER_WEEKLY_REASON_REQUIRED: the daily budget is above the weekly budget. Give a reason of at least 10 characters to save it.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_old.id IS NOT NULL THEN
    UPDATE public.landlord_float_budgets SET superseded_at = now() WHERE id = v_old.id;
  END IF;

  INSERT INTO public.landlord_float_budgets
    (period_type, period_start, period_end, amount, reason, over_weekly_warning, set_by)
  VALUES
    (v_type, v_start, CASE WHEN v_type = 'daily' THEN v_start ELSE v_start + 6 END, p_amount, v_reason, v_over, v_uid)
  RETURNING id INTO v_new_id;

  IF v_old.id IS NOT NULL THEN
    UPDATE public.landlord_float_budgets SET superseded_by = v_new_id WHERE id = v_old.id;
  END IF;

  INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
  VALUES ('landlord_float_budget_set', 'landlord_float_budgets', v_new_id::text, v_uid,
          jsonb_build_object('period_type', v_type, 'period_start', v_start, 'amount', p_amount,
                             'previous_amount', v_old.amount, 'previous_budget_id', v_old.id,
                             'reason', v_reason, 'over_weekly_warning', v_over));

  -- What is already approved against the period, within the cap.
  SELECT COALESCE(sum(amount), 0) INTO v_used
    FROM public.landlord_float_budget_allocations
   WHERE released_at IS NULL AND kind = 'within_cap'
     AND CASE WHEN v_type = 'daily' THEN budget_date = v_start ELSE week_start = v_start END;
  v_excess := greatest(v_used - p_amount, 0);

  v_label := CASE WHEN v_type = 'daily' THEN format('daily landlord float budget for %s', to_char(v_start, 'DD Mon YYYY'))
                  ELSE format('weekly landlord float budget for the week of %s', to_char(v_start, 'DD Mon YYYY')) END;

  PERFORM public._landlord_float_notify(
    ARRAY['coo'],
    'Landlord float budget set',
    format('The CFO set the %s to %s.', v_label, public._landlord_float_ugx(p_amount)),
    jsonb_build_object('kind', 'landlord_float_budget_set', 'budget_id', v_new_id, 'period_type', v_type,
                       'period_start', v_start, 'amount', p_amount),
    'landlord_float_budget_set:' || v_new_id, '/coo/dashboard');

  IF v_excess > 0 THEN
    PERFORM public._landlord_float_notify(
      ARRAY['coo', 'cfo'],
      'Landlord float budget exceeded',
      format('The %s is now %s, but %s is already approved against it: over budget by %s.',
             v_label, public._landlord_float_ugx(p_amount), public._landlord_float_ugx(v_used),
             public._landlord_float_ugx(v_excess)),
      jsonb_build_object('kind', 'landlord_float_budget_exceeded', 'budget_id', v_new_id, 'period_type', v_type,
                         'period_start', v_start, 'amount', p_amount, 'used', v_used, 'excess', v_excess),
      'landlord_float_budget_exceeded:' || v_new_id);
  END IF;

  RETURN jsonb_build_object(
    'budget_id', v_new_id,
    'over_weekly_warning', v_over,
    'excess', v_excess,
    'status', public._landlord_float_position(CASE WHEN v_type = 'daily' THEN v_start ELSE greatest(v_start, v_today) END)
  );
END;
$$;

-- ─── COO: approve against the budget ─────────────────────────────────────────────────────────────────────────

-- Approves the given requests in the order given, while they fit the room left. One call for one or many requests.
-- Requests that do not fit are returned in over_cap and stay at the COO step; other problems are returned in skipped.
CREATE OR REPLACE FUNCTION public.coo_approve_rent_requests(p_request_ids uuid[], p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_comment   text := NULLIF(btrim(COALESCE(p_comment, '')), '');
  v_day       date := public.landlord_float_budget_today();
  v_ws        date := public.landlord_float_week_start(v_day);
  v_d_id      uuid;
  v_w_id      uuid;
  v_room      numeric;
  v_id        uuid;
  v_row       public.rent_requests%ROWTYPE;
  v_problem   jsonb;
  v_approved  jsonb := '[]'::jsonb;
  v_over      jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
  v_total     numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_role(v_uid, 'coo'::public.app_role) THEN
    RAISE EXCEPTION 'Only the COO can approve a rent request at the COO step' USING ERRCODE = '42501';
  END IF;
  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RAISE EXCEPTION 'No rent requests given' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(p_request_ids) > 500 THEN
    RAISE EXCEPTION 'Approve at most 500 rent requests at a time' USING ERRCODE = 'check_violation';
  END IF;

  -- Lock today's live budgets: concurrent approvals and budget changes queue behind this, so the room cannot be
  -- spent twice.
  SELECT id INTO v_d_id FROM public.landlord_float_budgets
   WHERE period_type = 'daily' AND period_start = v_day AND superseded_at IS NULL FOR UPDATE;
  SELECT id INTO v_w_id FROM public.landlord_float_budgets
   WHERE period_type = 'weekly' AND period_start = v_ws AND superseded_at IS NULL FOR UPDATE;

  IF v_d_id IS NULL THEN
    RAISE EXCEPTION 'NO_BUDGET: the CFO has not set today''s landlord float budget. COO approvals are paused until it is set.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_w_id IS NULL THEN
    RAISE EXCEPTION 'NO_BUDGET: the CFO has not set this week''s landlord float budget. COO approvals are paused until it is set.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_room := (public._landlord_float_position(v_day) ->> 'room')::numeric;

  FOR v_id IN
    SELECT u.id FROM unnest(p_request_ids) WITH ORDINALITY AS u(id, ord)
     WHERE u.id IS NOT NULL GROUP BY u.id ORDER BY min(u.ord)
  LOOP
    BEGIN
      v_row := NULL;
      SELECT * INTO v_row FROM public.rent_requests WHERE id = v_id FOR UPDATE;
      v_problem := public._landlord_float_coo_step_problem(v_row, v_uid);
      IF v_problem IS NOT NULL THEN
        v_skipped := v_skipped || (jsonb_build_object('id', v_id) || v_problem);
        CONTINUE;
      END IF;

      IF v_row.rent_amount > v_room THEN
        v_over := v_over || jsonb_build_object(
          'id', v_id, 'rent_amount', v_row.rent_amount, 'room', v_room,
          'misc_pending', EXISTS (SELECT 1 FROM public.landlord_float_misc_requests m
                                   WHERE m.rent_request_id = v_id AND m.status = 'pending'));
        CONTINUE;
      END IF;

      PERFORM set_config('app.landlord_float_cap_checked', 'on', true);
      UPDATE public.rent_requests
         SET status = 'coo_approved',
             coo_reviewed_by = v_uid,
             coo_reviewed_at = now(),
             approval_comment = v_comment,
             updated_at = now()
       WHERE id = v_id;
      PERFORM set_config('app.landlord_float_cap_checked', 'off', true);

      INSERT INTO public.landlord_float_budget_allocations
        (rent_request_id, kind, amount, budget_date, week_start, daily_budget_id, weekly_budget_id, approved_by)
      VALUES (v_id, 'within_cap', v_row.rent_amount, v_day, v_ws, v_d_id, v_w_id, v_uid);

      INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
      VALUES ('coo_approved_rent_request', 'rent_requests', v_id::text, v_uid,
              jsonb_build_object('previous_status', v_row.status, 'new_status', 'coo_approved', 'comment', v_comment,
                                 'rent_amount', v_row.rent_amount, 'tenant_id', v_row.tenant_id,
                                 'landlord_float_budget', jsonb_build_object(
                                   'kind', 'within_cap', 'budget_date', v_day, 'daily_budget_id', v_d_id,
                                   'weekly_budget_id', v_w_id, 'room_before', v_room)));

      v_room  := v_room - v_row.rent_amount;
      v_total := v_total + v_row.rent_amount;
      v_approved := v_approved || jsonb_build_object('id', v_id, 'rent_amount', v_row.rent_amount);
    EXCEPTION WHEN OTHERS THEN
      -- One bad row (e.g. a pipeline trigger refusing it) must not abandon the rest of the batch.
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'error', 'message', SQLERRM);
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'approved', v_approved,
    'over_cap', v_over,
    'skipped', v_skipped,
    'approved_total', v_total,
    'room_left', v_room,
    'status', public._landlord_float_position(v_day)
  );
END;
$$;

-- The single-request form keeps its signature and error behaviour, and now applies the budget through the batch form.
CREATE OR REPLACE FUNCTION public.coo_approve_rent_request(p_request_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_res  jsonb := public.coo_approve_rent_requests(ARRAY[p_request_id], p_comment);
  v_over jsonb := v_res -> 'over_cap' -> 0;
  v_skip jsonb := v_res -> 'skipped' -> 0;
BEGIN
  IF jsonb_array_length(v_res -> 'approved') = 1 THEN
    RETURN jsonb_build_object('id', p_request_id, 'status', 'coo_approved', 'budget', v_res -> 'status');
  END IF;
  IF v_over IS NOT NULL THEN
    RAISE EXCEPTION 'OVER_BUDGET: % does not fit in the landlord float budget left today (%). Ask the CFO for a miscellaneous approval with a reason.',
      public._landlord_float_ugx((v_over ->> 'rent_amount')::numeric), public._landlord_float_ugx((v_over ->> 'room')::numeric)
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION '%', COALESCE(v_skip ->> 'message', 'The rent request could not be approved') USING ERRCODE = 'check_violation';
END;
$$;

-- ─── COO: ask for a miscellaneous approval above the budget ──────────────────────────────────────────────────

-- p_items: [{"rent_request_id": "...", "reason": "..."}], one reason per request.
CREATE OR REPLACE FUNCTION public.coo_request_landlord_float_misc(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid        uuid := auth.uid();
  v_day        date := public.landlord_float_budget_today();
  v_pos        jsonb;
  v_room       numeric;
  v_item       jsonb;
  v_id         uuid;
  v_reason     text;
  v_row        public.rent_requests%ROWTYPE;
  v_problem    jsonb;
  v_misc_id    uuid;
  v_requested  jsonb := '[]'::jsonb;
  v_skipped    jsonb := '[]'::jsonb;
  v_total      numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.has_role(v_uid, 'coo'::public.app_role) THEN
    RAISE EXCEPTION 'Only the COO can ask for a miscellaneous landlord float approval' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'No rent requests given' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'Ask for at most 200 miscellaneous approvals at a time' USING ERRCODE = 'check_violation';
  END IF;

  v_pos := public._landlord_float_position(v_day);
  IF (v_pos ->> 'blocked')::boolean THEN
    RAISE EXCEPTION 'NO_BUDGET: the CFO has not set today''s and this week''s landlord float budget yet.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_room := (v_pos ->> 'room')::numeric;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
    BEGIN
      v_id := NULLIF(v_item ->> 'rent_request_id', '')::uuid;
      v_reason := btrim(COALESCE(v_item ->> 'reason', ''));
      IF length(v_reason) < 10 THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'reason_too_short',
                                                     'message', 'Give a reason of at least 10 characters');
        CONTINUE;
      END IF;

      v_row := NULL;
      SELECT * INTO v_row FROM public.rent_requests WHERE id = v_id FOR UPDATE;
      v_problem := public._landlord_float_coo_step_problem(v_row, v_uid);
      IF v_problem IS NOT NULL THEN
        v_skipped := v_skipped || (jsonb_build_object('id', v_id) || v_problem);
        CONTINUE;
      END IF;
      IF v_row.rent_amount <= v_room THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'fits_budget',
          'message', 'This request fits in the budget left today. Approve it normally.');
        CONTINUE;
      END IF;
      IF EXISTS (SELECT 1 FROM public.landlord_float_misc_requests
                  WHERE rent_request_id = v_id AND status = 'pending') THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'already_requested',
          'message', 'A miscellaneous approval is already waiting for the CFO');
        CONTINUE;
      END IF;

      INSERT INTO public.landlord_float_misc_requests
        (rent_request_id, amount, reason, room_at_request, budget_date, requested_by)
      VALUES (v_id, v_row.rent_amount, v_reason, v_room, v_day, v_uid)
      RETURNING id INTO v_misc_id;

      INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
      VALUES ('landlord_float_misc_requested', 'rent_requests', v_id::text, v_uid,
              jsonb_build_object('misc_request_id', v_misc_id, 'amount', v_row.rent_amount, 'reason', v_reason,
                                 'room_at_request', v_room, 'budget_date', v_day));

      v_total := v_total + v_row.rent_amount;
      v_requested := v_requested || jsonb_build_object('id', v_id, 'misc_request_id', v_misc_id,
                                                       'rent_amount', v_row.rent_amount);
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'error', 'message', SQLERRM);
    END;
  END LOOP;

  IF jsonb_array_length(v_requested) > 0 THEN
    PERFORM public._landlord_float_notify(
      ARRAY['cfo'],
      'Landlord float: miscellaneous approval requested',
      format('The COO asked you to approve %s rent request(s) totalling %s above the landlord float budget. Each one has a reason.',
             jsonb_array_length(v_requested), public._landlord_float_ugx(v_total)),
      jsonb_build_object('kind', 'landlord_float_misc_requested', 'count', jsonb_array_length(v_requested),
                         'total', v_total, 'budget_date', v_day),
      'landlord_float_misc_requested:' || v_day || ':' || v_uid, '/cfo/dashboard');
  END IF;

  RETURN jsonb_build_object('requested', v_requested, 'skipped', v_skipped, 'requested_total', v_total);
END;
$$;

-- ─── CFO: decide miscellaneous asks ──────────────────────────────────────────────────────────────────────────

-- Approve: the request moves to the CFO stage outside the cap (a 'miscellaneous' allocation), credited to the COO who asked.
-- Reject: the request stays at the COO step. A reject needs a note.
CREATE OR REPLACE FUNCTION public.cfo_decide_landlord_float_misc(
  p_misc_ids uuid[], p_decision text, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_decision  text := lower(btrim(COALESCE(p_decision, '')));
  v_note      text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_day       date := public.landlord_float_budget_today();
  v_ws        date := public.landlord_float_week_start(v_day);
  v_d_id      uuid;
  v_w_id      uuid;
  v_id        uuid;
  v_misc      public.landlord_float_misc_requests%ROWTYPE;
  v_row       public.rent_requests%ROWTYPE;
  v_approved  jsonb := '[]'::jsonb;
  v_rejected  jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
  v_decided   uuid[] := '{}';
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the designated CFO can decide miscellaneous landlord float approvals' USING ERRCODE = '42501';
  END IF;
  IF v_decision NOT IN ('approve', 'reject') THEN
    RAISE EXCEPTION 'Decision must be approve or reject' USING ERRCODE = 'check_violation';
  END IF;
  IF v_decision = 'reject' AND length(COALESCE(v_note, '')) < 10 THEN
    RAISE EXCEPTION 'Give a reason of at least 10 characters to reject' USING ERRCODE = 'check_violation';
  END IF;
  IF p_misc_ids IS NULL OR cardinality(p_misc_ids) = 0 THEN
    RAISE EXCEPTION 'No miscellaneous requests given' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(p_misc_ids) > 200 THEN
    RAISE EXCEPTION 'Decide at most 200 at a time' USING ERRCODE = 'check_violation';
  END IF;

  SELECT id INTO v_d_id FROM public.landlord_float_budgets
   WHERE period_type = 'daily' AND period_start = v_day AND superseded_at IS NULL;
  SELECT id INTO v_w_id FROM public.landlord_float_budgets
   WHERE period_type = 'weekly' AND period_start = v_ws AND superseded_at IS NULL;

  FOR v_id IN
    SELECT u.id FROM unnest(p_misc_ids) WITH ORDINALITY AS u(id, ord)
     WHERE u.id IS NOT NULL GROUP BY u.id ORDER BY min(u.ord)
  LOOP
    BEGIN
      v_misc := NULL;
      SELECT * INTO v_misc FROM public.landlord_float_misc_requests WHERE id = v_id FOR UPDATE;
      IF v_misc.id IS NULL OR v_misc.status <> 'pending' THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_pending',
          'message', format('This miscellaneous request is %s, not waiting for a decision', COALESCE(v_misc.status, 'missing')));
        CONTINUE;
      END IF;

      v_row := NULL;
      SELECT * INTO v_row FROM public.rent_requests WHERE id = v_misc.rent_request_id FOR UPDATE;

      IF v_decision = 'reject' THEN
        UPDATE public.landlord_float_misc_requests
           SET status = 'rejected', cfo_decided_by = v_uid, cfo_decided_at = now(), cfo_note = v_note, updated_at = now()
         WHERE id = v_id;
        INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
        VALUES ('landlord_float_misc_rejected', 'rent_requests', v_misc.rent_request_id::text, v_uid,
                jsonb_build_object('misc_request_id', v_id, 'amount', v_misc.amount, 'note', v_note));
        v_rejected := v_rejected || jsonb_build_object('id', v_id, 'rent_request_id', v_misc.rent_request_id);
        v_decided := v_decided || v_id;
        CONTINUE;
      END IF;

      -- Approve: the request must still be waiting at the COO step. The COO-step checks are made for the COO who
      -- asked; the CFO must not be deciding their own request either.
      IF v_row.status IS DISTINCT FROM 'partner_ops_approved' THEN
        UPDATE public.landlord_float_misc_requests
           SET status = 'cancelled', cfo_note = format('Closed: the rent request is at %s', COALESCE(v_row.status, 'missing')),
               updated_at = now()
         WHERE id = v_id;
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'already_moved',
          'message', format('The rent request is at "%s", not waiting for the COO', COALESCE(v_row.status, 'missing')));
        CONTINUE;
      END IF;
      IF v_uid = v_row.agent_id OR v_uid = v_row.assigned_agent_id THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'own_request',
          'message', 'You cannot decide a rent request you registered or are assigned to');
        CONTINUE;
      END IF;

      UPDATE public.landlord_float_misc_requests
         SET status = 'approved', amount = v_row.rent_amount, cfo_decided_by = v_uid, cfo_decided_at = now(),
             cfo_note = v_note, updated_at = now()
       WHERE id = v_id;

      PERFORM set_config('app.landlord_float_cap_checked', 'on', true);
      UPDATE public.rent_requests
         SET status = 'coo_approved',
             coo_reviewed_by = v_misc.requested_by,
             coo_reviewed_at = now(),
             approval_comment = 'Miscellaneous (above the landlord float budget). COO reason: ' || v_misc.reason,
             updated_at = now()
       WHERE id = v_misc.rent_request_id;
      PERFORM set_config('app.landlord_float_cap_checked', 'off', true);

      INSERT INTO public.landlord_float_budget_allocations
        (rent_request_id, kind, amount, budget_date, week_start, daily_budget_id, weekly_budget_id, misc_request_id, approved_by)
      VALUES (v_misc.rent_request_id, 'miscellaneous', v_row.rent_amount, v_day, v_ws, v_d_id, v_w_id, v_id, v_uid);

      INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
      VALUES ('coo_approved_rent_request', 'rent_requests', v_misc.rent_request_id::text, v_uid,
              jsonb_build_object('previous_status', v_row.status, 'new_status', 'coo_approved',
                                 'rent_amount', v_row.rent_amount, 'tenant_id', v_row.tenant_id,
                                 'coo_requested_by', v_misc.requested_by,
                                 'landlord_float_budget', jsonb_build_object(
                                   'kind', 'miscellaneous', 'misc_request_id', v_id, 'reason', v_misc.reason,
                                   'cfo_note', v_note, 'budget_date', v_day)));

      v_approved := v_approved || jsonb_build_object('id', v_id, 'rent_request_id', v_misc.rent_request_id,
                                                     'rent_amount', v_row.rent_amount);
      v_decided := v_decided || v_id;
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'error', 'message', SQLERRM);
    END;
  END LOOP;

  -- Tell each COO who asked how their asks went (one notification per person).
  INSERT INTO public.notifications (user_id, title, message, type, metadata, link_path, event_key)
  SELECT m.requested_by,
         CASE WHEN v_decision = 'approve' THEN 'Landlord float: miscellaneous approved'
              ELSE 'Landlord float: miscellaneous rejected' END,
         format('The CFO %s %s miscellaneous request(s) totalling %s.%s',
                CASE WHEN v_decision = 'approve' THEN 'approved' ELSE 'rejected' END,
                count(*), public._landlord_float_ugx(sum(m.amount)),
                CASE WHEN v_decision = 'approve' THEN ' They have moved to the CFO stage.'
                     ELSE ' They stay at the COO step. CFO note: ' || v_note END),
         'budget',
         jsonb_build_object('kind', 'landlord_float_misc_decided', 'decision', v_decision,
                            'misc_request_ids', to_jsonb(array_agg(m.id))),
         '/coo/dashboard',
         'landlord_float_misc_decided:' || v_decision || ':' || md5(array_to_string(array_agg(m.id ORDER BY m.id), ','))
    FROM public.landlord_float_misc_requests m
   WHERE m.id = ANY (v_decided)
   GROUP BY m.requested_by;

  RETURN jsonb_build_object('approved', v_approved, 'rejected', v_rejected, 'skipped', v_skipped,
                            'status', public._landlord_float_position(v_day));
END;
$$;

-- ─── CFO: return requests to the COO step ────────────────────────────────────────────────────────────────────

-- Replaces "return for correction" at the CFO disbursement step: the request goes back to the COO (status
-- partner_ops_approved), and the sync trigger releases its allocation so the amount returns to the budget.
CREATE OR REPLACE FUNCTION public.cfo_return_rent_requests_to_coo(p_request_ids uuid[], p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid       uuid := auth.uid();
  v_reason    text := btrim(COALESCE(p_reason, ''));
  v_id        uuid;
  v_row       public.rent_requests%ROWTYPE;
  v_returned  jsonb := '[]'::jsonb;
  v_skipped   jsonb := '[]'::jsonb;
  v_total     numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_cfo_approver(v_uid) THEN
    RAISE EXCEPTION 'Only the designated CFO can return rent requests to the COO' USING ERRCODE = '42501';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'The reason must be at least 10 characters' USING ERRCODE = 'check_violation';
  END IF;
  IF p_request_ids IS NULL OR cardinality(p_request_ids) = 0 THEN
    RAISE EXCEPTION 'No rent requests given' USING ERRCODE = 'check_violation';
  END IF;
  IF cardinality(p_request_ids) > 500 THEN
    RAISE EXCEPTION 'Return at most 500 rent requests at a time' USING ERRCODE = 'check_violation';
  END IF;

  PERFORM set_config('app.landlord_float_release_reason', 'Returned to the COO by the CFO: ' || v_reason, true);

  FOR v_id IN
    SELECT u.id FROM unnest(p_request_ids) WITH ORDINALITY AS u(id, ord)
     WHERE u.id IS NOT NULL GROUP BY u.id ORDER BY min(u.ord)
  LOOP
    BEGIN
      v_row := NULL;
      SELECT * INTO v_row FROM public.rent_requests WHERE id = v_id FOR UPDATE;
      IF v_row.id IS NULL OR v_row.status IS DISTINCT FROM 'coo_approved' THEN
        v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'not_at_cfo_step',
          'message', format('This rent request is at "%s", not waiting for the CFO', COALESCE(v_row.status, 'missing')));
        CONTINUE;
      END IF;

      UPDATE public.rent_requests
         SET status = 'partner_ops_approved',
             cfo_reviewed_by = v_uid,
             cfo_reviewed_at = now(),
             approval_comment = 'Returned by the CFO: ' || v_reason,
             updated_at = now()
       WHERE id = v_id;

      INSERT INTO public.audit_logs (action_type, table_name, record_id, user_id, metadata)
      VALUES ('rent_request_returned_to_coo', 'rent_requests', v_id::text, v_uid,
              jsonb_build_object('previous_status', v_row.status, 'new_status', 'partner_ops_approved',
                                 'reason', v_reason, 'rent_amount', v_row.rent_amount));
      INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
      VALUES ('rent_request.returned_to_coo', v_uid, 'rent_request', v_id,
              jsonb_build_object('reason', v_reason, 'rent_amount', v_row.rent_amount));

      v_total := v_total + COALESCE(v_row.rent_amount, 0);
      v_returned := v_returned || jsonb_build_object('id', v_id, 'rent_amount', v_row.rent_amount);
    EXCEPTION WHEN OTHERS THEN
      v_skipped := v_skipped || jsonb_build_object('id', v_id, 'reason', 'error', 'message', SQLERRM);
    END;
  END LOOP;

  PERFORM set_config('app.landlord_float_release_reason', '', true);

  IF jsonb_array_length(v_returned) > 0 THEN
    PERFORM public._landlord_float_notify(
      ARRAY['coo'],
      'Rent requests returned to the COO',
      format('The CFO returned %s rent request(s) totalling %s to the COO step. Their amount is back in the landlord float budget. Reason: %s',
             jsonb_array_length(v_returned), public._landlord_float_ugx(v_total), v_reason),
      jsonb_build_object('kind', 'landlord_float_returned_to_coo', 'count', jsonb_array_length(v_returned),
                         'total', v_total, 'reason', v_reason),
      'landlord_float_returned_to_coo:' || md5(v_returned::text), '/coo/dashboard');
  END IF;

  RETURN jsonb_build_object('returned', v_returned, 'skipped', v_skipped, 'returned_total', v_total,
                            'status', public._landlord_float_position(public.landlord_float_budget_today()));
END;
$$;

-- ─── Reads (COO and CFO) ─────────────────────────────────────────────────────────────────────────────────────

-- Everything the budget bar, the approve buttons and the CFO banner need, in one call.
CREATE OR REPLACE FUNCTION public.get_landlord_float_budget_status(p_day date DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid   uuid := auth.uid();
  v_today date := public.landlord_float_budget_today();
BEGIN
  IF NOT public.landlord_float_budget_can_view(v_uid) THEN
    RAISE EXCEPTION 'Only the COO and CFO can see the landlord float budget' USING ERRCODE = '42501';
  END IF;

  RETURN public._landlord_float_position(COALESCE(p_day, v_today))
    || jsonb_build_object(
         'today',           v_today,
         'can_set_budget',  public.is_cfo_approver(v_uid),
         'can_decide_misc', public.is_cfo_approver(v_uid),
         'can_approve',     public.has_role(v_uid, 'coo'::public.app_role),
         'pending_misc',    COALESCE((
           SELECT jsonb_agg(jsonb_build_object('id', m.id, 'rent_request_id', m.rent_request_id, 'amount', m.amount)
                            ORDER BY m.requested_at)
             FROM public.landlord_float_misc_requests m WHERE m.status = 'pending'), '[]'::jsonb),
         'pending_misc_total', COALESCE((
           SELECT sum(m.amount) FROM public.landlord_float_misc_requests m WHERE m.status = 'pending'), 0)
       );
END;
$$;

-- Budget history (live and superseded rows) with what was approved against each period.
CREATE OR REPLACE FUNCTION public.get_landlord_float_budget_history(
  p_period_type text DEFAULT NULL, p_limit integer DEFAULT 60)
RETURNS TABLE (
  id uuid, period_type text, period_start date, period_end date, amount numeric, reason text,
  over_weekly_warning boolean, set_by uuid, set_by_name text, created_at timestamptz,
  superseded_at timestamptz, superseded_by uuid, is_current boolean,
  used numeric, misc_used numeric, approved_count integer, excess numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT public.landlord_float_budget_can_view(auth.uid()) THEN
    RAISE EXCEPTION 'Only the COO and CFO can see the landlord float budget' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT b.id, b.period_type, b.period_start, b.period_end, b.amount, b.reason, b.over_weekly_warning,
         b.set_by, p.full_name, b.created_at, b.superseded_at, b.superseded_by, b.superseded_at IS NULL,
         a.used, a.misc_used, a.approved_count, greatest(a.used - b.amount, 0)
    FROM public.landlord_float_budgets b
    LEFT JOIN public.profiles p ON p.id = b.set_by
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'within_cap'), 0)    AS used,
             COALESCE(sum(x.amount) FILTER (WHERE x.kind = 'miscellaneous'), 0) AS misc_used,
             count(*)::int                                                      AS approved_count
        FROM public.landlord_float_budget_allocations x
       WHERE x.released_at IS NULL
         AND x.week_start = public.landlord_float_week_start(b.period_start)
         AND (b.period_type = 'weekly' OR x.budget_date = b.period_start)
    ) a
   WHERE p_period_type IS NULL OR b.period_type = p_period_type
   ORDER BY b.period_start DESC, b.created_at DESC
   LIMIT least(greatest(COALESCE(p_limit, 60), 1), 500);
END;
$$;

-- Every approval made against a day or a week (live and released), with the names needed to show it.
CREATE OR REPLACE FUNCTION public.get_landlord_float_budget_allocations(p_period_type text, p_period_start date)
RETURNS TABLE (
  allocation_id uuid, rent_request_id uuid, kind text, amount numeric, budget_date date,
  approved_by uuid, approved_by_name text, approved_at timestamptz,
  released_at timestamptz, released_reason text, released_to_status text,
  request_status text, tenant_name text, landlord_name text, agent_name text, misc_reason text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT public.landlord_float_budget_can_view(auth.uid()) THEN
    RAISE EXCEPTION 'Only the COO and CFO can see the landlord float budget' USING ERRCODE = '42501';
  END IF;
  IF p_period_type NOT IN ('daily', 'weekly') OR p_period_start IS NULL THEN
    RAISE EXCEPTION 'Give a period type (daily or weekly) and its start date' USING ERRCODE = 'check_violation';
  END IF;

  RETURN QUERY
  SELECT x.id, x.rent_request_id, x.kind, x.amount, x.budget_date,
         x.approved_by, ap.full_name, x.approved_at,
         x.released_at, x.released_reason, x.released_to_status,
         r.status, tp.full_name, l.name, ag.full_name, m.reason
    FROM public.landlord_float_budget_allocations x
    JOIN public.rent_requests r ON r.id = x.rent_request_id
    LEFT JOIN public.profiles ap ON ap.id = x.approved_by
    LEFT JOIN public.profiles tp ON tp.id = r.tenant_id
    LEFT JOIN public.profiles ag ON ag.id = COALESCE(r.assigned_agent_id, r.agent_id)
    LEFT JOIN public.landlords l ON l.id = r.landlord_id
    LEFT JOIN public.landlord_float_misc_requests m ON m.id = x.misc_request_id
   WHERE CASE WHEN p_period_type = 'daily' THEN x.budget_date = p_period_start
              ELSE x.week_start = public.landlord_float_week_start(p_period_start) END
   ORDER BY x.approved_at DESC;
END;
$$;

-- Miscellaneous asks with the request details the CFO needs to decide, in one call.
CREATE OR REPLACE FUNCTION public.get_landlord_float_misc_queue(p_status text DEFAULT 'pending', p_limit integer DEFAULT 200)
RETURNS TABLE (
  id uuid, rent_request_id uuid, amount numeric, reason text, room_at_request numeric, budget_date date,
  status text, requested_by uuid, requested_by_name text, requested_at timestamptz,
  cfo_decided_by uuid, cfo_decided_by_name text, cfo_decided_at timestamptz, cfo_note text,
  request_status text, tenant_name text, landlord_name text, agent_name text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF NOT public.landlord_float_budget_can_view(auth.uid()) THEN
    RAISE EXCEPTION 'Only the COO and CFO can see the landlord float budget' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.id, m.rent_request_id, m.amount, m.reason, m.room_at_request, m.budget_date,
         m.status, m.requested_by, rq.full_name, m.requested_at,
         m.cfo_decided_by, dc.full_name, m.cfo_decided_at, m.cfo_note,
         r.status, tp.full_name, l.name, ag.full_name
    FROM public.landlord_float_misc_requests m
    JOIN public.rent_requests r ON r.id = m.rent_request_id
    LEFT JOIN public.profiles rq ON rq.id = m.requested_by
    LEFT JOIN public.profiles dc ON dc.id = m.cfo_decided_by
    LEFT JOIN public.profiles tp ON tp.id = r.tenant_id
    LEFT JOIN public.profiles ag ON ag.id = COALESCE(r.assigned_agent_id, r.agent_id)
    LEFT JOIN public.landlords l ON l.id = r.landlord_id
   WHERE p_status IS NULL OR m.status = p_status
   ORDER BY m.requested_at DESC
   LIMIT least(greatest(COALESCE(p_limit, 200), 1), 1000);
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────────────────────────────────────
-- New functions in public default to EXECUTE for anon and authenticated; revoke everywhere, then grant the callable
-- ones to authenticated only. Internal helpers and trigger functions are not callable from the API.

REVOKE ALL ON FUNCTION public.landlord_float_budget_today() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_float_week_start(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._landlord_float_ugx(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._landlord_float_period_json(public.landlord_float_budgets, numeric, numeric, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._landlord_float_position(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._landlord_float_notify(text[], text, text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._landlord_float_coo_step_problem(public.rent_requests, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_float_guard_coo_step() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.landlord_float_sync_rent_request() FROM PUBLIC, anon, authenticated;

-- RLS policies call this as the querying user, so authenticated keeps EXECUTE.
REVOKE ALL ON FUNCTION public.landlord_float_budget_can_view(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.landlord_float_budget_can_view(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.cfo_set_landlord_float_budget(text, numeric, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coo_approve_rent_requests(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coo_approve_rent_request(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.coo_request_landlord_float_misc(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_decide_landlord_float_misc(uuid[], text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cfo_return_rent_requests_to_coo(uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landlord_float_budget_status(date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landlord_float_budget_history(text, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landlord_float_budget_allocations(text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_landlord_float_misc_queue(text, integer) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.cfo_set_landlord_float_budget(text, numeric, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coo_approve_rent_requests(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coo_approve_rent_request(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.coo_request_landlord_float_misc(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_decide_landlord_float_misc(uuid[], text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cfo_return_rent_requests_to_coo(uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_budget_status(date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_budget_history(text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_budget_allocations(text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_landlord_float_misc_queue(text, integer) TO authenticated;
