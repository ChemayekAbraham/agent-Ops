-- =============================================================================
-- Migration: 20261028150000_staff_assistant_prompt2_brain_memory_glossary.sql
-- Purpose:   Zoe Brilliant Assistant Proposal — Prompt 2 ("A stronger, more natural brain"):
--              1. Extend `public.staff_assistant_config` with admin-editable model tiers
--                 (`model_fast`, `model_deep`), chat generation settings (`temperature`,
--                 `max_tokens`), deep multi-step limits (`max_deep_model_rounds = 8`,
--                 `max_deep_tool_calls = 12`), and per-question cost ceiling
--                 (`max_cost_usd_per_question`). No secrets stored.
--              2. Add `rolling_summary` to `public.staff_assistant_conversations` so
--                 long conversations preserve earlier context without losing memory.
--              3. Create `public.staff_assistant_notes` ("Zoe notes", up to 20 short
--                 preferences per person, user-visible and deletable, never containing
--                 business figures or personal data about others), with explicit grants,
--                 RLS, and `mfa_required_for_staff` restrictive policy.
--              4. Create `public.staff_assistant_glossary` storing Welile terms and
--                 known measurement gotchas (expected vs collected, treasury cash,
--                 active Rent Plan & repayment clock, agent vs sub-agent, wallet
--                 buckets, regulatory wording, calling deduplication), with explicit
--                 grants, RLS, `mfa_required_for_staff` policy, and seeded entries.
--              5. Create read-only Zoe tool RPC `public.assistant_staff_get_glossary`
--                 (`STABLE SECURITY DEFINER SET search_path = public`, role-checked)
--                 and manager screen RPCs (`public.zoe_glossary_can_manage`,
--                 `public.zoe_glossary_upsert_entry`) so managers can edit the glossary
--                 through a screen (never through Zoe).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Extend `public.staff_assistant_config` with model tiers & deep loop limits
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_config
  ADD COLUMN IF NOT EXISTS model_fast text NOT NULL DEFAULT 'google/gemini-2.5-flash'
    CONSTRAINT staff_assistant_config_model_fast_chk
    CHECK (char_length(btrim(model_fast)) BETWEEN 3 AND 120),
  ADD COLUMN IF NOT EXISTS model_deep text NOT NULL DEFAULT 'google/gemini-2.5-pro'
    CONSTRAINT staff_assistant_config_model_deep_chk
    CHECK (char_length(btrim(model_deep)) BETWEEN 3 AND 120),
  ADD COLUMN IF NOT EXISTS temperature numeric(4,2) NOT NULL DEFAULT 0.20
    CONSTRAINT staff_assistant_config_temperature_chk
    CHECK (temperature >= 0.00 AND temperature <= 1.00),
  ADD COLUMN IF NOT EXISTS max_tokens integer NOT NULL DEFAULT 3200
    CONSTRAINT staff_assistant_config_max_tokens_chk
    CHECK (max_tokens BETWEEN 256 AND 8192),
  ADD COLUMN IF NOT EXISTS max_deep_model_rounds integer NOT NULL DEFAULT 8
    CONSTRAINT staff_assistant_config_max_deep_rounds_chk
    CHECK (max_deep_model_rounds BETWEEN 1 AND 12),
  ADD COLUMN IF NOT EXISTS max_deep_tool_calls integer NOT NULL DEFAULT 12
    CONSTRAINT staff_assistant_config_max_deep_tools_chk
    CHECK (max_deep_tool_calls BETWEEN 1 AND 20),
  ADD COLUMN IF NOT EXISTS max_cost_usd_per_question numeric(8,4) NOT NULL DEFAULT 0.0800
    CONSTRAINT staff_assistant_config_max_cost_chk
    CHECK (max_cost_usd_per_question > 0.0000 AND max_cost_usd_per_question <= 1.0000);

