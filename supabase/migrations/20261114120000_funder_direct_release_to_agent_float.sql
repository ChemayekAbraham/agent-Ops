-- Funder direct release to the assigned agent's landlord float.
--
-- Flow, in plain words:
--   1. A partner with enough operational float confirms a Rent Plan.
--   2. funder_support_tenant_direct still creates the commitment and the
--      pending portfolio (same idempotency key, same rent + 2% Welile Cover).
--   3. When pipeline_switches.key = 'funder_direct_release' is ON, that same
--      transaction calls _approve_pending_portfolio_core as the funder.
--      The core is the old approve_pending_portfolio body: partner float debit
--      (supporter_rent_fund, key psm-commit-<commitment>), Cover fee
--      (self_support_pay_proxy_fee, key ssfee-<commitment>), rent-only landlord
--      float (psm_disburse_landlord_float, key psm-float-<line>), funded_at,
--      and the existing agent and landlord notices.
--   4. Partner Ops is not asked, and a failure does not leave the plan in the
--      Partner Ops queue: the whole transaction rolls back.
--   5. The switch is inserted OFF. Rollback is turning it OFF. New funding
--      then waits for Partner Ops again, because approve_pending_portfolio
--      stays the same wrapper with the is_partner_ops check.
--
-- Receivable mode (balance short) is unchanged: it still writes
-- landlord_float_receivables and a pending portfolio. When a later float
-- credit lands and the switch is ON, _funder_direct_release_covered_receivables
-- calls the same core. It does not touch the seven portfolios already waiting
-- on 11 Nov 2026. Those are released only by
-- supabase/scripts/release_pending_partner_portfolios.sql.
--
-- A frozen, held, suspended, or below-target agent does not stop the release.
-- The fact is written to funder_direct_release_flags and, when the agent has
-- a verified parent, a row is queued in notifications.
--
-- This file is not applied to the live database by the pull request.

-- ---------------------------------------------------------------------------
-- Switch. Default OFF.
-- ---------------------------------------------------------------------------
INSERT INTO public.pipeline_switches (key, is_on, note)
SELECT 'funder_direct_release', false,
       'When ON, a partner with enough float releases rent straight to the assigned agent landlord float. No Partner Ops approval and no CFO approval. OFF restores the Partner Ops queue. Receivable mode still waits until the deposit lands, then uses the same release.'
WHERE NOT EXISTS (
  SELECT 1 FROM public.pipeline_switches s WHERE s.key = 'funder_direct_release'
);

-- ---------------------------------------------------------------------------
-- Flags. Staff can read them. Only the definer functions write them.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.funder_direct_release_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests (id),
  agent_id uuid,
  allocation_id uuid REFERENCES public.agent_landlord_float_allocations (id),
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT funder_direct_release_flags_reason_chk CHECK (
    reason IN (
      'agent_frozen',
      'agent_suspended',
      'agent_held',
      'below_weekly_target',
      'unpaid_6h'
    )
  )
);

COMMENT ON TABLE public.funder_direct_release_flags IS
  'Direct partner releases that went through even though the agent was frozen, held, suspended, or under the weekly collection target, plus partner_self_funding allocations still unpaid after 6 hours. The release itself is not blocked.';

CREATE INDEX IF NOT EXISTS funder_direct_release_flags_request_idx
  ON public.funder_direct_release_flags (rent_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS funder_direct_release_flags_agent_idx
  ON public.funder_direct_release_flags (agent_id, created_at DESC)
  WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS funder_direct_release_flags_alloc_reason_uidx
  ON public.funder_direct_release_flags (allocation_id, reason)
  WHERE allocation_id IS NOT NULL;

ALTER TABLE public.funder_direct_release_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS funder_direct_release_flags_staff_read ON public.funder_direct_release_flags;
CREATE POLICY funder_direct_release_flags_staff_read
  ON public.funder_direct_release_flags
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.has_internal_staff_role((SELECT auth.uid())))
    OR (SELECT public.has_role((SELECT auth.uid()), 'cfo'::public.app_role))
  );

DROP POLICY IF EXISTS mfa_required_for_staff ON public.funder_direct_release_flags;
CREATE POLICY mfa_required_for_staff
  ON public.funder_direct_release_flags
  AS RESTRICTIVE
  FOR ALL
  TO authenticated
  USING ((SELECT public.staff_mfa_ok()))
  WITH CHECK ((SELECT public.staff_mfa_ok()));

REVOKE ALL ON public.funder_direct_release_flags FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.funder_direct_release_flags TO authenticated;
GRANT ALL ON public.funder_direct_release_flags TO service_role;

CREATE INDEX IF NOT EXISTS funder_pending_self_managed_open_idx
  ON public.funder_pending_portfolios (funder_id, created_at)
  WHERE status = 'pending' AND source = 'self_managed';

