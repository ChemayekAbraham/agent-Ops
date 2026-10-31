-- =============================================================================
-- Migration: 20261030140000_staff_assistant_prompt4_learning_kb_and_starters.sql
-- Purpose:   Zoe Prompt 4 Database Foundation:
--            (1) Personalised starters (`assistant_staff_personalised_starters`)
--                from the signed-in person's own last 30 days of topics + role tools.
--            (3) Memory that learns: editable notes (`staff_assistant_update_note`),
--                `memory_enabled` & `dismissed_memory_prompts` on
--                `staff_assistant_preferences`, `staff_assistant_set_memory_prefs`,
--                and `staff_assistant_get_memory_prefs`.
--            (4) What changed Morning Brief (`assistant_staff_morning_brief_what_changed`)
--                comparing today with the 4-week average, capped at 3 items.
--            (5) Learning loop: `staff_assistant_learning_log` (stores topic, tool,
--                outcome, latency, cost, and thumbs without a second copy of text),
--                `staff_assistant_eval_candidates`, `staff_assistant_promote_to_eval_set`,
--                and `staff_assistant_weekly_manager_learning_view`.
--            (6) Curated Knowledge Base (`staff_assistant_knowledge_base`) with
--                Postgres full-text search (`search_tsv` + GIN index),
--                `assistant_staff_search_knowledge_base`, manager editor RPC
--                `staff_assistant_upsert_knowledge_entry`, and initial reviewed seed.
-- Safety:    Strictly additive; all new tables have explicit grants, RLS, and
--            `mfa_required_for_staff`. All `assistant_staff_*` functions are
--            STABLE SECURITY DEFINER, read-only, caller-checked, and granted to
--            authenticated only.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extend `staff_assistant_preferences` for Memory Off & dismissed prompts
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assistant_preferences
  ADD COLUMN IF NOT EXISTS memory_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS dismissed_memory_prompts text[] NOT NULL DEFAULT '{}'::text[];

-- -----------------------------------------------------------------------------
-- 2. Learning Loop Table: `staff_assistant_learning_log`
--    Logs each question's topic (from a fixed list), tool used, outcome,
--    latency, cost, and thumbs WITHOUT storing a second copy of the question text.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_learning_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid REFERENCES public.staff_assistant_messages(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES public.staff_assistant_conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  caller_roles text[] NOT NULL DEFAULT '{}'::text[],
  topic text NOT NULL CHECK (
    topic IN (
      'my_space',
      'tenant_ops',
      'landlord_ops',
      'calling_center',
      'agent_ops',
      'supporters_partner_ops',
      'finance_cfo',
      'coo_ceo_executive',
      'hr_people',
      'welile_glossary_process',
      'general_accounting_writing',
      'research_advice',
      'other'
    )
  ),
  tool_used text,
  outcome text NOT NULL DEFAULT 'answered',
  latency_ms integer,
  cost_usd numeric(10, 6) NOT NULL DEFAULT 0,
  model_tier text CHECK (model_tier IS NULL OR model_tier IN ('fast', 'deep')),
  feedback_rating smallint CHECK (feedback_rating IS NULL OR feedback_rating IN (-1, 1)),
  feedback_theme text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_learning_log_user_created
  ON public.staff_assistant_learning_log (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_learning_log_topic_created
  ON public.staff_assistant_learning_log (topic, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_learning_log_message_id
  ON public.staff_assistant_learning_log (message_id)
  WHERE message_id IS NOT NULL;

ALTER TABLE public.staff_assistant_learning_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_assistant_learning_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_learning_log TO authenticated;
GRANT ALL ON TABLE public.staff_assistant_learning_log TO service_role;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_learning_log;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_learning_log
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS staff_assistant_learning_log_select_own_or_reviewer ON public.staff_assistant_learning_log;
CREATE POLICY staff_assistant_learning_log_select_own_or_reviewer
  ON public.staff_assistant_learning_log
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (SELECT public.staff_assistant_is_crm_reviewer())
  );

-- -----------------------------------------------------------------------------
-- 3. Evaluation Set Candidates Table: `staff_assistant_eval_candidates`
--    Holds cleaned, PII-redacted questions promoted via "Add to tests" from the
--    thumbs-down / problem-report / unanswered review queue.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_eval_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_kind text NOT NULL CHECK (source_kind IN ('feedback', 'unanswered', 'manual')),
  source_id uuid,
  cleaned_question text NOT NULL CHECK (char_length(btrim(cleaned_question)) BETWEEN 5 AND 500),
  expected_topic text NOT NULL DEFAULT 'other' CHECK (
    expected_topic IN (
      'my_space',
      'tenant_ops',
      'landlord_ops',
      'calling_center',
      'agent_ops',
      'supporters_partner_ops',
      'finance_cfo',
      'coo_ceo_executive',
      'hr_people',
      'welile_glossary_process',
      'general_accounting_writing',
      'research_advice',
      'other'
    )
  ),
  expected_tool text,
  outcome_before text,
  reviewer_notes text,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_assistant_eval_candidates_source_unique
  ON public.staff_assistant_eval_candidates (source_kind, source_id)
  WHERE source_id IS NOT NULL;

ALTER TABLE public.staff_assistant_eval_candidates ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_assistant_eval_candidates FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_eval_candidates TO authenticated;
GRANT ALL ON TABLE public.staff_assistant_eval_candidates TO service_role;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_eval_candidates;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_eval_candidates
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS staff_assistant_eval_candidates_select_reviewer ON public.staff_assistant_eval_candidates;
CREATE POLICY staff_assistant_eval_candidates_select_reviewer
  ON public.staff_assistant_eval_candidates
  FOR SELECT
  TO authenticated
  USING ((SELECT public.staff_assistant_is_crm_reviewer()));

-- -----------------------------------------------------------------------------
-- 4. Curated Knowledge Base Table: `staff_assistant_knowledge_base`
--    Managers edit it through a screen (`staff_assistant_upsert_knowledge_entry`),
--    never through Zoe. Zoe searches it with Postgres full-text search before the web.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assistant_knowledge_base (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9_]{3,80}$'),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 3 AND 160),
  category text NOT NULL CHECK (
    category IN (
      'glossary',
      'product_policy',
      'process_explanation',
      'where_to_find',
      'measurement_gotcha'
    )
  ),
  summary text NOT NULL CHECK (char_length(btrim(summary)) BETWEEN 10 AND 600),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 10 AND 4000),
  measurement_gotcha text,
  official_source text NOT NULL DEFAULT 'SYSTEM_CONTEXT.md',
  screen_path text,
  keywords text[] NOT NULL DEFAULT '{}'::text[],
  review_status text NOT NULL DEFAULT 'published' CHECK (
    review_status IN ('draft', 'reviewed', 'published', 'archived')
  ),
  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  search_tsv tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(slug, '') || ' ' || coalesce(summary, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(body, '') || ' ' || coalesce(measurement_gotcha, '') || ' ' || coalesce(official_source, '')), 'C')
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_kb_search_tsv
  ON public.staff_assistant_knowledge_base USING gin (search_tsv);

CREATE INDEX IF NOT EXISTS idx_staff_assistant_kb_category_status
  ON public.staff_assistant_knowledge_base (category, review_status);

ALTER TABLE public.staff_assistant_knowledge_base ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.staff_assistant_knowledge_base FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.staff_assistant_knowledge_base TO authenticated;
GRANT ALL ON TABLE public.staff_assistant_knowledge_base TO service_role;

DROP POLICY IF EXISTS mfa_required_for_staff ON public.staff_assistant_knowledge_base;
CREATE POLICY mfa_required_for_staff
  ON public.staff_assistant_knowledge_base
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