UPDATE public.staff_assistant_config
   SET model_fast                = COALESCE(NULLIF(btrim(model_fast), ''), 'google/gemini-2.5-flash'),
       model_deep                = COALESCE(NULLIF(btrim(model_deep), ''), 'google/gemini-2.5-pro'),
       temperature               = COALESCE(temperature, 0.20),
       max_tokens                = GREATEST(COALESCE(max_tokens, 3200), 1024),
       max_deep_model_rounds     = COALESCE(max_deep_model_rounds, 8),
       max_deep_tool_calls       = COALESCE(max_deep_tool_calls, 12),
       max_cost_usd_per_question = COALESCE(max_cost_usd_per_question, 0.0800),
       updated_at                = now()
 WHERE id = 1;

-- -----------------------------------------------------------------------------
-- 2. Add `rolling_summary` to `public.staff_assistant_conversations`
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_conversations
  ADD COLUMN IF NOT EXISTS rolling_summary text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.staff_assistant_conversations.rolling_summary IS
  'Condensed summary of earlier turns in long conversations so Zoe retains context across the whole conversation.';

-- -----------------------------------------------------------------------------
-- 3. Create `public.staff_assistant_notes` ("Zoe notes", up to 20 per person)
--    Locked down: `authenticated` has SELECT only; writes go through `store.ts`
--    with a deterministic guard blocking business figures and personal data.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  note_text   text NOT NULL
              CONSTRAINT staff_assistant_notes_text_chk
              CHECK (char_length(btrim(note_text)) BETWEEN 2 AND 240),
  is_deleted  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_notes IS
  'Per-person Zoe notes (up to 20 short work/format preferences, user-visible and deletable). Never stores business figures or personal data about others.';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_notes_user_active
  ON public.staff_assistant_notes (user_id, is_deleted, created_at DESC);

ALTER TABLE public.staff_assistant_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_notes;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_notes
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS "Users read own staff_assistant_notes" ON public.staff_assistant_notes;
CREATE POLICY "Users read own staff_assistant_notes"
  ON public.staff_assistant_notes
  FOR SELECT TO authenticated
  USING (
    (SELECT auth.uid()) = user_id
    AND is_deleted = false
  );

REVOKE ALL ON TABLE public.staff_assistant_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_notes TO authenticated;
GRANT ALL    ON TABLE public.staff_assistant_notes TO service_role;