-- ---------------------------------------------------------------------------
-- Note a risky agent without ever stopping the money.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._funder_direct_release_note(
  p_rent_request_id uuid,
  p_agent_id uuid,
  p_allocation_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_elig jsonb;
  v_pass boolean;
  v_reason text;
  v_parent uuid;
  v_key text;
  v_plain text;
BEGIN
  IF p_rent_request_id IS NULL OR p_agent_id IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    v_elig := public._agent_eligibility(p_agent_id);
  EXCEPTION WHEN OTHERS THEN
    v_elig := NULL;
  END;

  IF COALESCE((v_elig->>'eligible')::boolean, true) IS NOT TRUE
     OR EXISTS (
       SELECT 1 FROM public.profiles p
        WHERE p.id = p_agent_id AND p.is_frozen IS TRUE
     ) THEN
    INSERT INTO public.funder_direct_release_flags (rent_request_id, agent_id, allocation_id, reason)
    VALUES (p_rent_request_id, p_agent_id, p_allocation_id, 'agent_frozen')
    ON CONFLICT (allocation_id, reason) WHERE allocation_id IS NOT NULL DO NOTHING;
  END IF;

  BEGIN
    IF public.is_agent_frozen(p_agent_id) THEN
      INSERT INTO public.funder_direct_release_flags (rent_request_id, agent_id, allocation_id, reason)
      VALUES (p_rent_request_id, p_agent_id, p_allocation_id, 'agent_suspended')
      ON CONFLICT (allocation_id, reason) WHERE allocation_id IS NOT NULL DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM public.user_roles ur
     WHERE ur.user_id = p_agent_id
       AND ur.role = 'agent'::public.app_role
       AND ur.enabled IS FALSE
  ) THEN
    INSERT INTO public.funder_direct_release_flags (rent_request_id, agent_id, allocation_id, reason)
    VALUES (p_rent_request_id, p_agent_id, p_allocation_id, 'agent_held')
    ON CONFLICT (allocation_id, reason) WHERE allocation_id IS NOT NULL DO NOTHING;
  END IF;

  BEGIN
    SELECT w.passes INTO v_pass
      FROM public.agent_payout_weekly_performance(p_agent_id) w;
    IF v_pass IS FALSE THEN
      INSERT INTO public.funder_direct_release_flags (rent_request_id, agent_id, allocation_id, reason)
      VALUES (p_rent_request_id, p_agent_id, p_allocation_id, 'below_weekly_target')
      ON CONFLICT (allocation_id, reason) WHERE allocation_id IS NOT NULL DO NOTHING;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Parent agent, when one is verified. notifications is the in-app queue.
  FOR v_reason, v_plain IN
    SELECT f.reason,
           CASE f.reason
             WHEN 'agent_frozen' THEN 'frozen or under the collection eligibility rule'
             WHEN 'agent_suspended' THEN 'suspended'
             WHEN 'agent_held' THEN 'held'
             WHEN 'below_weekly_target' THEN 'under the weekly collection target'
             ELSE f.reason
           END
      FROM public.funder_direct_release_flags f
     WHERE f.allocation_id = p_allocation_id
       AND f.reason <> 'unpaid_6h'
  LOOP
    FOR v_parent IN
      SELECT DISTINCT s.parent_agent_id
        FROM public.agent_subagents s
       WHERE s.sub_agent_id = p_agent_id
         AND s.status = 'verified'
         AND s.parent_agent_id IS NOT NULL
    LOOP
      v_key := 'funder-direct-flag-' || p_allocation_id::text || '-' || v_reason;
      IF NOT EXISTS (
        SELECT 1 FROM public.notifications n
         WHERE n.user_id = v_parent AND n.event_key = v_key
      ) THEN
        INSERT INTO public.notifications (user_id, title, message, type, event_key, metadata)
        VALUES (
          v_parent,
          'Landlord float released to your agent',
          'A Rent Plan was released to your agent, who is ' || v_plain || '. The rent was still released. The agent pays the landlord within 24 hours.',
          'float',
          v_key,
          jsonb_build_object(
            'notice', 'funder_direct_release_flag',
            'rent_request_id', p_rent_request_id,
            'allocation_id', p_allocation_id,
            'agent_id', p_agent_id,
            'reason', v_reason
          )
        );
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public._funder_direct_release_note(uuid, uuid, uuid) IS
  'Records frozen, held, suspended, and below-target agents after a direct release. Never raises into the money transaction.';