DROP POLICY IF EXISTS staff_assistant_knowledge_base_select_staff ON public.staff_assistant_knowledge_base;
CREATE POLICY staff_assistant_knowledge_base_select_staff
  ON public.staff_assistant_knowledge_base
  FOR SELECT
  TO authenticated
  USING ((SELECT public.staff_assistant_has_access()));

-- -----------------------------------------------------------------------------
-- 5. Seed `staff_assistant_knowledge_base` from SYSTEM_CONTEXT.md, .agents/skills,
--    supabase/AGENTS.md, and staff manuals (reviewed & published).
-- -----------------------------------------------------------------------------
INSERT INTO public.staff_assistant_knowledge_base (
  slug,
  title,
  category,
  summary,
  body,
  measurement_gotcha,
  official_source,
  screen_path,
  keywords,
  review_status,
  reviewed_at
)
VALUES
  (
    'expected_vs_collected_repayments',
    'Expected vs Collected Rent Repayments',
    'measurement_gotcha',
    'Expected rent is the daily or weekly schedule due over elapsed days on active payout-clock Rent Plans; Collected is non-reversed cash/wallet receipts.',
    'In Tenant Ops, Agent Monitoring, and Weekly Performance, a Rent Plan repayment clock (am_plan_clock) starts the Kampala day AFTER its latest landlord payout (awaiting_agent_receipt or completed). Plans with no landlord payout owe nothing yet and sit in tenant_paying_no_landlord or awaiting_landlord. Expected vs Collected compares non-reversed agent_collections against the scheduled daily_repayment due over elapsed clock days.',
    'Never subtract Collected from Total Disbursed to calculate arrears, and never include today in the Thursday-to-Wednesday agent weekly collection percentage (rent_request_agent_week_pct measures Thursday through yesterday).',
    'supabase/AGENTS.md · am_plan_clock · tops_arrears_ageing_amclock',
    '/tenant-ops',
    ARRAY['expected', 'collected', 'arrears', 'repayment', 'clock', 'am_plan_clock', 'shortfall'],
    'published',
    now()
  ),
  (
    'treasury_cash_position_vs_agent_float',
    'Treasury Cash Position (A1 + A5) vs Agent Float (A2)',
    'measurement_gotcha',
    'Platform spendable Treasury cash comes exclusively from get_treasury_cash_position (Accounts A1 + A5), separate from Agent Float (A2) and user wallet liabilities.',
    'Welile records money across general_ledger accounts resolved by sofp_ledger_legs. Spendable platform cash is read only from public.get_treasury_cash_position() (Accounts A1 Platform Cash and A5 Treasury). Account A2 is Agent Landlord Float allocated for landlord payouts, and wallet balances represent liabilities or earmarked operational float rather than free company cash.',
    'Never use the legacy get_treasury_snapshot function (superseded) and never add user wallet liabilities or Agent Float (A2) into spendable Treasury cash.',
    'SYSTEM_CONTEXT.md · welile-chart-of-accounts · get_treasury_cash_position',
    '/cfo/dashboard',
    ARRAY['treasury', 'cash', 'position', 'a1', 'a5', 'a2', 'float', 'wallet', 'balance', 'liquidity'],
    'published',
    now()
  ),
  (
    'active_rent_plan_and_payout_clock',
    'Active Rent Plan & Landlord Payout Clock',
    'measurement_gotcha',
    'A Rent Plan is active on the repayment clock only after landlord payout disbursement; earlier stages are approval pipeline.',
    'Rent Plan applications progress through seven desks in order: service_center, agent_ops, tenant_ops, landlord_ops, partner_ops, coo, and cfo. Once funded and the landlord payout is disbursed (COALESCE(finops_disbursed_at, disbursed_at)), the plan enters the counting bucket of am_plan_clock starting the next Kampala day. First 7 Days onboarding (am_new_tenant_first7_summary_v2) tracks Days 1 to 7 from first_landlord_paid_on + 1.',
    'Plans in funded status whose landlord has not yet been paid are Funded - money with agent or awaiting landlord payout; they have no repayment clock and must not be counted as delinquent.',
    'supabase/AGENTS.md · am_plan_clock · am_new_tenant_first7_summary_v2',
    '/tenant-ops',
    ARRAY['active', 'rent plan', 'clock', 'first 7 days', 'funded', 'repaying', 'pipeline', 'landlord payout'],
    'published',
    now()
  ),
  (
    'mandatory_regulatory_terminology',
    'Welile Regulatory Terminology (Rent Plan, Supporter, Returns)',
    'product_policy',
    'Welile facilitates Rent Plans backed by Supporters who earn Returns; lending terminology is strictly prohibited.',
    'Across all Welile screens, reports, emails, SMS campaigns, and Zoe answers, staff must use regulatory-compliant terminology: say "Rent Plan" (never loan), "Supporter" (never lender), and "Returns" or "Access Fee" (never ROI or interest). Uganda Shilling figures are formatted as "UGX 1,234,567".',
    'Four-part repayment validation reconciles Supporter Returns + Agent Commission + Platform Fee to Access Fee + Registration Fee.',
    'CLAUDE.md · AGENTS.md · Welile Compliance Policy',
    '/me/zoe',
    ARRAY['terminology', 'rent plan', 'supporter', 'returns', 'access fee', 'compliance', 'glossary'],
    'published',
    now()
  ),
  (
    'agent_vs_subagent_and_listing_commissions',
    'Field Agent vs Sub-Agent Attribution & Listing Earnings',
    'measurement_gotcha',
    'Main agents only link to sub-agents when agent_subagents.status = verified; house listing commissions come exclusively from general_ledger.',
    'In Agent Ops (agent_ops_metrics_totals, agent_ops_metrics_agents, agent_ops_metrics_main_agents), the agent on a Rent Plan request is COALESCE(assigned_agent_id, agent_id). A parent (main) agent is recognized only when agent_subagents.status = verified (pending, expired, or rejected links are excluded). House listing commission totals read general_ledger (agent_commission_earned and agent_commission less clawbacks), never the incomplete agent_earnings table.',
    'Agent lending uses agents own capital and is excluded from company Receivables. Support capacity debits operational float only, never withdrawable Returns.',
    'supabase/AGENTS.md · agent_ops_metrics_totals · rent_request_agent_chain',
    '/executive-hub?tab=agent-ops',
    ARRAY['agent', 'sub-agent', 'subagent', 'listing', 'commission', 'float', 'advance', 'houses'],
    'published',
    now()
  ),
  (
    'calling_center_weeks_and_deduplication',
    'Calling Center Wednesday-to-Tuesday Weeks & 15-Minute Deduplication',
    'measurement_gotcha',
    'Calling reports use Wednesday-to-Tuesday Kampala weeks and deduplicate same-caller same-callee calls within 15 minutes.',
    'Both cc_weekly_all_calls_report and staff_calling_detailed_report (used by Jane, Winnie, Hanisha, and HR/Management) group weekly calling activity by Wednesday-to-Tuesday Kampala weeks. When a staff member logs multiple call events to the same person or Rent Plan within 15 minutes across app voice, Calling Center, or pipeline awareness calls, only the highest-priority record is counted. In the Landlord Calling Hub, voided calls and unrecorded reveals older than 24 hours are excluded from answered totals.',
    'Winnie and Hanisha see only their own rows in /me/reports; Jane (team head) and HR/executive roles see all three callers in /me/staff-reports.',
    'supabase/AGENTS.md · staff_calling_detailed_report · landlord_cc_weekly_report',
    '/me/staff-reports',
    ARRAY['calling', 'calls', 'jane', 'winnie', 'hanisha', 'deduplication', 'wednesday', 'landlord hub'],
    'published',
    now()
  ),
  (
    'staff_requisition_approval_workflow',
    'Staff Requisitions & Supplementary Budgets Workflow',
    'process_explanation',
    'Staff requisitions follow COO -> CEO -> CFO approval (except active Product R&D which goes CEO -> CFO).',
    'Staff submit requisitions in My Space (/me/requisitions). Standard operational requisitions move from COO review to CEO approval and then to CFO / Financial Ops for disbursement. Requisitions under the active Product R&D budget head route directly from CEO to CFO via staff_requisition_ceo_direct. Supplementary budgets live in budget_supplements and never edit the original approved budget line (revised = original + CFO-approved supplements via budget_revised_position).',
    'Zoe is strictly read-only and cannot submit or approve a requisition; use /me/requisitions or /financial-ops.',
    'AGENTS.md · budget_revised_position · staff_requisition_ceo_direct',
    '/me/requisitions',
    ARRAY['requisition', 'approval', 'budget', 'supplement', 'coo', 'ceo', 'cfo', 'disbursement'],
    'published',
    now()
  ),
  (
    'rent_plan_seven_desk_pipeline',
    'Rent Plan 7-Desk Approval Pipeline & Time on Desk',
    'process_explanation',
    'Rent Plan requests move through Service Center, Agent Ops, Tenant Ops, Landlord Ops, Partner Ops, COO, and CFO.',
    'Each Rent Plan application is ordered on desks by rent_request_desk_order (default best_payers using tenant_payment_score). Time spent on the current desk, previous visit, and total turnaround comes from rent_request_timing(p_request_ids) using actual desk entry stamps rather than updated_at. Landlord payout numbers lock at the COO/CFO stage via lock_landlord_number_at_cfo_stage.',
    'Landlord/LC1 verification bonuses release only on the first Landlord Ops review transition.',
    'supabase/AGENTS.md · rent_request_timing · rent_request_desk_order',
    '/tenant-ops',
    ARRAY['pipeline', 'desk', 'time on desk', 'turnaround', 'service center', 'landlord ops', 'partner ops'],
    'published',
    now()
  ),
  (
    'where_to_find_my_space_screens',
    'Where to Find My Space & Department Screens',
    'where_to_find',
    'Quick navigation guide to My Space (/me), My Work (/me/work), Requisitions (/me/requisitions), Calling Reports (/me/reports), and Department Hubs.',
    'Use /me for your personal My Space overview (payslips, attendance, leave, salary advances, assets, canteen). Use /me/work for assigned tasks and HR support tickets. Use /me/requisitions to submit or track staff requisitions. Use /me/reports for personal calling reports (Jane, Winnie, Hanisha) and /me/staff-reports for HR/Management calling reports. Use /me/ideas for the Ideas for Welile review board. Department workspaces live at /tenant-ops, /landlord-ops, /landlord-ops/calling, /partner-ops, /executive-hub?tab=agent-ops, /cfo/dashboard, and /financial-ops.',
    'Each workspace enforces role-based access and two-step authenticator (AAL2) verification for staff roles.',
    'src/App.tsx · Welile Staff Manual',
    '/me',
    ARRAY['where do i find', 'navigation', 'screen', 'menu', 'my space', 'payslip', 'tasks', 'tickets', 'ideas'],
    'published',
    now()
  ),
  (
    'supporter_portfolios_and_returns_due',
    'Supporter Portfolios, Payout Cutoffs & Invited Pipeline',
    'product_policy',
    'Supporter portfolios track principal, monthly Returns due, 90-day withdrawal notices, and up to 2 extra payout destinations.',
    'Partner Ops (/partner-ops) manages pending Supporter portfolios (funder_pending_portfolios), invited portfolios (partner_ops_invite_visibility), and nearing payouts. Partner payout tiles reuse existing paid and outstanding reports and preserve original totals and due-by cutoffs without inventing next due dates. Nearing Payout checks fresh unused CFO cycle permissions before duplicate warnings.',
    'Never refer to Supporters as lenders or Returns as ROI/interest.',
    'AGENTS.md · supabase/AGENTS.md · partner_ops_invite_visibility',
    '/partner-ops',
    ARRAY['supporter', 'portfolio', 'returns', 'payout', 'partner ops', 'withdrawal', 'invited'],
    'published',
    now()
  )
