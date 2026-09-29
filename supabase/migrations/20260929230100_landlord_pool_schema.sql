-- Landlord Float Pool — schema (checklist step 7).
--
-- Design: docs/LANDLORD_POOL_FUNDING_DESIGN.md
-- Needs:  20260929230000_landlord_pool_accounts_and_categories.sql
--
-- Nothing here posts money. The pool stays OFF until
-- treasury_controls.landlord_pool_from is enabled; its value is the cutover
-- timestamp, and only portfolios CREATED at or after it are reserved (no
-- backfill — confirmed 2026-09-29).
--
-- The subledger is the per-portfolio trail behind accounts A21/A22:
--
--   landlord_pool_entries    one row per funded thing: a company-managed
--                            portfolio, a self-support tenant line, or a
--                            self-support house. Balances are generated
--                            from the movement totals.
--   landlord_pool_movements  every reserve / deploy / return / release, one
--                            row per ledger group, so SUM(in_pool) by origin
--                            must tie to A21/A22 to the shilling.
--   landlord_pool_exceptions a reserve an edge function could not post, filed
--                            for replay rather than unwinding money that
--                            already moved (same pattern as
--                            rent_fee_collection_exceptions).
--
-- Only the SECURITY DEFINER pool RPCs write these tables. Authenticated users
-- can SELECT what their role allows and nothing else.

-- ── Cutover switch (off) ──────────────────────────────────────────────────
INSERT INTO public.treasury_controls (control_key, enabled, value)
VALUES ('landlord_pool_from', false, NULL)
ON CONFLICT (control_key) DO NOTHING;

-- ── Origin recorded on the portfolio ──────────────────────────────────────
-- Written by landlord_pool_reserve() at the moment it posts; NULL means the
-- portfolio was never reserved (created before cutover, or not yet funded).
-- It records what was posted — the ledger category remains the truth.
ALTER TABLE public.investor_portfolios
  ADD COLUMN IF NOT EXISTS pool_origin text
  CHECK (pool_origin IS NULL OR pool_origin IN ('self_support','company_managed'));

-- ── Entries ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.landlord_pool_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id      uuid NOT NULL REFERENCES public.investor_portfolios(id),
  partner_id        uuid NOT NULL,
  origin            text NOT NULL CHECK (origin IN ('self_support','company_managed')),
  -- investor_portfolios | partner_self_funding_lines | partner_supported_houses
  source_table      text NOT NULL CHECK (source_table IN
                      ('investor_portfolios','partner_self_funding_lines','partner_supported_houses')),
  source_id         uuid NOT NULL,
  principal         numeric NOT NULL CHECK (principal > 0),
  deployed          numeric NOT NULL DEFAULT 0 CHECK (deployed >= 0),
  returned          numeric NOT NULL DEFAULT 0 CHECK (returned >= 0),
  released          numeric NOT NULL DEFAULT 0 CHECK (released >= 0),
  in_pool           numeric GENERATED ALWAYS AS (principal - deployed + returned - released) STORED,
  out_with_tenants  numeric GENERATED ALWAYS AS (deployed - returned) STORED,
  reserve_group_id  uuid NOT NULL,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT landlord_pool_entries_source_key UNIQUE (source_table, source_id),
  CONSTRAINT landlord_pool_entries_in_pool_nonneg CHECK (principal - deployed + returned - released >= 0),
  CONSTRAINT landlord_pool_entries_return_le_deploy CHECK (returned <= deployed)
);
CREATE INDEX IF NOT EXISTS landlord_pool_entries_portfolio_idx ON public.landlord_pool_entries (portfolio_id);
CREATE INDEX IF NOT EXISTS landlord_pool_entries_open_origin_idx
  ON public.landlord_pool_entries (origin, created_at) WHERE status = 'open';

REVOKE ALL ON public.landlord_pool_entries FROM PUBLIC, anon;
GRANT SELECT ON public.landlord_pool_entries TO authenticated;
GRANT ALL ON public.landlord_pool_entries TO service_role;
ALTER TABLE public.landlord_pool_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Partners read own pool entries" ON public.landlord_pool_entries
  FOR SELECT TO authenticated USING (partner_id = auth.uid());
CREATE POLICY "Ops and finance read pool entries" ON public.landlord_pool_entries
  FOR SELECT TO authenticated USING (
    public.is_partner_ops(auth.uid())
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role));