-- ---------------------------------------------------------------------------
-- The old approve body, without the Partner Ops gate.
-- approve_pending_portfolio remains the gated wrapper.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._approve_pending_portfolio_core(
  p_portfolio_id uuid,
  p_actor uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := p_actor;
  v_status text;
  v_pending public.funder_pending_portfolios%ROWTYPE;
  v_entries jsonb;
  v_group uuid;
  v_ref text;
  v_already boolean := false;
  v_float jsonb;
  v_pool jsonb;
  v_fee jsonb;
  v_direct boolean := coalesce(current_setting('app.funder_direct_release', true), '') = 'on';
  v_prev_owner text := current_setting('psm.owner_release', true);
  v_line record;
BEGIN
  -- Busy stops the float-credit trigger from calling this again while the
  -- ledger rows of this same release are being inserted.
  PERFORM set_config('app.funder_direct_release_busy', 'on', true);
  -- psm_disburse_landlord_float allows the caller when psm.owner_release is on.
  -- Direct release runs as the funder, who is not a Partner Ops reviewer.
  IF v_direct THEN
    PERFORM set_config('psm.owner_release', 'on', true);
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'ACTOR_REQUIRED';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('approve-pending-portfolio-' || p_portfolio_id::text));

  SELECT status INTO v_status FROM public.investor_portfolios WHERE id = p_portfolio_id FOR UPDATE;
  IF v_status IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;

  IF v_status = 'active' AND EXISTS (
      SELECT 1 FROM public.funder_pending_portfolios
       WHERE portfolio_id = p_portfolio_id AND status = 'approved'
  ) THEN
    IF v_direct THEN
      PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);
    END IF;
    PERFORM set_config('app.funder_direct_release_busy', '', true);
    RETURN p_portfolio_id;
  END IF;

  -- awaiting_funder_deposit is a direct-release promise. It is not an approval queue.
  IF v_status NOT IN ('pending_ops_approval','awaiting_partner_details','awaiting_funder_deposit') THEN
    RAISE EXCEPTION 'INVALID_STATUS' USING HINT = v_status;
  END IF;

  SELECT * INTO v_pending FROM public.funder_pending_portfolios
   WHERE portfolio_id = p_portfolio_id AND status = 'pending' FOR UPDATE;

  -- Direct release never funds a Rent Plan that has no assigned agent.
  -- The debit has not happened yet, so this raise leaves no money moved.
  IF v_direct
     AND v_pending.id IS NOT NULL
     AND v_pending.source = 'self_managed'
     AND v_pending.commitment_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.partner_self_funding_lines l
         JOIN public.rent_requests rr ON rr.id = l.rent_request_id
        WHERE l.commitment_id = v_pending.commitment_id
          AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
     ) THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.investor_portfolios
     SET status = 'active',
         next_roi_date = COALESCE(next_roi_date, (now() + interval '30 days')::date),
         maturity_date = COALESCE(maturity_date, (now() + interval '12 months')::date)
   WHERE id = p_portfolio_id;

  IF v_pending.id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1 FROM public.general_ledger g
       WHERE g.ledger_scope = 'wallet'
         AND g.direction = 'cash_out'
         AND g.category IN ('partner_funding','supporter_rent_fund','portfolio_topup')
         AND (
              g.idempotency_key = 'portfolio-funding-' || p_portfolio_id::text
           OR g.idempotency_key = 'funder-pending-' || v_pending.id::text
           OR (v_pending.commitment_id IS NOT NULL
               AND g.idempotency_key = 'psm-commit-' || v_pending.commitment_id::text)
           OR (v_pending.commitment_id IS NOT NULL
               AND g.idempotency_key = 'psh-commit-' || v_pending.commitment_id::text)
           OR (g.source_table = 'investor_portfolios' AND g.source_id = p_portfolio_id)
           OR (v_pending.commitment_id IS NOT NULL
               AND g.source_table = 'partner_self_funding_lines'
               AND g.source_id IN (
                    SELECT l.id FROM public.partner_self_funding_lines l
                     WHERE l.commitment_id = v_pending.commitment_id))
           OR (v_pending.commitment_id IS NOT NULL
               AND g.source_table = 'partner_supported_houses'
               AND g.source_id IN (
                    SELECT s.id FROM public.partner_supported_houses s
                     WHERE s.commitment_id = v_pending.commitment_id))
         )
    ) INTO v_already;

    IF v_already THEN
      IF v_pending.source IN ('self_managed','self_managed_house')
         AND v_pending.commitment_id IS NOT NULL THEN
        UPDATE public.partner_self_commitments
           SET status = 'active', updated_at = now()
         WHERE id = v_pending.commitment_id;
      END IF;
    ELSIF v_pending.source = 'self_managed_house' THEN
      SELECT jsonb_agg(e) INTO v_entries FROM (
        SELECT jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', s.principal, 'direction', 'cash_out',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'description', 'Partner self-support operational funding for verified house (self_support_operational_house; float_usage=house_support_funding)'
        ) AS e
        FROM public.partner_supported_houses s WHERE s.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', s.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_supported_houses', 'source_id', s.id,
          'reference_id', s.house_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-support operational capital received for verified house (self_support_operational_house; float_usage=house_support_funding)'
        )
        FROM public.partner_supported_houses s WHERE s.commitment_id = v_pending.commitment_id
      ) sq;

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'psh-commit-' || v_pending.commitment_id::text
      );

      UPDATE public.partner_self_commitments
         SET status = 'active', ledger_group_id = v_group, updated_at = now()
       WHERE id = v_pending.commitment_id;
    ELSIF v_pending.source = 'self_managed' THEN
      SELECT jsonb_agg(e) INTO v_entries FROM (
        SELECT jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', l.principal, 'direction', 'cash_out',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', l.rent_request_id::text,
          'description', 'Self-managed partner funding approved (self_managed_partner; float_usage=self_portfolio_funding)'
        ) AS e
        FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_pending.commitment_id
        UNION ALL
        SELECT jsonb_build_object(
          'amount', l.principal, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'partner_self_funding_lines', 'source_id', l.id,
          'reference_id', l.rent_request_id::text,
          'linked_party', v_pending.funder_id::text,
          'description', 'Self-managed partner capital received (self_managed_partner; float_usage=self_portfolio_funding)'
        )
        FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_pending.commitment_id
      ) s;

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'psm-commit-' || v_pending.commitment_id::text
      );

      UPDATE public.partner_self_commitments
         SET status = 'active', ledger_group_id = v_group, updated_at = now()
       WHERE id = v_pending.commitment_id;
    ELSE
      v_ref := 'WRF' || to_char(now(), 'YYMMDD') || lpad((floor(random()*9000)+1000)::int::text, 4, '0');
      v_entries := jsonb_build_array(
        jsonb_build_object(
          'user_id', v_pending.funder_id, 'amount', v_pending.amount, 'direction', 'cash_out',
          'category', 'partner_funding', 'ledger_scope', 'wallet',
          'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
          'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
          'reference_id', v_ref,
          'linked_party', 'Rent Management Pool',
          'description', 'Partner rent pool funding approved by Partner Ops (rent_pool; float_usage=portfolio_funding)'
        ),
        jsonb_build_object(
          'amount', v_pending.amount, 'direction', 'cash_in',
          'category', 'partner_funding', 'ledger_scope', 'platform',
          'source_table', 'investor_portfolios', 'source_id', p_portfolio_id,
          'reference_id', v_ref,
          'linked_party', v_pending.funder_id::text,
          'description', 'Partner capital received into Rent Management Pool'
        )
      );

      v_group := public.create_ledger_transaction(
        entries := v_entries,
        idempotency_key := 'funder-pending-' || v_pending.id::text
      );
    END IF;

    UPDATE public.funder_pending_portfolios
       SET status = 'approved', reviewed_by = v_caller, reviewed_at = now(), updated_at = now()
     WHERE id = v_pending.id;
  END IF;

  IF v_pending.id IS NOT NULL AND v_pending.commitment_id IS NOT NULL
     AND v_pending.source IN ('self_managed', 'self_managed_house') THEN
    v_fee := public.self_support_pay_proxy_fee(v_pending.commitment_id);
  END IF;

  v_pool := public.landlord_pool_reserve(p_portfolio_id, NULL, 'approve_pending_portfolio');

  IF v_pending.id IS NOT NULL THEN
    IF v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL THEN
      v_float := public.psm_disburse_landlord_float(v_pending.commitment_id, NULL, NULL);
    END IF;
  END IF;

  IF v_direct AND v_pending.commitment_id IS NOT NULL AND v_pending.source = 'self_managed' THEN
    FOR v_line IN
      SELECT al.id AS allocation_id, al.agent_id, al.rent_request_id
        FROM public.agent_landlord_float_allocations al
        JOIN public.partner_self_funding_lines l ON l.rent_request_id = al.rent_request_id
       WHERE l.commitment_id = v_pending.commitment_id
         AND al.source = 'partner_self_funding'
         AND al.funded_by_partner_id = v_pending.funder_id
         AND al.status IN ('open', 'partially_paid')
    LOOP
      BEGIN
        PERFORM public._funder_direct_release_note(v_line.rent_request_id, v_line.agent_id, v_line.allocation_id);
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'funder direct release flag failed for plan %: %', v_line.rent_request_id, SQLERRM;
      END;
    END LOOP;

    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (v_caller, 'funder_direct_release', 'investor_portfolios', p_portfolio_id::text,
      'funder_direct_release',
      'Partner float released straight to the agent landlord float',
      jsonb_build_object(
        'direct_release', true,
        'portfolio_id', p_portfolio_id,
        'commitment_id', v_pending.commitment_id,
        'actor_id', v_caller,
        'landlord_float', v_float
      ));
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_caller, 'approve_pending_portfolio', 'investor_portfolios', p_portfolio_id::text,
    'approve_pending_portfolio',
    CASE WHEN v_direct
         THEN 'Direct funder release activated the portfolio'
         ELSE 'Partner Ops verified and activated pending funder portfolio' END,
    jsonb_build_object('reason', CASE WHEN v_direct THEN 'funder_direct_release' ELSE 'ops_approved_pending_funder_portfolio' END,
                       'prev_status', v_status,
                       'ledger_group_id', v_group, 'already_funded', v_already,
                       'source', v_pending.source,
                       'landlord_float', v_float,
                       'landlord_pool', v_pool,
                       'proxy_fee', v_fee,
                       'direct_release', v_direct));

  IF v_direct THEN
    PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);
  END IF;
  PERFORM set_config('app.funder_direct_release_busy', '', true);
  RETURN p_portfolio_id;