-- -----------------------------------------------------------------------------
-- 4. Create `public.staff_assistant_glossary` (Welile terms & measurement gotchas)
--    Locked down: `authenticated` has SELECT only; manager edits go through
--    `public.zoe_glossary_upsert_entry` on the manager screen, never through Zoe.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_glossary (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE
                     CONSTRAINT staff_assistant_glossary_slug_chk
                     CHECK (slug ~ '^[a-z0-9_]{3,80}$'),
  term               text NOT NULL
                     CONSTRAINT staff_assistant_glossary_term_chk
                     CHECK (char_length(btrim(term)) BETWEEN 2 AND 160),
  category           text NOT NULL DEFAULT 'general'
                     CONSTRAINT staff_assistant_glossary_category_chk
                     CHECK (category IN (
                       'collections',
                       'treasury_ledger',
                       'rent_plans',
                       'agents',
                       'landlords',
                       'supporters',
                       'calling_center',
                       'terminology',
                       'general'
                     )),
  plain_definition   text NOT NULL
                     CONSTRAINT staff_assistant_glossary_def_chk
                     CHECK (char_length(btrim(plain_definition)) BETWEEN 10 AND 2000),
  measurement_gotcha text NOT NULL DEFAULT ''
                     CONSTRAINT staff_assistant_glossary_gotcha_chk
                     CHECK (char_length(measurement_gotcha) <= 2000),
  official_source    text NOT NULL DEFAULT ''
                     CONSTRAINT staff_assistant_glossary_source_chk
                     CHECK (char_length(official_source) <= 300),
  screen_path        text NOT NULL DEFAULT '/me'
                     CONSTRAINT staff_assistant_glossary_screen_chk
                     CHECK (screen_path ~ '^/[a-zA-Z0-9/_?=-]*$'),
  keywords           text[] NOT NULL DEFAULT ARRAY[]::text[],
  is_active          boolean NOT NULL DEFAULT true,
  updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.staff_assistant_glossary IS
  'Authoritative Welile glossary and measurement gotchas read by Zoe via assistant_staff_get_glossary and edited only by managers on screen.';

CREATE INDEX IF NOT EXISTS idx_staff_assistant_glossary_category_active
  ON public.staff_assistant_glossary (category, is_active, term);

ALTER TABLE public.staff_assistant_glossary ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_glossary;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_glossary
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS "Staff read active staff_assistant_glossary" ON public.staff_assistant_glossary;
CREATE POLICY "Staff read active staff_assistant_glossary"
  ON public.staff_assistant_glossary
  FOR SELECT TO authenticated
  USING (
    (SELECT public.staff_assistant_has_access())
    AND is_active = true
  );

REVOKE ALL ON TABLE public.staff_assistant_glossary FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_glossary TO authenticated;
GRANT ALL    ON TABLE public.staff_assistant_glossary TO service_role;

-- Seed authoritative Welile terms and measurement gotchas from SYSTEM_CONTEXT.md,
-- .claude/skills/welile-expected-vs-collected/SKILL.md, .claude/skills/welile-chart-of-accounts/SKILL.md,
-- and the staff manuals:
INSERT INTO public.staff_assistant_glossary (
  slug, term, category, plain_definition, measurement_gotcha, official_source, screen_path, keywords
)
VALUES
  (
    'expected_vs_collected_rent',
    'Expected vs Collected Rent (Daily Bill vs Receipt Book)',
    'collections',
    'Expected rent is the daily repayment bill pinned at 00:05 EAT in agent_expected_day_plans for active Rent Plans on their repayment clock. Collected rent is the cash receipts recorded in agent_collections.',
    'Never divide total cash collected by the expected daily bill without splitting on-schedule vs arrears collections. About half of cash collected on any day comes from plans not on today''s expected list (arrears catch-up, pre-payments, or uncovered plans), which overstates daily bill coverage by roughly 2x. Always report collected_on_schedule (uncapped and capped at expected_amount) separately from collected_arrears.',
    'tops_daily_ops_metrics_amclock / aops_collection_Window_totals',
    '/tenant-ops',
    ARRAY['expected', 'collected', 'coverage', 'daily bill', 'arrears', 'capped', 'uncapped', 'agent_expected_day_plans', 'agent_collections']
  ),
  (
    'treasury_cash_position_vs_agent_float',
    'Treasury Cash Position (A1 + A5) vs Agent Float (A2)',
    'treasury_ledger',
    'Treasury Cash Position is the liquid company cash held in Bank & MTN MoMo (A1) plus Treasury Controls & Reserves (A5), computed by get_treasury_cash_position() from sofp_ledger_legs.',
    'Agent Float (A2, including Landlord Float held by agents before landlord delivery) is NOT part of liquid Treasury Cash (A1 + A5). Never sum wallet balances or raw general_ledger rows without sofp_ledger_legs, because general_ledger uses three scopes (wallet, platform, bridge) and direction depends on ledger_account_map.debit_when.',
    'get_treasury_cash_position / get_balance_sheet_equation',
    '/cfo/dashboard',
    ARRAY['treasury', 'cash', 'a1', 'a2', 'a5', 'float', 'sofp_ledger_legs', 'balance sheet']
  ),
  (
    'active_rent_plan_and_repayment_clock',
    'Active Rent Plan & Repayment Clock (am_plan_clock)',
    'rent_plans',
    'A Rent Plan enters the repayment clock (am_plan_clock) the Kampala day AFTER landlord payout (disbursed_at) or approval. Plans in statuses funded, disbursed, repaying, or default with positive outstanding balance are active.',
    'A Rent Plan funded today starts its Day-1 expected repayment tomorrow. Legacy tenant_paying_no_landlord plans have no landlord payout record and sit outside the standard expected-day snapshot unless explicitly included in uncovered plan buckets.',
    'am_plan_clock / tops_Overview_metrics_amclock',
    '/tenant-ops',
    ARRAY['active', 'rent plan', 'repayment clock', 'am_plan_clock', 'first 7 days', 'funded', 'repaying']
  ),
  (
    'agent_vs_sub_agent_attribution',
    'Agent vs Sub-Agent Attribution & 20% Eligibility Gate',
    'agents',
    'Each Rent Plan has an originating/linked agent (rent_requests.agent_id) and an assigned collecting agent (assigned_agent_id). Daily collection eligibility (v_agent_daily_eligibility) checks whether the agent collected at least 20% of their pinned daily bill today or yesterday.',
    'When a Rent Plan has no assigned_agent_id, collections fall into the Unassigned Agent bucket. Qualifying agents in daily ops metrics are those with at least one plan on today''s expected list; linked agents include all agents with any active plan.',
    'v_agent_daily_eligibility / aops_network_overview_v1',
    '/executive-hub?tab=agent-ops',
    ARRAY['agent', 'sub-agent', 'eligibility', '20%', 'unassigned', 'assigned_agent_id', 'commission']
  ),
  (
    'wallet_buckets_and_ledger_scopes',
    'Wallet Buckets (Withdrawable, Float, Advance, Locked) & Three Ledger Scopes',
    'treasury_ledger',
    'Staff and agent wallets separate money into distinct buckets: withdrawable Returns/commissions, operational float (for landlord payouts or field operations), shopping/salary advance, and locked balances.',
    'Wallet totals must be read from wallet_balances_projection (or user_wallet_strict_for for a single user), never v_user_wallet_strict across all users. Support capacity and operational debits use operational float only and never drain withdrawable Returns.',
    'wallet_balances_projection / sofp_ledger_legs',
    '/cfo/dashboard',
    ARRAY['wallet', 'withdrawable', 'float', 'advance', 'locked', 'bucket', 'scope']
  ),
  (
    'regulatory_terminology_rules',
    'Mandatory Welile Regulatory Terminology (Rent Plan, Supporter, Returns)',
    'terminology',
    'Welile facilitates tenant Rent Plans backed by Supporters who earn Returns, with Welile charging a platform Access Fee and Registration Fee.',
    'Never use "loan" (always say "Rent Plan"), never use "lender" (always say "Supporter"), and never use "ROI" or "interest" (always say "Returns" or "Access Fee"). Four-part repayment validation reconciles Returns + Agent Commission + Platform Fee to Access Fee + Registration Fee.',
    'SYSTEM_CONTEXT.md',
    '/me',
    ARRAY['rent plan', 'supporter', 'returns', 'access fee', 'terminology', 'loan', 'lender', 'roi', 'interest']
  ),
  (
    'landlord_payout_and_verification_gotchas',
    'Landlord Payout Verification, Number Lock & Float Send-Backs',
    'landlords',
    'Landlord Ops verifies landlords and LC1 chairpersons before payout. Landlord payout phone numbers lock at the COO/CFO stage (lock_landlord_number_at_cfo_stage) so disbursements always use the approved number.',
    'The landlord verification bonus fires only on the first Landlord Ops review transition. Landlord Principal Comparison compares cumulative non-cancelled float allocations against non-reversed principal and excludes collected fees.',
    'landlord_principal_comparison_totals / tops_landlord_coverage_metrics',
    '/landlord-ops',
    ARRAY['landlord', 'payout', 'verification', 'lc1', 'float send-back', 'principal']
  ),
  (
    'calling_center_weeks_and_deduplication',
    'Calling Center Kampala Weeks (Wed–Tue) & 15-Minute Deduplication',
    'calling_center',
    'My Space Calling & Pipeline Feedback reports union Tenant Calling Center, Landlord Calling Center, and Rent Plan pipeline calls across Wednesday-to-Tuesday Kampala weeks and calendar months.',
    'Repeat call attempts to the same person within 15 minutes are deduplicated in staff_calling_detailed_report so rapid redials do not inflate call counts. Officer views (Winnie, Hanisha) show only their own rows; team leads and HR (Jane, Mark Bwayo) see the full team.',
    'staff_calling_detailed_report / cc_weekly_all_calls_report',
    '/me/staff-reports',
    ARRAY['calling center', 'deduplication', 'wednesday', 'tuesday', 'kampala week', 'calls']
  ),
  (
    'receivables_vs_payables_recognition',
    'Company Receivables vs Payables & Agent Lending Exclusion',
    'treasury_ledger',
    'Company Receivables track amounts owed on company-backed Rent Plans and eligible merchandise plans (merchandise_plan_recovery_eligible). Payables mirror Receivables read-only for Supporter obligations.',
    'Agent lending uses agents'' own funds and is excluded from company Receivables. Behavioural runoff forecasts exclude new business and never invent unsupported location figures.',
    'get_cfo_receivables_ageing / get_payables_forecast_breakdown',
    '/cfo/dashboard',
    ARRAY['receivables', 'payables', 'agent lending', 'merchandise', 'forecast']
  ),
  (
    'staff_requisitions_and_budget_supplements',
    'Staff Requisitions Approval Chain & Supplementary Budgets',
    'treasury_ledger',
    'Standard staff requisitions follow COO -> CEO -> CFO approval (except active Product R&D budget head which routes CEO -> CFO via staff_requisition_ceo_direct).',
    'Supplementary budgets live only in budget_supplements (revised = original + CFO-approved supplements via budget_revised_position). Supplements never edit the original approved budget line and never touch disbursements, ledger, or wallets.',
    'finops_requisition_disbursement_report / budget_revised_position',
    '/me/requisitions',
    ARRAY['requisition', 'budget', 'supplement', 'coo', 'ceo', 'cfo', 'disbursement']
  )
ON CONFLICT (slug) DO UPDATE
  SET term               = EXCLUDED.term,
      category           = EXCLUDED.category,
      plain_definition   = EXCLUDED.plain_definition,
      measurement_gotcha = EXCLUDED.measurement_gotcha,
      official_source    = EXCLUDED.official_source,
      screen_path        = EXCLUDED.screen_path,
      keywords           = EXCLUDED.keywords,
      updated_at         = now();

-- -----------------------------------------------------------------------------
-- 5. Read-Only Zoe Tool RPC: `public.assistant_staff_get_glossary`
--    Must be `STABLE`, `SECURITY DEFINER`, `SET search_path = public`, zero
--    identity parameters, role-checked, executable only by `authenticated`.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_get_glossary(
  p_search text DEFAULT NULL,
  p_category text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_q text := NULLIF(lower(btrim(COALESCE(p_search, ''))), '');
  v_cat text := NULLIF(lower(btrim(COALESCE(p_category, ''))), '');
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL
     OR NOT public.staff_assistant_has_access()
     OR NOT (
       public.is_welile_staff(v_uid)
       OR public._has_enabled_role(
         v_uid,
         ARRAY[
           'employee', 'operations', 'tenant_ops', 'landlord_ops', 'agent_ops',
           'partner_ops', 'financial_ops', 'hr', 'crm', 'cmo', 'rd',
           'coo', 'cfo', 'ceo', 'cto', 'manager', 'super_admin', 'access_admin'
         ]
       )
     )
  THEN
    RAISE EXCEPTION 'Not authorized for Welile glossary lookup.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug', g.slug,
        'term', g.term,
        'category', g.category,
        'plain_definition', g.plain_definition,
        'measurement_gotcha', g.measurement_gotcha,
        'official_source', g.official_source,
        'screen_path', g.screen_path,
        'keywords', g.keywords,
        'updated_at', g.updated_at
      )
      ORDER BY g.category, g.term
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM public.staff_assistant_glossary g
  WHERE g.is_active = true
    AND (v_cat IS NULL OR g.category = v_cat)
    AND (
      v_q IS NULL
      OR lower(g.term) LIKE '%' || v_q || '%'
      OR lower(g.slug) LIKE '%' || v_q || '%'
      OR lower(g.plain_definition) LIKE '%' || v_q || '%'
      OR lower(g.measurement_gotcha) LIKE '%' || v_q || '%'
      OR EXISTS (
        SELECT 1
          FROM unnest(g.keywords) kw
         WHERE lower(kw) LIKE '%' || v_q || '%'
      )
    );

  RETURN jsonb_build_object(
    'source', 'staff_assistant_glossary',
    'period', jsonb_build_object('as_of', v_today),
    'filter_search', v_q,
    'filter_category', v_cat,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_get_glossary(text, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.assistant_staff_get_glossary(text, text) TO authenticated;

-- -----------------------------------------------------------------------------
-- 6. Manager Screen RPCs for Editing the Welile Glossary (NOT callable by Zoe)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.zoe_glossary_can_manage(
  p_user_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
  SELECT
    public.staff_assistant_has_access()
    AND public._has_enabled_role(
      COALESCE(p_user_id, auth.uid()),
      ARRAY['manager', 'coo', 'cfo', 'ceo', 'cto', 'super_admin']
    );
$function$;

REVOKE ALL ON FUNCTION public.zoe_glossary_can_manage(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zoe_glossary_can_manage(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.zoe_glossary_upsert_entry(
  p_slug text,
  p_term text,
  p_category text,
  p_plain_definition text,
  p_measurement_gotcha text DEFAULT '',
  p_official_source text DEFAULT '',
  p_screen_path text DEFAULT '/me',
  p_keywords text[] DEFAULT ARRAY[]::text[],
  p_is_active boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_slug text := lower(regexp_replace(btrim(COALESCE(p_slug, '')), '[^a-zA-Z0-9_]+', '_', 'g'));
  v_term text := btrim(COALESCE(p_term, ''));
  v_cat text := lower(btrim(COALESCE(p_category, 'general')));
  v_def text := btrim(COALESCE(p_plain_definition, ''));
  v_gotcha text := btrim(COALESCE(p_measurement_gotcha, ''));
  v_source text := btrim(COALESCE(p_official_source, ''));
  v_screen text := COALESCE(NULLIF(btrim(COALESCE(p_screen_path, '')), ''), '/me');
  v_row public.staff_assistant_glossary%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.zoe_glossary_can_manage(v_uid) THEN
    RAISE EXCEPTION 'Only managers and executives can edit the Welile glossary.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.require_staff_aal2();

  IF char_length(v_slug) < 3 OR char_length(v_slug) > 80 THEN
    RAISE EXCEPTION 'Glossary slug must be between 3 and 80 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF char_length(v_term) < 2 OR char_length(v_term) > 160 THEN
    RAISE EXCEPTION 'Glossary term must be between 2 and 160 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF char_length(v_def) < 10 OR char_length(v_def) > 2000 THEN
    RAISE EXCEPTION 'Plain definition must be between 10 and 2,000 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF v_slug <> 'regulatory_terminology_rules'
     AND public.staff_assistant_contains_banned_terms(v_term || ' ' || v_def || ' ' || v_gotcha)
  THEN
    RAISE EXCEPTION 'Glossary entries must use Rent Plan, Supporter, and Returns (never loan, lender, ROI, or interest).'
      USING ERRCODE = '22023';
  END IF;

  IF NOT public.staff_assistant_is_valid_link_path(v_screen) THEN
    v_screen := '/me';
  END IF;

  INSERT INTO public.staff_assistant_glossary (
    slug, term, category, plain_definition, measurement_gotcha,
    official_source, screen_path, keywords, is_active, updated_by, updated_at
  )
  VALUES (
    v_slug, v_term, v_cat, v_def, v_gotcha,
    v_source, v_screen, COALESCE(p_keywords, ARRAY[]::text[]), COALESCE(p_is_active, true), v_uid, now()
  )
  ON CONFLICT (slug) DO UPDATE
    SET term               = EXCLUDED.term,
        category           = EXCLUDED.category,
        plain_definition   = EXCLUDED.plain_definition,
        measurement_gotcha = EXCLUDED.measurement_gotcha,
        official_source    = EXCLUDED.official_source,
        screen_path        = EXCLUDED.screen_path,
        keywords           = EXCLUDED.keywords,
        is_active          = EXCLUDED.is_active,
        updated_by         = v_uid,
        updated_at         = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'entry', row_to_json(v_row)::jsonb
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.zoe_glossary_upsert_entry(text, text, text, text, text, text, text, text[], boolean) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.zoe_glossary_upsert_entry(text, text, text, text, text, text, text, text[], boolean) TO authenticated;

COMMIT;