-- ── Movements ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.landlord_pool_movements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pool_entry_id    uuid NOT NULL REFERENCES public.landlord_pool_entries(id),
  kind             text NOT NULL CHECK (kind IN ('reserve','deploy','return','release','reversal')),
  amount           numeric NOT NULL CHECK (amount > 0),
  rent_request_id  uuid,
  allocation_id    uuid,
  collection_id    uuid,
  ledger_group_id  uuid NOT NULL,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- One movement per entry per ledger group: create_ledger_transaction hands
  -- back the SAME group on an idempotent retry, and this key stops the retry
  -- from counting the money twice in the subledger.
  CONSTRAINT landlord_pool_movements_group_key UNIQUE (pool_entry_id, ledger_group_id)
);
CREATE INDEX IF NOT EXISTS landlord_pool_movements_entry_idx ON public.landlord_pool_movements (pool_entry_id);
CREATE INDEX IF NOT EXISTS landlord_pool_movements_rent_request_idx
  ON public.landlord_pool_movements (rent_request_id) WHERE rent_request_id IS NOT NULL;

REVOKE ALL ON public.landlord_pool_movements FROM PUBLIC, anon;
GRANT SELECT ON public.landlord_pool_movements TO authenticated;
GRANT ALL ON public.landlord_pool_movements TO service_role;
ALTER TABLE public.landlord_pool_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Partners read own pool movements" ON public.landlord_pool_movements
  FOR SELECT TO authenticated USING (EXISTS (
    SELECT 1 FROM public.landlord_pool_entries e
     WHERE e.id = pool_entry_id AND e.partner_id = auth.uid()));
CREATE POLICY "Ops and finance read pool movements" ON public.landlord_pool_movements
  FOR SELECT TO authenticated USING (
    public.is_partner_ops(auth.uid())
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'coo'::app_role)
    OR public.has_role(auth.uid(), 'manager'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role));

-- ── Exceptions (replay queue) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.landlord_pool_exceptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id  uuid REFERENCES public.investor_portfolios(id),
  operation     text NOT NULL CHECK (operation IN ('reserve','deploy','return','release')),
  caller        text NOT NULL,
  reason        text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved_at   timestamptz,
  resolved_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS landlord_pool_exceptions_open_idx
  ON public.landlord_pool_exceptions (created_at) WHERE resolved_at IS NULL;

REVOKE ALL ON public.landlord_pool_exceptions FROM PUBLIC, anon;
GRANT SELECT ON public.landlord_pool_exceptions TO authenticated;
GRANT ALL ON public.landlord_pool_exceptions TO service_role;
ALTER TABLE public.landlord_pool_exceptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Ops and finance read pool exceptions" ON public.landlord_pool_exceptions
  FOR SELECT TO authenticated USING (
    public.is_partner_ops(auth.uid())
    OR public.has_role(auth.uid(), 'cfo'::app_role)
    OR public.has_role(auth.uid(), 'financial_ops'::app_role)
    OR public.has_role(auth.uid(), 'super_admin'::app_role)
    OR public.has_role(auth.uid(), 'cto'::app_role));

-- ── Landlord float allocations remember which pool funded them ───────────
ALTER TABLE public.agent_landlord_float_allocations
  ADD COLUMN IF NOT EXISTS pool_origin text
    CHECK (pool_origin IS NULL OR pool_origin IN ('self_support','company_managed')),
  ADD COLUMN IF NOT EXISTS pool_entry_id uuid REFERENCES public.landlord_pool_entries(id);
CREATE INDEX IF NOT EXISTS agent_landlord_float_allocations_pool_entry_idx
  ON public.agent_landlord_float_allocations (pool_entry_id) WHERE pool_entry_id IS NOT NULL;

-- ── Detection: post-cutover active portfolios that never reached the pool ─
-- Non-blocking by design. Some activation paths (COO "Approve" / "Activate
-- all" buttons, import-partners) flip status without posting any ledger
-- entry, so a blocking trigger would break them — and reserving for them
-- would move cash the books never recorded arriving. This view surfaces them
-- for review instead; a funded row here is a missed caller.
CREATE OR REPLACE VIEW public.v_landlord_pool_unreserved
WITH (security_invoker = true) AS
SELECT ip.id AS portfolio_id, ip.portfolio_code, ip.investor_id, ip.investment_amount,
       ip.status, ip.created_at
  FROM public.investor_portfolios ip
  JOIN public.treasury_controls tc
    ON tc.control_key = 'landlord_pool_from' AND tc.enabled AND tc.value IS NOT NULL
 WHERE ip.created_at >= tc.value::timestamptz
   AND ip.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM public.landlord_pool_entries e WHERE e.portfolio_id = ip.id);

REVOKE ALL ON public.v_landlord_pool_unreserved FROM PUBLIC, anon;
GRANT SELECT ON public.v_landlord_pool_unreserved TO authenticated;