END;
$$;

COMMENT ON FUNCTION public._approve_pending_portfolio_core(uuid, uuid) IS
  'Posts the pending portfolio: partner float debit, Welile Cover, and rent-only agent landlord float. Not granted to anon or authenticated. approve_pending_portfolio is the Partner Ops wrapper. Direct release calls this as the funder.';

CREATE OR REPLACE FUNCTION public.approve_pending_portfolio(p_portfolio_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT public.is_partner_ops(v_caller) THEN RAISE EXCEPTION 'NOT_AUTHORIZED'; END IF;
  RETURN public._approve_pending_portfolio_core(p_portfolio_id, v_caller);
END;
$$;

COMMENT ON FUNCTION public.approve_pending_portfolio(uuid) IS
  'Partner Ops wrapper. The money movement lives in _approve_pending_portfolio_core.';

-- ---------------------------------------------------------------------------
-- Direct support. Float mode releases immediately when the switch is ON.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.funder_support_tenant_direct(
  p_rent_request_ids uuid[],
  p_promised_deposit_date date DEFAULT NULL::date,
  p_term_months integer DEFAULT 1
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_total numeric := 0;
  v_capacity numeric;
  v_mode text;
  v_res jsonb;
  v_key text;
  v_commitment uuid;
  v_portfolio uuid;
  v_receivables integer := 0;
  v_released boolean := false;
  v_port_status text;
BEGIN
  IF v_uid IS NULL OR NOT public.psm_is_partner(v_uid) THEN
    RAISE EXCEPTION 'Not authorised for direct tenant support' USING ERRCODE = '42501';
  END IF;
  IF p_rent_request_ids IS NULL OR array_length(p_rent_request_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'No plans supplied';
  END IF;

  -- A plan with no assigned agent is not fundable. Checked before any claim
  -- or commitment is confirmed by this function.
  IF EXISTS (
    SELECT 1
      FROM public.rent_requests rr
     WHERE rr.id = ANY (p_rent_request_ids)
       AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
  ) THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_key := 'psmd-' || v_uid::text || '-' || md5(array_to_string(p_rent_request_ids, ','));

  -- Second tap: the first call already created the commitment and may already
  -- have spent the float. Replay that result instead of asking for a deposit.
  IF EXISTS (
    SELECT 1 FROM public.partner_self_commitments c
     WHERE c.partner_id = v_uid AND c.idempotency_key = v_key
  ) THEN
    v_res := public.psm_confirm_commitment_for(
      v_uid, p_rent_request_ids, p_term_months, v_key, v_uid, NULL, 'float'
    );
    v_commitment := (v_res->>'commitment_id')::uuid;
    SELECT fp.portfolio_id, ip.status
      INTO v_portfolio, v_port_status
      FROM public.funder_pending_portfolios fp
      JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
     WHERE fp.commitment_id = v_commitment
     ORDER BY fp.created_at DESC
     LIMIT 1;

    IF public._pipeline_switch_on('funder_direct_release')
       AND v_portfolio IS NOT NULL
       AND v_port_status IN ('pending_ops_approval', 'awaiting_partner_details')
       AND NOT EXISTS (
         SELECT 1 FROM public.landlord_float_receivables r
          WHERE r.commitment_id = v_commitment AND r.status = 'outstanding'
       ) THEN
      PERFORM set_config('app.funder_direct_release', 'on', true);
      PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);
      v_released := true;
    ELSIF v_port_status = 'active' THEN
      v_released := true;
    END IF;

    RETURN v_res || jsonb_build_object(
      'funding_mode', CASE WHEN v_released THEN 'float' ELSE 'replay' END,
      'portfolio_id', v_portfolio,
      'status', CASE WHEN v_released THEN 'active' ELSE COALESCE(v_port_status, v_res->>'status') END,
      'awaiting_ops_approval', NOT v_released,
      'landlord_float_released', v_released,
      'idempotent_replay', true
    );
  END IF;

  SELECT COALESCE(SUM(public.self_support_gross(p.funding_amount)), 0) INTO v_total
    FROM public.v_partner_self_fundable_plans p
   WHERE p.rent_request_id = ANY (p_rent_request_ids);

  v_capacity := public.funder_support_capacity(v_uid);

  IF v_total > 0 AND v_capacity >= v_total THEN
    v_mode := 'float';
  ELSE
    v_mode := 'receivable';
    IF p_promised_deposit_date IS NULL THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_REQUIRED'
        USING HINT = 'Choose the date you will deposit this amount into your wallet.',
              ERRCODE = 'check_violation';
    END IF;
    IF p_promised_deposit_date < CURRENT_DATE THEN
      RAISE EXCEPTION 'DEPOSIT_DATE_IN_PAST' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  PERFORM public.psm_release_cancelled_idempotency(v_uid, v_key);

  v_res := public.psm_confirm_commitment_for(
    v_uid, p_rent_request_ids, p_term_months,
    v_key,
    v_uid, NULL, v_mode
  );

  v_commitment := (v_res->>'commitment_id')::uuid;
  v_portfolio := NULLIF(v_res->>'portfolio_id', '')::uuid;

  IF COALESCE((v_res->>'idempotent_replay')::boolean, false) THEN
    RETURN v_res || jsonb_build_object('funding_mode', v_mode, 'portfolio_id', v_portfolio);
  END IF;

  IF v_mode = 'receivable' THEN
    -- Unchanged: nothing is released here. The deposit-credit trigger calls
    -- the core once the float actually covers this portfolio and the switch is ON.
    INSERT INTO public.landlord_float_receivables (
      funder_id, commitment_id, rent_request_id, landlord_id, landlord_name,
      tenant_id, agent_id, amount, promised_deposit_date, notes
    )
    SELECT v_uid, v_commitment, l.rent_request_id, rr.landlord_id, ld.name,
           rr.tenant_id, COALESCE(rr.assigned_agent_id, rr.agent_id), l.principal,
           p_promised_deposit_date,
           'Funder supported the tenant directly with no wallet balance; deposit promised'
      FROM public.partner_self_funding_lines l
      JOIN public.rent_requests rr ON rr.id = l.rent_request_id
      LEFT JOIN public.landlords ld ON ld.id = rr.landlord_id
     WHERE l.commitment_id = v_commitment
    ON CONFLICT DO NOTHING;

    v_receivables := (SELECT COUNT(*) FROM public.landlord_float_receivables
                       WHERE commitment_id = v_commitment AND status = 'outstanding');

    -- Switch ON: this promise is not a Partner Ops or CFO approval. The float
    -- credit trigger releases it through the core when the deposit lands.
    IF public._pipeline_switch_on('funder_direct_release') AND v_portfolio IS NOT NULL THEN
      UPDATE public.investor_portfolios
         SET status = 'awaiting_funder_deposit'
       WHERE id = v_portfolio
         AND status IN ('pending_ops_approval', 'awaiting_partner_details');
    END IF;

    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
              'Funder pledged direct landlord float with a promised deposit date',
              jsonb_build_object('amount', v_total, 'promised_deposit_date', p_promised_deposit_date,
                                 'receivable_lines', v_receivables, 'funding_mode', 'receivable'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    RETURN v_res || jsonb_build_object(
      'funding_mode', 'receivable',
      'receivable_lines', v_receivables,
      'promised_deposit_date', p_promised_deposit_date,
      'landlord_float_released', false,
      'awaiting_ops_approval', NOT public._pipeline_switch_on('funder_direct_release')
    );
  END IF;

  IF public._pipeline_switch_on('funder_direct_release') AND v_portfolio IS NOT NULL THEN
    PERFORM set_config('app.funder_direct_release', 'on', true);
    PERFORM public._approve_pending_portfolio_core(v_portfolio, v_uid);

    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
              'Funder direct release: rent moved to the agent landlord float',
              jsonb_build_object('amount', v_total, 'funding_mode', 'float',
                                 'portfolio_id', v_portfolio, 'status', 'active',
                                 'direct_release', true));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;

    PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_released_to_agent',
      'partner_self_commitments', v_commitment,
      jsonb_build_object('amount', v_total, 'funding_mode', 'float', 'portfolio_id', v_portfolio));

    RETURN v_res || jsonb_build_object(
      'funding_mode', 'float',
      'status', 'active',
      'awaiting_ops_approval', false,
      'from_withdrawable', 0,
      'from_float', v_total,
      'landlord_float_released', true,
      'available_balance', public.funder_float_available(v_uid)
    );
  END IF;

  -- Switch OFF: the historical Partner Ops queue. No money moves here.
  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'partner_self_commitments', v_commitment,
            'Funder submitted direct tenant support for Partner Ops vetting',
            jsonb_build_object('amount', v_total, 'funding_mode', v_mode,
                               'portfolio_id', v_portfolio, 'status', 'pending_ops_approval'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'direct_support_submitted_for_vetting',
    'partner_self_commitments', v_commitment,
    jsonb_build_object('amount', v_total, 'funding_mode', v_mode, 'portfolio_id', v_portfolio));

  RETURN v_res || jsonb_build_object(
    'funding_mode', v_mode,
    'status', 'pending_ops_approval',
    'awaiting_ops_approval', true,
    'from_withdrawable', 0,
    'from_float', 0,
    'landlord_float_released', false,
    'available_balance', public.funder_float_available(v_uid)
  );
END;
$$;

COMMENT ON FUNCTION public.funder_support_tenant_direct(uuid[], date, integer) IS
  'Partner confirms tenant Rent Plans. Float mode with funder_direct_release ON calls _approve_pending_portfolio_core in this same transaction. Receivable mode waits for the deposit. Plans with no assigned agent are refused.';

-- Hide plans with no assigned agent from the funder list. The dashboard reads
-- partner_self_list_fundable_plans, which reads this view.
CREATE OR REPLACE VIEW public.v_partner_self_fundable_plans AS
 SELECT rr.id AS rent_request_id,
    rr.rent_amount AS funding_amount,
    rr.rent_amount,
    rr.duration_days,
    rr.daily_repayment,
    rr.total_repayment,
    rr.number_of_payments,
    rr.house_category,
    rr.request_city,
    rr.house_image_urls,
    rr.created_at AS posted_at,
    COALESCE(rr.coo_reviewed_at, rr.approved_at) AS approved_at,
    (CURRENT_DATE + ((rr.duration_days || ' days'::text)::interval))::date AS projected_end_date,
        CASE
            WHEN COALESCE(rr.number_of_payments, 0) > 0 AND rr.duration_days > 0 AND (rr.duration_days::numeric / NULLIF(rr.number_of_payments, 0)::numeric) >= 6::numeric THEN 'weekly'::text
            ELSE 'daily'::text
        END AS repayment_cadence,
    split_part(COALESCE(NULLIF(btrim(tp.full_name), ''::text), 'Tenant'::text), ' '::text, 1) AS tenant_first_name,
    NULL::text AS tenant_avatar_url,
    COALESCE(NULLIF(btrim(lp.full_name), ''::text), NULLIF(btrim(ll.name), ''::text), NULLIF(btrim(ll2.name), ''::text), 'Landlord'::text) AS landlord_name,
    c.id AS active_claim_id,
    c.partner_id AS held_by,
    c.expires_at AS hold_expires_at,
    COALESCE(NULLIF(btrim(tp.full_name), ''::text), 'Tenant'::text) AS tenant_full_name,
    NULLIF(concat_ws(', '::text, NULLIF(btrim(tp.village), ''::text), NULLIF(btrim(COALESCE(tp.city, rr.request_city)), ''::text), NULLIF(btrim(tp.district), ''::text), NULLIF(btrim(tp.region), ''::text)), ''::text) AS tenant_location,
    NULLIF(btrim(tp.avatar_url), ''::text) IS NOT NULL AS tenant_has_photo,
    rr.request_latitude,
    rr.request_longitude,
    ( SELECT cand.v
           FROM ( VALUES (NULLIF(btrim(ll.phone), ''::text)), (NULLIF(btrim(ll.mobile_money_number), ''::text)), (NULLIF(btrim(ll2.phone), ''::text)), (NULLIF(btrim(ll2.mobile_money_number), ''::text)), (NULLIF(btrim(lp.phone), ''::text))) cand(v)
          WHERE cand.v IS NOT NULL AND "right"(regexp_replace(cand.v, '\D'::text, ''::text, 'g'::text), 9) IS DISTINCT FROM "right"(regexp_replace(COALESCE(tp.phone, ''::text), '\D'::text, ''::text, 'g'::text), 9)
         LIMIT 1) AS landlord_phone,
    COALESCE(NULLIF(btrim(lcp.name), ''::text), 'LC1 not recorded'::text) AS lc1_chairperson_name,
    NULLIF(btrim(xp.phone), ''::text) AS proxy_agent_phone,
    COALESCE(rr.funder_visible, true) AS funder_visible,
    NULLIF(btrim(tp.phone), ''::text) AS tenant_phone
   FROM public.rent_requests rr
     LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id
     LEFT JOIN public.profiles lp ON lp.id = rr.landlord_id
     LEFT JOIN public.landlords ll ON ll.id = rr.landlord_id
     LEFT JOIN public.landlords ll2 ON ll2.tenant_id = rr.tenant_id
     LEFT JOIN public.lc1_chairpersons lcp ON lcp.id = rr.lc1_id
     LEFT JOIN public.partner_self_plan_claims c ON c.rent_request_id = rr.id AND (c.status = ANY (ARRAY['held'::text, 'confirmed'::text])) AND (c.status = 'confirmed'::text OR c.expires_at > now())
     LEFT JOIN public.profiles xp ON xp.id = rr.proxy_agent_id
  WHERE rr.funded_at IS NULL AND rr.disbursed_at IS NULL AND rr.supporter_id IS NULL AND rr.self_funding_partner_id IS NULL AND rr.tenancy_status = 'active'::text AND rr.coo_reviewed_at IS NOT NULL AND rr.rent_amount >= 50000::numeric AND COALESCE(rr.funder_visible, true) = true AND (rr.status = ANY (ARRAY['pending'::text, 'approved'::text, 'agent_ops_approved'::text, 'tenant_ops_approved'::text, 'landlord_ops_approved'::text, 'agent_verified'::text, 'coo_approved'::text]))
    AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NOT NULL;

COMMENT ON VIEW public.v_partner_self_fundable_plans IS
  'Rent Plans a partner may fund. Plans with no assigned agent are excluded.';

-- ---------------------------------------------------------------------------
-- Receivable mode: when float is credited and the switch is ON, release.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._funder_direct_release_covered_receivables(p_funder uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_row record;
  v_cover numeric;
  v_n integer := 0;
BEGIN
  IF p_funder IS NULL OR NOT public._pipeline_switch_on('funder_direct_release') THEN
    RETURN 0;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('funder-direct-recv-' || p_funder::text));

  FOR v_row IN
    SELECT fp.portfolio_id, fp.commitment_id, fp.amount
      FROM public.funder_pending_portfolios fp
     WHERE fp.funder_id = p_funder
       AND fp.status = 'pending'
       AND fp.source = 'self_managed'
       AND EXISTS (
         SELECT 1 FROM public.landlord_float_receivables r
          WHERE r.commitment_id = fp.commitment_id
            AND r.status = 'outstanding'
       )
     ORDER BY fp.created_at
     FOR UPDATE
  LOOP
    IF EXISTS (
      SELECT 1
        FROM public.partner_self_funding_lines l
        JOIN public.rent_requests rr ON rr.id = l.rent_request_id
       WHERE l.commitment_id = v_row.commitment_id
         AND COALESCE(rr.assigned_agent_id, rr.agent_id) IS NULL
    ) THEN
      CONTINUE;
    END IF;

    -- funder_float_available already subtracts this pending hold. Add it back
    -- so the portfolio is judged against the float that just landed.
    v_cover := public.funder_float_available(p_funder) + COALESCE(v_row.amount, 0);
    IF v_cover < COALESCE(v_row.amount, 0) THEN
      CONTINUE;
    END IF;

    BEGIN
      PERFORM set_config('app.funder_direct_release', 'on', true);
      PERFORM public._approve_pending_portfolio_core(v_row.portfolio_id, p_funder);
      UPDATE public.landlord_float_receivables
         SET status = 'settled', settled_at = now(), updated_at = now()
       WHERE commitment_id = v_row.commitment_id
         AND status = 'outstanding';
      v_n := v_n + 1;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'funder direct receivable release skipped portfolio %: %', v_row.portfolio_id, SQLERRM;
    END;
  END LOOP;

  RETURN v_n;
END;
$$;

COMMENT ON FUNCTION public._funder_direct_release_covered_receivables(uuid) IS
  'After a float credit, releases this funder''s outstanding receivable Rent Plans through the core when funder_direct_release is ON. A failure here does not undo the deposit.';

CREATE OR REPLACE FUNCTION public._funder_direct_release_on_float_credit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF coalesce(current_setting('app.funder_direct_release_busy', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  IF NOT public._pipeline_switch_on('funder_direct_release') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.funder_pending_portfolios fp
      JOIN public.landlord_float_receivables r
        ON r.commitment_id = fp.commitment_id
       AND r.status = 'outstanding'
     WHERE fp.funder_id = NEW.user_id
       AND fp.status = 'pending'
       AND fp.source = 'self_managed'
  ) THEN
    RETURN NEW;
  END IF;

  BEGIN
    PERFORM public._funder_direct_release_covered_receivables(NEW.user_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'funder direct release after float credit failed for %: %', NEW.user_id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_funder_direct_release_on_float_credit ON public.general_ledger;
CREATE TRIGGER trg_funder_direct_release_on_float_credit
  AFTER INSERT ON public.general_ledger
  FOR EACH ROW
  WHEN (
    NEW.ledger_scope = 'wallet'
    AND NEW.direction = 'cash_in'
    AND NEW.wallet_bucket = 'float'
    AND NEW.user_id IS NOT NULL
  )
  EXECUTE FUNCTION public._funder_direct_release_on_float_credit();

-- ---------------------------------------------------------------------------
-- 6-hour unpaid flag. The existing 15-minute cron calls this function.
-- The 24-hour auto-recall below is unchanged.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_idle_landlord_float(p_system_actor uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r             record;
  v_recalled    int := 0;
  v_escalated   int := 0;
  v_tracked     int := 0;
  v_pre_go_live int := 0;
  v_reviewed    int := 0;
  v_unpaid_6h   int := 0;
  v_amount      numeric := 0;
  v_actor       uuid := COALESCE(p_system_actor,
                                 NULLIF(current_setting('app.system_actor', true), '')::uuid);
  v_res         jsonb;
BEGIN
  FOR r IN
    SELECT al.id AS allocation_id, al.rent_request_id, al.agent_id, al.source,
           ap.full_name AS agent_name,
           COALESCE(al.landlord_name, ll.name) AS landlord_name,
           tp.full_name AS tenant_name,
           al.allocated_amount AS amount,
           al.created_at AS funded_at,
           al.created_at + interval '24 hours' AS deadline_at,
           round(extract(epoch FROM (now() - al.created_at)) / 3600.0, 2) AS hrs,
           EXISTS (SELECT 1 FROM public.landlord_payouts lp
                    WHERE lp.rent_request_id = al.rent_request_id
                      AND (lp.status IN ('pending_merchant_payout','pending_finops_disbursement',
                                         'awaiting_agent_receipt','disbursed','completed')
                           OR lp.finops_disbursed_at IS NOT NULL
                           OR lp.disbursed_at IS NOT NULL)) AS ever_dispatched,
           EXISTS (SELECT 1 FROM public.landlord_payouts lp
                    WHERE lp.rent_request_id = al.rent_request_id
                      AND lp.status = 'failed') AS has_failed_payout,
           EXISTS (SELECT 1 FROM public.landlord_float_idle_alerts x
                    WHERE x.allocation_id = al.id AND x.resolved_at IS NOT NULL) AS human_closed
    FROM public.agent_landlord_float_allocations al
    JOIN public.rent_requests rr ON rr.id = al.rent_request_id
    LEFT JOIN public.profiles ap  ON ap.id = al.agent_id
    LEFT JOIN public.profiles tp  ON tp.id = rr.tenant_id
    LEFT JOIN public.landlords ll ON ll.id = al.landlord_id
    WHERE al.status IN ('open','partially_paid','return_pending')
      AND rr.status = 'funded'
      AND COALESCE(al.paid_out_amount, 0) = 0
      AND al.created_at < now() - interval '6 hours'
  LOOP
    v_tracked := v_tracked + 1;

    -- Partner float still unpaid at 6 hours. One flag per allocation.
    -- The 24-hour recall further down is not changed.
    IF r.source = 'partner_self_funding' THEN
      INSERT INTO public.funder_direct_release_flags (
        rent_request_id, agent_id, allocation_id, reason
      ) VALUES (
        r.rent_request_id, r.agent_id, r.allocation_id, 'unpaid_6h'
      )
      ON CONFLICT (allocation_id, reason) WHERE allocation_id IS NOT NULL DO NOTHING;
      IF FOUND THEN
        v_unpaid_6h := v_unpaid_6h + 1;
      END IF;
    END IF;

    INSERT INTO public.landlord_float_idle_alerts (
      allocation_id, rent_request_id, agent_id, agent_name, landlord_name,
      tenant_name, amount, funded_at, deadline_at, hours_outstanding, severity,
      payout_attempted
    ) VALUES (
      r.allocation_id, r.rent_request_id, r.agent_id, r.agent_name, r.landlord_name,
      r.tenant_name, r.amount, r.funded_at, r.deadline_at, r.hrs,
      CASE WHEN r.hrs >= 24 THEN 'overdue'
           WHEN r.hrs >= 18 THEN 'warning'
           ELSE 'reminder' END,
      r.ever_dispatched OR r.has_failed_payout
    )
    ON CONFLICT (allocation_id) DO UPDATE
      SET hours_outstanding = EXCLUDED.hours_outstanding,
          severity          = EXCLUDED.severity,
          payout_attempted  = EXCLUDED.payout_attempted,
          updated_at        = now();

    IF r.human_closed THEN
      v_reviewed := v_reviewed + 1;
      CONTINUE;
    END IF;

    IF r.hrs >= 24 THEN
      IF r.ever_dispatched OR r.has_failed_payout THEN
        UPDATE public.landlord_float_idle_alerts
           SET outcome = 'escalated_payout_attempted', updated_at = now()
         WHERE allocation_id = r.allocation_id
           AND resolved_at IS NULL
           AND outcome IS DISTINCT FROM 'escalated_payout_attempted';

        INSERT INTO public.notifications (user_id, title, message, type, metadata)
        VALUES (r.agent_id,
                'Landlord payout needs another attempt',
                format('The payout for %s has not gone through. Please retry it. There is no penalty - the float stays with you and your tenant is unaffected.',
                       COALESCE(r.landlord_name, 'the landlord')),
                'float',
                jsonb_build_object('notice','landlord_float_a5_inapp',
                                   'rent_request_id', r.rent_request_id,
                                   'allocation_id', r.allocation_id,
                                   'amount', r.amount));

        INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
        VALUES ('landlord_float_idle_escalated', r.agent_id, 'rent_request', r.rent_request_id,
          jsonb_build_object('severity','high','allocation_id',r.allocation_id,
            'amount',r.amount,'hours_outstanding',r.hrs,'landlord_name',r.landlord_name,
            'reason','Payout was dispatched or failed. It needs FinOps, not an automatic recall.'));
        v_escalated := v_escalated + 1;

      ELSIF r.funded_at < public.landlord_float_recall_go_live() THEN
        UPDATE public.landlord_float_idle_alerts
           SET outcome = 'pre_go_live_manual_review', updated_at = now()
         WHERE allocation_id = r.allocation_id
           AND resolved_at IS NULL
           AND outcome IS DISTINCT FROM 'pre_go_live_manual_review';
        v_pre_go_live := v_pre_go_live + 1;

      ELSE
        BEGIN
          PERFORM set_config('app.system_actor', COALESCE(v_actor::text, ''), true);
          PERFORM set_config('app.system_context', 'landlord_float_recall', true);
          v_res := public.cancel_tenant_and_return_landlord_float(
                     r.rent_request_id,
                     format('Automatic recall: landlord %s was not paid within 24 hours of funding.',
                            COALESCE(r.landlord_name,'')));
          INSERT INTO public.notifications (user_id, title, message, type, metadata)
          VALUES (r.agent_id,
                  'Landlord float returned',
                  format('The %s landlord float for %s was not paid out within 24 hours and has been returned. %s''s Rent Plan has been cancelled and can be submitted again.',
                         to_char(r.amount, 'FM999,999,999'),
                         COALESCE(r.landlord_name, 'the landlord'),
                         COALESCE(r.tenant_name, 'The tenant')),
                  'float',
                  jsonb_build_object('notice','landlord_float_a4_inapp',
                                     'rent_request_id', r.rent_request_id,
                                     'allocation_id', r.allocation_id,
                                     'amount', r.amount));

          UPDATE public.landlord_float_idle_alerts
             SET outcome = 'auto_recalled', resolved_at = now(), updated_at = now()
           WHERE allocation_id = r.allocation_id;
          v_recalled := v_recalled + 1;
          v_amount := v_amount + COALESCE((v_res->>'float_returned')::numeric, 0);
        EXCEPTION WHEN OTHERS THEN
          UPDATE public.landlord_float_idle_alerts
             SET outcome = 'recall_failed: '||SQLERRM, updated_at = now()
           WHERE allocation_id = r.allocation_id;
          RAISE WARNING 'auto recall failed for plan %: %', r.rent_request_id, SQLERRM;
        END;
      END IF;
    END IF;
  END LOOP;

  UPDATE public.landlord_float_idle_alerts a
     SET resolved_at = now(), outcome = COALESCE(a.outcome,'landlord_paid'), updated_at = now()
   WHERE a.resolved_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.agent_landlord_float_allocations al
        JOIN public.rent_requests rr ON rr.id = al.rent_request_id
        WHERE al.id = a.allocation_id
          AND al.status IN ('open','partially_paid')
          AND rr.status = 'funded'
          AND COALESCE(al.paid_out_amount,0) = 0);

  RETURN jsonb_build_object('status','ok','as_of',now(),
    'tracked',v_tracked,'auto_recalled',v_recalled,'float_returned',v_amount,
    'escalated',v_escalated,'pre_go_live_held',v_pre_go_live,
    'human_closed_skipped',v_reviewed,
    'unpaid_6h_flagged', v_unpaid_6h,
    'go_live',public.landlord_float_recall_go_live());
END;
$function$;

COMMENT ON FUNCTION public.detect_idle_landlord_float(uuid) IS
  'Every 15 minutes: flag partner_self_funding allocations unpaid for 6 hours, and keep the 24-hour auto-recall. The existing cron detect-idle-landlord-float already calls this. No second cron was added.';

-- ---------------------------------------------------------------------------
-- CFO / staff read of today's direct releases. Kampala day.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cfo_partner_released_today()
RETURNS TABLE (
  rent_request_id uuid,
  plan_label text,
  amount numeric,
  agent_name text,
  landlord_name text,
  allocation_status text,
  flags text[]
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'Africa/Kampala')::date;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_internal_staff_role(auth.uid()) THEN
    RAISE EXCEPTION 'NOT_AUTHORIZED' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    l.rent_request_id,
    COALESCE(NULLIF(btrim(rr.house_category), ''), 'Rent Plan')
      || CASE WHEN NULLIF(btrim(rr.request_city), '') IS NULL THEN ''
              ELSE ' in ' || btrim(rr.request_city) END AS plan_label,
    COALESCE(al.allocated_amount, l.rent_amount, l.principal) AS amount,
    COALESCE(NULLIF(btrim(ag.full_name), ''), 'Agent') AS agent_name,
    COALESCE(NULLIF(btrim(al.landlord_name), ''), NULLIF(btrim(ld.name), ''), 'Landlord') AS landlord_name,
    COALESCE(al.status, 'not_allocated') AS allocation_status,
    COALESCE((
      SELECT array_agg(DISTINCT f.reason ORDER BY f.reason)
        FROM public.funder_direct_release_flags f
       WHERE f.rent_request_id = l.rent_request_id
         AND (al.id IS NULL OR f.allocation_id IS NULL OR f.allocation_id = al.id)
    ), ARRAY[]::text[]) AS flags
  FROM public.audit_logs a
  JOIN public.funder_pending_portfolios fp
    ON fp.portfolio_id = a.record_id::uuid
  JOIN public.partner_self_funding_lines l
    ON l.commitment_id = fp.commitment_id
  JOIN public.rent_requests rr ON rr.id = l.rent_request_id
  LEFT JOIN LATERAL (
    SELECT al.allocated_amount, al.status, al.landlord_name, al.agent_id, al.landlord_id, al.id
      FROM public.agent_landlord_float_allocations al
     WHERE al.rent_request_id = l.rent_request_id
       AND al.source = 'partner_self_funding'
       AND al.funded_by_partner_id = fp.funder_id
     ORDER BY al.created_at DESC
     LIMIT 1
  ) al ON true
  LEFT JOIN public.profiles ag ON ag.id = COALESCE(al.agent_id, rr.assigned_agent_id, rr.agent_id)
  LEFT JOIN public.landlords ld ON ld.id = COALESCE(al.landlord_id, rr.landlord_id)
  WHERE a.action_type = 'funder_direct_release'
    AND (a.created_at AT TIME ZONE 'Africa/Kampala')::date = v_day
  ORDER BY a.created_at DESC, l.rent_request_id;
END;
$$;

COMMENT ON FUNCTION public.cfo_partner_released_today() IS
  'Today in Africa/Kampala: Rent Plans released by partners straight to agent landlord float. Staff only, including CFO. Read only.';

REVOKE ALL ON FUNCTION public._approve_pending_portfolio_core(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._funder_direct_release_note(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._funder_direct_release_covered_receivables(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._funder_direct_release_on_float_credit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._approve_pending_portfolio_core(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public._funder_direct_release_covered_receivables(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.cfo_partner_released_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cfo_partner_released_today() TO authenticated, service_role;

-- While direct release is ON, a promised deposit is not an approval item.
-- Partner Ops only sees portfolios that still need a person to approve.
CREATE OR REPLACE FUNCTION public.partner_ops_pending_portfolios()
 RETURNS TABLE(pending_id uuid, portfolio_id uuid, portfolio_code text, funder_id uuid, funder_name text, funder_email text, funder_phone text, amount numeric, source text, term_months integer, lines_count integer, created_at timestamp with time zone, waiting_days integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT fp.id, fp.portfolio_id, ip.portfolio_code, fp.funder_id,
         p.full_name, p.email, p.phone,
         fp.amount, fp.source, fp.term_months,
         COALESCE(c.lines_count, 0),
         fp.created_at,
         GREATEST(0, EXTRACT(DAY FROM (now() - fp.created_at))::int)
  FROM public.funder_pending_portfolios fp
  JOIN public.investor_portfolios ip ON ip.id = fp.portfolio_id
  LEFT JOIN public.profiles p ON p.id = fp.funder_id
  LEFT JOIN public.partner_self_commitments c ON c.id = fp.commitment_id
  WHERE fp.status = 'pending'
    AND public.is_partner_ops(auth.uid())
    AND NOT (
      public._pipeline_switch_on('funder_direct_release')
      AND fp.source = 'self_managed'
      AND (
        ip.status = 'awaiting_funder_deposit'
        OR EXISTS (
          SELECT 1 FROM public.landlord_float_receivables r
           WHERE r.commitment_id = fp.commitment_id
             AND r.status = 'outstanding'
        )
      )
    )
  ORDER BY fp.created_at ASC;
$function$;

COMMENT ON FUNCTION public.partner_ops_pending_portfolios() IS
  'Partner Ops approval queue. Direct-release promises (switch ON) are excluded. Float funding never stays here: it is released in the same transaction.';