ON CONFLICT (slug) DO UPDATE
SET
  title = EXCLUDED.title,
  category = EXCLUDED.category,
  summary = EXCLUDED.summary,
  body = EXCLUDED.body,
  measurement_gotcha = EXCLUDED.measurement_gotcha,
  official_source = EXCLUDED.official_source,
  screen_path = EXCLUDED.screen_path,
  keywords = EXCLUDED.keywords,
  updated_at = now();

-- -----------------------------------------------------------------------------
-- 6. Read-Only Tool RPC: `assistant_staff_search_knowledge_base`
--    Searches `staff_assistant_knowledge_base` (and `staff_assistant_glossary`)
--    using Postgres full-text search (`search_tsv`) before any web search.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_search_knowledge_base(
  p_query text DEFAULT NULL,
  p_category text DEFAULT NULL,
  p_limit integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_clean_query text := btrim(coalesce(p_query, ''));
  v_clean_cat text := nullif(lower(btrim(coalesce(p_category, ''))), '');
  v_lim integer := greatest(1, least(coalesce(p_limit, 8), 25));
  v_tsq tsquery := NULL;
  v_rows jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to use the Staff Assistant.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_roles ur
    WHERE ur.user_id = v_uid
      AND ur.enabled = true
  ) THEN
    RAISE EXCEPTION 'No enabled role found for caller.'
      USING ERRCODE = '42501';
  END IF;

  IF v_clean_query <> '' THEN
    BEGIN
      v_tsq := websearch_to_tsquery('english', left(v_clean_query, 160));
    EXCEPTION WHEN OTHERS THEN
      v_tsq := plainto_tsquery('english', left(v_clean_query, 160));
    END;
  END IF;

  WITH kb_matches AS (
    SELECT
      kb.slug,
      kb.title,
      kb.category,
      kb.summary,
      kb.body,
      kb.measurement_gotcha,
      kb.official_source,
      kb.screen_path,
      kb.keywords,
      kb.updated_at,
      CASE
        WHEN v_tsq IS NOT NULL AND kb.search_tsv @@ v_tsq THEN
          ts_rank_cd(kb.search_tsv, v_tsq) + 1.0
        WHEN v_clean_query <> '' AND (
          kb.title ILIKE '%' || v_clean_query || '%'
          OR kb.summary ILIKE '%' || v_clean_query || '%'
          OR kb.body ILIKE '%' || v_clean_query || '%'
          OR kb.slug ILIKE '%' || replace(lower(v_clean_query), ' ', '_') || '%'
          OR EXISTS (
            SELECT 1
            FROM unnest(kb.keywords) kw
            WHERE lower(v_clean_query) LIKE '%' || lower(kw) || '%'
               OR lower(kw) LIKE '%' || lower(v_clean_query) || '%'
          )
        ) THEN 0.5
        WHEN v_clean_query = '' THEN 0.1
        ELSE 0.0
      END AS rank_score
    FROM public.staff_assistant_knowledge_base kb
    WHERE kb.review_status = 'published'
      AND (v_clean_cat IS NULL OR kb.category = v_clean_cat)
  ),
  filtered AS (
    SELECT *
    FROM kb_matches
    WHERE rank_score > 0
    ORDER BY rank_score DESC, title ASC
    LIMIT v_lim
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'slug', f.slug,
        'title', f.title,
        'category', f.category,
        'summary', f.summary,
        'body', f.body,
        'measurement_gotcha', f.measurement_gotcha,
        'official_source', f.official_source,
        'screen_path', f.screen_path,
        'keywords', f.keywords,
        'citation', format('Welile Knowledge Base: %s (%s)', f.title, f.slug),
        'updated_at', f.updated_at
      )
    ),
    '[]'::jsonb
  )
  INTO v_rows
  FROM filtered f;

  -- Fallback: if a specific query matched 0 rows in FTS/substring, return top published entries so Zoe always has core gotchas
  IF jsonb_array_length(v_rows) = 0 THEN
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'slug', kb.slug,
          'title', kb.title,
          'category', kb.category,
          'summary', kb.summary,
          'body', kb.body,
          'measurement_gotcha', kb.measurement_gotcha,
          'official_source', kb.official_source,
          'screen_path', kb.screen_path,
          'keywords', kb.keywords,
          'citation', format('Welile Knowledge Base: %s (%s)', kb.title, kb.slug),
          'updated_at', kb.updated_at
        )
      ),
      '[]'::jsonb
    )
    INTO v_rows
    FROM (
      SELECT *
      FROM public.staff_assistant_knowledge_base kb
      WHERE kb.review_status = 'published'
        AND (v_clean_cat IS NULL OR kb.category = v_clean_cat)
      ORDER BY kb.category = 'measurement_gotcha' DESC, kb.title ASC
      LIMIT v_lim
    ) kb;
  END IF;

  RETURN jsonb_build_object(
    'source', 'staff_assistant_knowledge_base',
    'period', 'current published knowledge base',
    'query', v_clean_query,
    'row_count', jsonb_array_length(v_rows),
    'rows', v_rows
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_search_knowledge_base(text, text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_staff_search_knowledge_base(text, text, integer) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 7. Read-Only Tool RPC: `assistant_staff_personalised_starters`
--    Returns up to 3 starter prompts for the signed-in person, from their own
--    last 30 days of question topics (never other people's text), their role,
--    and what their role's tools can actually answer.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_personalised_starters()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_roles text[] := '{}'::text[];
  v_starters jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to use the Staff Assistant.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(DISTINCT ur.role::text), '{}'::text[])
  INTO v_roles
  FROM public.user_roles ur
  WHERE ur.user_id = v_uid
    AND ur.enabled = true;

  IF array_length(v_roles, 1) IS NULL THEN
    RAISE EXCEPTION 'No enabled role found for caller.'
      USING ERRCODE = '42501';
  END IF;

  WITH catalog(id, topic, label, prompt, tool, allowed_roles, base_priority) AS (
    VALUES
      (
        'starter-tops-first7',
        'tenant_ops',
        'First 7 Days collection summary',
        'How are newly funded Rent Plans performing in the First 7 Days report today?',
        'get_tops_first_seven_summary',
        ARRAY['tenant_ops', 'operations', 'manager', 'coo', 'cfo', 'ceo', 'cto', 'super_admin'],
        90
      ),
      (
        'starter-tops-arrears',
        'tenant_ops',
        'Tenant Ops arrears ageing',
        'Show the Tenant Ops arrears ageing breakdown across 1-7, 8-14, 15-30, and 30+ days.',
        'get_tops_arrears_ageing',
        ARRAY['tenant_ops', 'operations', 'manager', 'coo', 'cfo', 'ceo', 'cto', 'super_admin'],
        85
      ),
      (
        'starter-lops-summary',
        'landlord_ops',
        'Landlord Ops verifications & payouts',
        'How many landlords were verified and paid out in Landlord Ops over the last 7 days?',
        'get_lops_home_range',
        ARRAY['landlord_ops', 'operations', 'manager', 'coo', 'cfo', 'ceo', 'super_admin'],
        88
      ),
      (
        'starter-calling-report',
        'calling_center',
        'Weekly Calling Center report',
        'Show the weekly Calling Center report and reach rates for this week.',
        'get_hr_calling_detailed_report',
        ARRAY['hr', 'operations', 'tenant_ops', 'landlord_ops', 'crm', 'manager', 'coo', 'ceo', 'super_admin'],
        84
      ),
      (
        'starter-aops-overview',
        'agent_ops',
        'Agent Ops network & silent collectors',
        'Show the Agent Ops network overview and silent field collectors today.',
        'get_aops_network_overview',
        ARRAY['agent_ops', 'operations', 'manager', 'coo', 'cfo', 'ceo', 'cto', 'super_admin'],
        87
      ),
      (
        'starter-pops-pending',
        'supporters_partner_ops',
        'Pending Supporter portfolios',
        'How many pending Supporter portfolios are in the Partner Ops queue and what is their total UGX?',
        'get_pops_pending_summary',
        ARRAY['partner_ops', 'operations', 'manager', 'coo', 'cfo', 'ceo', 'super_admin'],
        86
      ),
      (
        'starter-cfo-treasury',
        'finance_cfo',
        'Treasury cash position (A1 + A5)',
        'What is our spendable Treasury Cash Position (Accounts A1 and A5) today?',
        'get_cfo_treasury_cash_position',
        ARRAY['cfo', 'fin_ops', 'coo', 'ceo', 'super_admin'],
        95
      ),
      (
        'starter-coo-overview',
        'coo_ceo_executive',
        'COO Command Center pulse',
        'Show the COO Command Center overview and Rent Plan desk turnaround times.',
        'get_coo_overview',
        ARRAY['coo', 'ceo', 'cfo', 'cto', 'manager', 'super_admin'],
        92
      ),
      (
        'starter-hr-contracts',
        'hr_people',
        'HR contracts & birthdays',
        'How many staff contracts are expiring within 60 days and whose birthday is coming up?',
        'get_hr_contracts_and_birthdays',
        ARRAY['hr', 'manager', 'coo', 'ceo', 'super_admin'],
        83
      ),
      (
        'starter-my-tasks',
        'my_space',
        'My pending tasks & requisitions',
        'What are my pending tasks in My Work and the status of my staff requisitions?',
        'get_my_tasks',
        ARRAY['employee', 'operations', 'tenant_ops', 'landlord_ops', 'partner_ops', 'agent_ops', 'crm', 'hr', 'fin_ops', 'manager', 'coo', 'cfo', 'cto', 'ceo', 'super_admin'],
        75
      ),
      (
        'starter-my-payslips',
        'my_space',
        'My recent payslips & wallet',
        'Show my recent payslips and personal wallet balance in My Space.',
        'get_my_payslips',
        ARRAY['employee', 'operations', 'tenant_ops', 'landlord_ops', 'partner_ops', 'agent_ops', 'crm', 'hr', 'fin_ops', 'manager', 'coo', 'cfo', 'cto', 'ceo', 'super_admin'],
        70
      ),
      (
        'starter-kb-gotchas',
        'welile_glossary_process',
        'Expected vs Collected rent rule',
        'Explain how Welile measures Expected vs Collected rent and when the repayment clock starts.',
        'search_knowledge_base',
        ARRAY['employee', 'operations', 'tenant_ops', 'landlord_ops', 'partner_ops', 'agent_ops', 'crm', 'hr', 'fin_ops', 'manager', 'coo', 'cfo', 'cto', 'ceo', 'super_admin'],
        65
      )
  ),
  own_topic_counts AS (
    -- Strictly the signed-in person's own last 30 days of topics (never other users' rows or text)
    SELECT
      ll.topic,
      count(*)::integer AS ask_count
    FROM public.staff_assistant_learning_log ll
    WHERE ll.user_id = v_uid
      AND ll.created_at >= now() - interval '30 days'
    GROUP BY ll.topic
  ),
  own_tool_topics AS (
    -- Also infer topics from the caller's own assistant message tool calls over the last 30 days
    SELECT
      CASE
        WHEN m.tools_called && ARRAY['get_tops_first_seven_summary', 'get_tops_arrears_ageing', 'get_tops_weekly_performance'] THEN 'tenant_ops'
        WHEN m.tools_called && ARRAY['get_lops_home_range', 'get_lops_paid_lists', 'get_lops_verification_queue'] THEN 'landlord_ops'
        WHEN m.tools_called && ARRAY['get_hr_calling_detailed_report', 'get_lops_calling_summary', 'get_my_calls'] THEN 'calling_center'
        WHEN m.tools_called && ARRAY['get_aops_network_overview', 'get_aops_metrics_totals', 'get_aops_silent_collectors'] THEN 'agent_ops'
        WHEN m.tools_called && ARRAY['get_pops_pending_summary', 'get_pops_report_overview', 'get_pops_returns_due'] THEN 'supporters_partner_ops'
        WHEN m.tools_called && ARRAY['get_cfo_treasury_cash_position', 'get_cfo_money_flow_summary', 'get_cfo_receivables_and_payables'] THEN 'finance_cfo'
        WHEN m.tools_called && ARRAY['get_coo_overview', 'get_ceo_growth_and_approvals'] THEN 'coo_ceo_executive'
        WHEN m.tools_called && ARRAY['get_hr_contracts_and_birthdays', 'get_hr_payroll_cost_by_department'] THEN 'hr_people'
        WHEN m.tools_called && ARRAY['get_my_tasks', 'get_my_payslips', 'get_my_requisitions', 'get_my_wallet'] THEN 'my_space'
        ELSE 'welile_glossary_process'
      END AS topic,
      count(*)::integer AS ask_count
    FROM public.staff_assistant_messages m
    WHERE m.user_id = v_uid
      AND m.role = 'assistant'
      AND m.created_at >= now() - interval '30 days'
    GROUP BY 1
  ),
  combined_topics AS (
    SELECT
      topic,
      sum(ask_count)::integer AS total_topic_count
    FROM (
      SELECT * FROM own_topic_counts
      UNION ALL
      SELECT * FROM own_tool_topics
    ) u
    GROUP BY topic
  ),
  scored AS (
    SELECT
      c.id,
      c.topic,
      c.label,
      c.prompt,
      c.tool,
      coalesce(ct.total_topic_count, 0) AS user_topic_count,
      (c.base_priority + least(coalesce(ct.total_topic_count, 0) * 15, 60)) AS score
    FROM catalog c
    LEFT JOIN combined_topics ct ON ct.topic = c.topic
    WHERE c.allowed_roles && v_roles
    ORDER BY (c.base_priority + least(coalesce(ct.total_topic_count, 0) * 15, 60)) DESC, c.id ASC
    LIMIT 3
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', s.id,
        'topic', s.topic,
        'label', s.label,
        'prompt', s.prompt,
        'tool', s.tool,
        'personalised_from_own_history', (s.user_topic_count > 0)
      )
    ),
    '[]'::jsonb
  )
  INTO v_starters
  FROM scored s;

  RETURN jsonb_build_object(
    'source', 'assistant_staff_personalised_starters',
    'period', 'last 30 days (caller topics only)',
    'row_count', jsonb_array_length(v_starters),
    'starters', v_starters
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_personalised_starters() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_staff_personalised_starters() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 8. Read-Only Tool RPC: `assistant_staff_morning_brief_what_changed`
--    Returns up to 3 role-scoped "What changed" lines comparing today with the
--    4-week average from `staff_assistant_insights` (and existing read-only
--    reports), each with its source and screen link. No outbound email or SMS.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assistant_staff_morning_brief_what_changed()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_roles text[] := '{}'::text[];
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_items jsonb := '[]'::jsonb;
  v_prefs record;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to use the Staff Assistant.'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(DISTINCT ur.role::text), '{}'::text[])
  INTO v_roles
  FROM public.user_roles ur
  WHERE ur.user_id = v_uid
    AND ur.enabled = true;

  IF array_length(v_roles, 1) IS NULL THEN
    RAISE EXCEPTION 'No enabled role found for caller.'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    coalesce(p.morning_brief_enabled, false) AS enabled,
    coalesce(p.morning_brief_time, '07:30') AS brief_time,
    p.dismissed_brief_kampala_date
  INTO v_prefs
  FROM public.staff_assistant_preferences p
  WHERE p.user_id = v_uid;

  WITH role_insights AS (
    SELECT
      i.category,
      i.title,
      i.summary,
      i.metric_name,
      i.current_value,
      i.four_week_avg,
      i.pct_change,
      i.direction,
      i.source_function AS source,
      coalesce(i.period_label, v_today::text) AS period,
      coalesce(i.screen_path, '/me') AS screen_path,
      i.is_notable,
      i.kampala_date
    FROM public.staff_assistant_insights i
    WHERE i.kampala_date >= v_today - 7
      AND (
        i.min_role_scope = 'all_staff'
        OR (i.min_role_scope = 'operations' AND v_roles && ARRAY['operations', 'tenant_ops', 'landlord_ops', 'agent_ops', 'partner_ops', 'manager', 'coo', 'cfo', 'ceo', 'cto', 'super_admin'])
        OR (i.min_role_scope = 'calling' AND v_roles && ARRAY['hr', 'operations', 'tenant_ops', 'landlord_ops', 'crm', 'manager', 'coo', 'ceo', 'super_admin'])
        OR (i.min_role_scope = 'management' AND v_roles && ARRAY['manager', 'coo', 'cfo', 'ceo', 'cto', 'super_admin'])
      )
    ORDER BY i.kampala_date DESC, i.is_notable DESC, abs(coalesce(i.pct_change, 0)) DESC
    LIMIT 3
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ri.category,
        'title', ri.title,
        'summary', ri.summary,
        'metric_name', ri.metric_name,
        'current_value', ri.current_value,
        'four_week_avg', ri.four_week_avg,
        'pct_change', ri.pct_change,
        'direction', ri.direction,
        'source', ri.source,
        'period', ri.period,
        'screen_path', ri.screen_path
      )
    ),
    '[]'::jsonb
  )
  INTO v_items
  FROM role_insights ri;

  RETURN jsonb_build_object(
    'source', 'assistant_staff_morning_brief_what_changed',
    'period', format('as of %s vs 4-week average', v_today::text),
    'kampala_date', v_today::text,
    'enabled', coalesce(v_prefs.enabled, false),
    'muted_today', (v_prefs.dismissed_brief_kampala_date = v_today),
    'in_app_only', true,
    'max_items', 3,
    'row_count', jsonb_array_length(v_items),
    'items', v_items
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assistant_staff_morning_brief_what_changed() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.assistant_staff_morning_brief_what_changed() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 9. Memory Management RPCs:
--    - `staff_assistant_update_note(p_note_id, p_note_text)`
--    - `staff_assistant_set_memory_prefs(p_memory_enabled, p_dismiss_preference_key)`
--    - `staff_assistant_get_memory_prefs()`
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_update_note(
  p_note_id uuid,
  p_note_text text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_clean text := regexp_replace(btrim(coalesce(p_note_text, '')), '\s+', ' ', 'g');
  v_updated record;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to update Zoe notes.'
      USING ERRCODE = '42501';
  END IF;

  IF p_note_id IS NULL THEN
    RAISE EXCEPTION 'Note ID is required.'
      USING ERRCODE = '22023';
  END IF;

  IF char_length(v_clean) < 2 OR char_length(v_clean) > 240 THEN
    RAISE EXCEPTION 'Note must be between 2 and 240 characters.'
      USING ERRCODE = '22023';
  END IF;

  -- Block business figures, UGX amounts, percentages, phones, emails, UUIDs, NINs, and banned terms
  IF v_clean ~* '\m(loans?|lenders?|roi|interest|ugx|ush|shillings?)\M'
     OR v_clean ~* '\m\d+(?:,\d{3})*(?:\.\d+)?\s*[kmb]\M'
     OR v_clean ~ '\d+(?:\.\d+)?\s*%'
     OR v_clean ~* '\m[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\M'
     OR v_clean ~* '\m[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\M'
     OR v_clean ~* '\mc[mf][a-z0-9]{12}\M'
     OR v_clean ~ '(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}'
     OR regexp_replace(v_clean, '\m(?:[01]?\d|2[0-3]):[0-5]\d\M', ' ', 'g') ~ '\m\d{3,}\M'
  THEN
    RAISE EXCEPTION 'Zoe notes can only store style or topic preferences — never business figures, phone numbers, emails, or IDs.'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.staff_assistant_notes n
  SET
    note_text = v_clean,
    updated_at = now()
  WHERE n.id = p_note_id
    AND n.user_id = v_uid
    AND n.is_deleted = false
  RETURNING n.id, n.note_text, n.created_at, n.updated_at
  INTO v_updated;

  IF v_updated.id IS NULL THEN
    RAISE EXCEPTION 'Note not found or not owned by caller.'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'note', jsonb_build_object(
      'id', v_updated.id,
      'note_text', v_updated.note_text,
      'created_at', v_updated.created_at,
      'updated_at', v_updated.updated_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_update_note(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_update_note(uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_assistant_set_memory_prefs(
  p_memory_enabled boolean DEFAULT NULL,
  p_dismiss_preference_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_clean_key text := nullif(btrim(coalesce(p_dismiss_preference_key, '')), '');
  v_row public.staff_assistant_preferences%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to update Zoe memory preferences.'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.staff_assistant_preferences (
    user_id,
    memory_enabled,
    dismissed_memory_prompts,
    updated_at
  )
  VALUES (
    v_uid,
    coalesce(p_memory_enabled, true),
    CASE WHEN v_clean_key IS NOT NULL THEN ARRAY[left(v_clean_key, 80)] ELSE '{}'::text[] END,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    memory_enabled = coalesce(p_memory_enabled, public.staff_assistant_preferences.memory_enabled),
    dismissed_memory_prompts = CASE
      WHEN v_clean_key IS NOT NULL AND NOT (v_clean_key = ANY(public.staff_assistant_preferences.dismissed_memory_prompts))
        THEN array_append(public.staff_assistant_preferences.dismissed_memory_prompts, left(v_clean_key, 80))
      ELSE public.staff_assistant_preferences.dismissed_memory_prompts
    END,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'memory_enabled', v_row.memory_enabled,
    'dismissed_memory_prompts', v_row.dismissed_memory_prompts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_set_memory_prefs(boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_set_memory_prefs(boolean, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_assistant_get_memory_prefs()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_memory_enabled boolean := true;
  v_dismissed text[] := '{}'::text[];
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to read Zoe memory preferences.'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    coalesce(p.memory_enabled, true),
    coalesce(p.dismissed_memory_prompts, '{}'::text[])
  INTO v_memory_enabled, v_dismissed
  FROM public.staff_assistant_preferences p
  WHERE p.user_id = v_uid;

  RETURN jsonb_build_object(
    'ok', true,
    'memory_enabled', coalesce(v_memory_enabled, true),
    'dismissed_memory_prompts', coalesce(v_dismissed, '{}'::text[])
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_get_memory_prefs() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_get_memory_prefs() TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 10. Manager Knowledge Base Editor RPC: `staff_assistant_upsert_knowledge_entry`
--     Editable only by managers, COO, CFO, CEO, CTO, or super_admin through the
--     management screen — never callable as a Zoe tool.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_upsert_knowledge_entry(
  p_slug text,
  p_title text,
  p_category text,
  p_summary text,
  p_body text,
  p_measurement_gotcha text DEFAULT NULL,
  p_official_source text DEFAULT 'Welile Operations Manual',
  p_screen_path text DEFAULT NULL,
  p_keywords text[] DEFAULT '{}'::text[],
  p_review_status text DEFAULT 'published'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_slug text := lower(regexp_replace(btrim(coalesce(p_slug, '')), '[^a-z0-9_]+', '_', 'g'));
  v_title text := btrim(coalesce(p_title, ''));
  v_cat text := lower(btrim(coalesce(p_category, 'glossary')));
  v_summary text := btrim(coalesce(p_summary, ''));
  v_body text := btrim(coalesce(p_body, ''));
  v_gotcha text := nullif(btrim(coalesce(p_measurement_gotcha, '')), '');
  v_source text := coalesce(nullif(btrim(p_official_source), ''), 'Welile Operations Manual');
  v_screen text := nullif(btrim(coalesce(p_screen_path, '')), '');
  v_status text := lower(btrim(coalesce(p_review_status, 'published')));
  v_row public.staff_assistant_knowledge_base%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_has_access() THEN
    RAISE EXCEPTION 'Not authorized to manage the Zoe Knowledge Base.'
      USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'manager'::public.app_role)
    OR public.has_role(v_uid, 'coo'::public.app_role)
    OR public.has_role(v_uid, 'cfo'::public.app_role)
    OR public.has_role(v_uid, 'ceo'::public.app_role)
    OR public.has_role(v_uid, 'cto'::public.app_role)
    OR public.has_role(v_uid, 'super_admin'::public.app_role)
  ) THEN
    RAISE EXCEPTION 'Only managers and executives can edit the Zoe Knowledge Base.'
      USING ERRCODE = '42501';
  END IF;

  IF v_slug !~ '^[a-z0-9_]{3,80}$' THEN
    RAISE EXCEPTION 'Invalid knowledge entry slug.'
      USING ERRCODE = '22023';
  END IF;

  IF v_cat NOT IN ('glossary', 'product_policy', 'process_explanation', 'where_to_find', 'measurement_gotcha') THEN
    RAISE EXCEPTION 'Invalid knowledge category.'
      USING ERRCODE = '22023';
  END IF;

  IF v_status NOT IN ('draft', 'reviewed', 'published', 'archived') THEN
    RAISE EXCEPTION 'Invalid review status.'
      USING ERRCODE = '22023';
  END IF;

  IF v_title ~* '\m(loans?|lenders?|roi|interest)\M'
     OR v_summary ~* '\m(loans?|lenders?|roi|interest)\M'
     OR v_body ~* '\m(loans?|lenders?|roi|interest)\M'
  THEN
    RAISE EXCEPTION 'Knowledge base entries must use Welile regulatory terminology (Rent Plan, Supporter, Returns).'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.staff_assistant_knowledge_base (
    slug,
    title,
    category,
    summary,
    body,
    measurement_gotcha,
    official_source,
    screen_path,
    keywords,
    review_status,
    reviewed_by,
    reviewed_at,
    updated_by,
    updated_at
  )
  VALUES (
    v_slug,
    v_title,
    v_cat,
    v_summary,
    v_body,
    v_gotcha,
    v_source,
    v_screen,
    coalesce(p_keywords, '{}'::text[]),
    v_status,
    CASE WHEN v_status IN ('reviewed', 'published') THEN v_uid ELSE NULL END,
    CASE WHEN v_status IN ('reviewed', 'published') THEN now() ELSE NULL END,
    v_uid,
    now()
  )
  ON CONFLICT (slug) DO UPDATE
  SET
    title = EXCLUDED.title,
    category = EXCLUDED.category,
    summary = EXCLUDED.summary,
    body = EXCLUDED.body,
    measurement_gotcha = EXCLUDED.measurement_gotcha,
    official_source = EXCLUDED.official_source,
    screen_path = EXCLUDED.screen_path,
    keywords = EXCLUDED.keywords,
    review_status = EXCLUDED.review_status,
    reviewed_by = CASE WHEN EXCLUDED.review_status IN ('reviewed', 'published') THEN v_uid ELSE public.staff_assistant_knowledge_base.reviewed_by END,
    reviewed_at = CASE WHEN EXCLUDED.review_status IN ('reviewed', 'published') THEN now() ELSE public.staff_assistant_knowledge_base.reviewed_at END,
    updated_by = v_uid,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN jsonb_build_object(
    'ok', true,
    'entry', jsonb_build_object(
      'id', v_row.id,
      'slug', v_row.slug,
      'title', v_row.title,
      'category', v_row.category,
      'summary', v_row.summary,
      'body', v_row.body,
      'measurement_gotcha', v_row.measurement_gotcha,
      'official_source', v_row.official_source,
      'screen_path', v_row.screen_path,
      'keywords', v_row.keywords,
      'review_status', v_row.review_status,
      'updated_at', v_row.updated_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_upsert_knowledge_entry(text, text, text, text, text, text, text, text, text[], text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_upsert_knowledge_entry(text, text, text, text, text, text, text, text, text[], text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 11. Learning Loop Reviewer RPCs:
--     - `staff_assistant_promote_to_eval_set` ("Add to tests" button action)
--     - `staff_assistant_weekly_manager_learning_view` (weekly aggregate topics,
--       unanswered themes, thumbs-down themes, cost, and redacted review queue)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.staff_assistant_promote_to_eval_set(
  p_source_kind text,
  p_source_id uuid,
  p_cleaned_question text,
  p_expected_topic text DEFAULT 'other',
  p_expected_tool text DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_kind text := lower(btrim(coalesce(p_source_kind, 'manual')));
  v_clean_q text := btrim(coalesce(p_cleaned_question, ''));
  v_topic text := lower(btrim(coalesce(p_expected_topic, 'other')));
  v_row public.staff_assistant_eval_candidates%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_is_crm_reviewer() THEN
    RAISE EXCEPTION 'Only authorized CRM/manager reviewers can add items to the evaluation set.'
      USING ERRCODE = '42501';
  END IF;

  IF v_kind NOT IN ('feedback', 'unanswered', 'manual') THEN
    RAISE EXCEPTION 'Invalid evaluation candidate source_kind.'
      USING ERRCODE = '22023';
  END IF;

  -- Scrub any residual phone, email, or UUID from the cleaned question
  v_clean_q := regexp_replace(v_clean_q, '(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}', '[redacted-phone]', 'g');
  v_clean_q := regexp_replace(v_clean_q, '\m[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\M', '[redacted-email]', 'g');
  v_clean_q := regexp_replace(v_clean_q, '\m[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\M', '[redacted-id]', 'gi');

  IF char_length(v_clean_q) < 5 THEN
    RAISE EXCEPTION 'Cleaned evaluation question must be at least 5 characters.'
      USING ERRCODE = '22023';
  END IF;

  IF v_topic NOT IN (
    'my_space', 'tenant_ops', 'landlord_ops', 'calling_center', 'agent_ops',
    'supporters_partner_ops', 'finance_cfo', 'coo_ceo_executive', 'hr_people',
    'welile_glossary_process', 'general_accounting_writing', 'research_advice', 'other'
  ) THEN
    v_topic := 'other';
  END IF;

  INSERT INTO public.staff_assistant_eval_candidates (
    source_kind,
    source_id,
    cleaned_question,
    expected_topic,
    expected_tool,
    reviewer_notes,
    added_by,
    is_active,
    updated_at
  )
  VALUES (
    v_kind,
    p_source_id,
    left(v_clean_q, 500),
    v_topic,
    nullif(btrim(coalesce(p_expected_tool, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_uid,
    true,
    now()
  )
  ON CONFLICT (source_kind, source_id) WHERE source_id IS NOT NULL
  DO UPDATE SET
    cleaned_question = EXCLUDED.cleaned_question,
    expected_topic = EXCLUDED.expected_topic,
    expected_tool = COALESCE(EXCLUDED.expected_tool, public.staff_assistant_eval_candidates.expected_tool),
    reviewer_notes = COALESCE(EXCLUDED.reviewer_notes, public.staff_assistant_eval_candidates.reviewer_notes),
    updated_at = now()
  RETURNING * INTO v_row;

  IF v_kind = 'unanswered' AND p_source_id IS NOT NULL THEN
    UPDATE public.staff_assistant_unanswered
    SET
      status = 'planned',
      reviewed_by = v_uid,
      reviewed_at = now(),
      review_note = coalesce(nullif(btrim(p_notes), ''), 'Added to evaluation test set')
    WHERE id = p_source_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'candidate', jsonb_build_object(
      'id', v_row.id,
      'source_kind', v_row.source_kind,
      'source_id', v_row.source_id,
      'cleaned_question', v_row.cleaned_question,
      'expected_topic', v_row.expected_topic,
      'expected_tool', v_row.expected_tool,
      'created_at', v_row.created_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_promote_to_eval_set(text, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_promote_to_eval_set(text, uuid, text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.staff_assistant_weekly_manager_learning_view(
  p_days integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_days integer := greatest(1, least(coalesce(p_days, 7), 90));
  v_since timestamptz := now() - make_interval(days => v_days);
  v_top_topics jsonb := '[]'::jsonb;
  v_unanswered_themes jsonb := '[]'::jsonb;
  v_thumbs_down_themes jsonb := '[]'::jsonb;
  v_cost_summary jsonb := '{}'::jsonb;
  v_review_queue jsonb := '[]'::jsonb;
  v_eval_candidates jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.staff_assistant_is_crm_reviewer() THEN
    RAISE EXCEPTION 'Only authorized CRM/manager reviewers can view the weekly learning report.'
      USING ERRCODE = '42501';
  END IF;

  -- 1. Top topics (strictly aggregate: no individual staff text)
  WITH topic_rows AS (
    SELECT
      ll.topic,
      ll.outcome,
      ll.latency_ms,
      ll.cost_usd,
      ll.feedback_rating
    FROM public.staff_assistant_learning_log ll
    WHERE ll.created_at >= v_since
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'topic', t.topic,
        'question_count', t.question_count,
        'answered_count', t.answered_count,
        'unanswered_count', t.unanswered_count,
        'avg_latency_ms', t.avg_latency_ms,
        'total_cost_usd', t.total_cost_usd,
        'thumbs_up_count', t.thumbs_up_count,
        'thumbs_down_count', t.thumbs_down_count
      )
      ORDER BY t.question_count DESC, t.topic ASC
    ),
    '[]'::jsonb
  )
  INTO v_top_topics
  FROM (
    SELECT
      tr.topic,
      count(*)::integer AS question_count,
      count(*) FILTER (WHERE tr.outcome = 'answered')::integer AS answered_count,
      count(*) FILTER (WHERE tr.outcome <> 'answered')::integer AS unanswered_count,
      coalesce(round(avg(tr.latency_ms))::integer, 0) AS avg_latency_ms,
      coalesce(round(sum(tr.cost_usd)::numeric, 6), 0) AS total_cost_usd,
      count(*) FILTER (WHERE tr.feedback_rating = 1)::integer AS thumbs_up_count,
      count(*) FILTER (WHERE tr.feedback_rating = -1)::integer AS thumbs_down_count
    FROM topic_rows tr
    GROUP BY tr.topic
  ) t;

  -- 2. Unanswered themes (aggregate by reason & error_code, no individual staff text)
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'reason', u.reason,
        'error_code', coalesce(u.error_code, 'none'),
        'status', u.status,
        'count', u.cnt
      )
      ORDER BY u.cnt DESC
    ),
    '[]'::jsonb
  )
  INTO v_unanswered_themes
  FROM (
    SELECT
      ua.reason,
      ua.error_code,
      ua.status,
      count(*)::integer AS cnt
    FROM public.staff_assistant_unanswered ua
    WHERE ua.created_at >= v_since
    GROUP BY ua.reason, ua.error_code, ua.status
  ) u;

  -- 3. Thumbs-down themes (grouped by report_kind and tool_used, no individual staff text)
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'theme', td.theme,
        'report_kind', td.report_kind,
        'tool_used', td.tool_used,
        'count', td.cnt
      )
      ORDER BY td.cnt DESC
    ),
    '[]'::jsonb
  )
  INTO v_thumbs_down_themes
  FROM (
    SELECT
      CASE
        WHEN f.comment ILIKE '%slow%' OR f.comment ILIKE '%timeout%' THEN 'latency_or_timeout'
        WHEN f.comment ILIKE '%number%' OR f.comment ILIKE '%figure%' OR f.comment ILIKE '%wrong%' OR f.comment ILIKE '%off%' THEN 'figure_mismatch'
        WHEN f.comment ILIKE '%missing%' OR f.comment ILIKE '%not found%' THEN 'missing_coverage'
        WHEN coalesce(f.report_kind, 'rating') = 'problem_report' THEN 'problem_report'
        ELSE 'general_thumbs_down'
      END AS theme,
      coalesce(f.report_kind, 'rating') AS report_kind,
      coalesce(m.tools_called[1], 'none') AS tool_used,
      count(*)::integer AS cnt
    FROM public.staff_assistant_feedback f
    LEFT JOIN public.staff_assistant_messages m ON m.id = f.message_id
    WHERE f.rating = -1
      AND f.created_at >= v_since
    GROUP BY 1, 2, 3
  ) td;

  -- 4. Cost & latency summary
  SELECT jsonb_build_object(
    'total_questions', count(*)::integer,
    'total_cost_usd', coalesce(round(sum(ll.cost_usd)::numeric, 6), 0),
    'avg_cost_per_question_usd', coalesce(round(avg(ll.cost_usd)::numeric, 6), 0),
    'avg_latency_ms', coalesce(round(avg(ll.latency_ms))::integer, 0),
    'fast_tier_count', count(*) FILTER (WHERE ll.model_tier = 'fast')::integer,
    'deep_tier_count', count(*) FILTER (WHERE ll.model_tier = 'deep')::integer,
    'thumbs_down_rate_pct', CASE
      WHEN count(*) > 0 THEN round((count(*) FILTER (WHERE ll.feedback_rating = -1)::numeric / count(*)::numeric) * 100, 1)
      ELSE 0
    END
  )
  INTO v_cost_summary
  FROM public.staff_assistant_learning_log ll
  WHERE ll.created_at >= v_since;

  -- 5. Redacted Review Queue (thumbs-down, problem reports, and unanswered items;
  --    redacts phones, emails, and UUIDs; never exposes staff identity or assistant figures)
  WITH queue_items AS (
    SELECT
      f.id AS item_id,
      'feedback'::text AS source_kind,
      regexp_replace(
        regexp_replace(
          coalesce(um.content, '[question not recorded]'),
          '(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}',
          '[redacted-phone]',
          'g'
        ),
        '\m[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\M',
        '[redacted-email]',
        'g'
      ) AS redacted_question,
      coalesce(am.tools_called[1], 'none') AS tool_used,
      coalesce(am.outcome, 'answered') AS outcome,
      regexp_replace(
        coalesce(f.comment, ''),
        '(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}',
        '[redacted-phone]',
        'g'
      ) AS redacted_comment,
      coalesce(f.report_kind, 'rating') AS report_kind,
      EXISTS (
        SELECT 1
        FROM public.staff_assistant_eval_candidates ec
        WHERE ec.source_kind = 'feedback'
          AND ec.source_id = f.id
      ) AS added_to_tests,
      f.created_at
    FROM public.staff_assistant_feedback f
    LEFT JOIN public.staff_assistant_messages am ON am.id = f.message_id
    LEFT JOIN LATERAL (
      SELECT m2.content
      FROM public.staff_assistant_messages m2
      WHERE m2.conversation_id = f.conversation_id
        AND m2.role = 'user'
        AND m2.created_at <= coalesce(am.created_at, f.created_at)
      ORDER BY m2.created_at DESC
      LIMIT 1
    ) um ON true
    WHERE f.rating = -1
      AND f.created_at >= v_since

    UNION ALL

    SELECT
      ua.id AS item_id,
      'unanswered'::text AS source_kind,
      regexp_replace(
        regexp_replace(
          coalesce(ua.question_text, ''),
          '(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}',
          '[redacted-phone]',
          'g'
        ),
        '\m[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\M',
        '[redacted-email]',
        'g'
      ) AS redacted_question,
      'none'::text AS tool_used,
      ua.reason AS outcome,
      coalesce(ua.review_note, '') AS redacted_comment,
      'unanswered'::text AS report_kind,
      EXISTS (
        SELECT 1
        FROM public.staff_assistant_eval_candidates ec
        WHERE ec.source_kind = 'unanswered'
          AND ec.source_id = ua.id
      ) AS added_to_tests,
      ua.created_at
    FROM public.staff_assistant_unanswered ua
    WHERE ua.created_at >= v_since
  )
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', q.item_id,
        'source_kind', q.source_kind,
        'redacted_question', left(q.redacted_question, 280),
        'tool_used', q.tool_used,
        'outcome', q.outcome,
        'redacted_comment', left(q.redacted_comment, 240),
        'report_kind', q.report_kind,
        'added_to_tests', q.added_to_tests,
        'created_at', q.created_at
      )
      ORDER BY q.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_review_queue
  FROM (
    SELECT * FROM queue_items ORDER BY created_at DESC LIMIT 50
  ) q;

  -- 6. Promoted evaluation set items
  SELECT coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ec.id,
        'source_kind', ec.source_kind,
        'source_id', ec.source_id,
        'cleaned_question', ec.cleaned_question,
        'expected_topic', ec.expected_topic,
        'expected_tool', ec.expected_tool,
        'reviewer_notes', ec.reviewer_notes,
        'created_at', ec.created_at
      )
      ORDER BY ec.created_at DESC
    ),
    '[]'::jsonb
  )
  INTO v_eval_candidates
  FROM (
    SELECT *
    FROM public.staff_assistant_eval_candidates
    WHERE is_active = true
    ORDER BY created_at DESC
    LIMIT 50
  ) ec;

  RETURN jsonb_build_object(
    'ok', true,
    'source', 'staff_assistant_weekly_manager_learning_view',
    'days', v_days,
    'privacy_guarantee', 'no_individual_staff_identity_or_second_text_copy',
    'top_topics', v_top_topics,
    'unanswered_themes', v_unanswered_themes,
    'thumbs_down_themes', v_thumbs_down_themes,
    'cost_summary', v_cost_summary,
    'review_queue', v_review_queue,
    'eval_candidates', v_eval_candidates
  );
END;
$$;

REVOKE ALL ON FUNCTION public.staff_assistant_weekly_manager_learning_view(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.staff_assistant_weekly_manager_learning_view(integer) TO authenticated, service_role;
