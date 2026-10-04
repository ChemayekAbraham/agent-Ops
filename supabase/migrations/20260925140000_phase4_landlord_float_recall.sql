-- Phase 4 — the 24-hour landlord-float recall
--
-- Spec: docs/rent-plan-new-flow-full-report.md section 8, Phase 4 (items 18-22),
-- plus defect D8 from .claude/skills/welile-chart-of-accounts/references/open-defects.md,
-- which HAD to be fixed here rather than later: without it every automatic
-- cancellation strands the access and registration fee in A3 against L7.
--
-- NOTHING IS BACKFILLED. The recall applies only to float funded from
-- landlord_float_recall_go_live() onward. 38 allocations worth 11,390,000 are
-- already idle, some since 2026-05-15, disbursed when no such rule existed.
-- Auto-cancelling those would end 38 tenants' Rent Plans with no warning to
-- agents who were never told a deadline applied. They are tracked and alerted
-- for a human to work through, and never acted on automatically.

-- ---------------------------------------------------------------------------
-- D8. Reverse the fee recognition when a plan is cancelled
--
-- Funding posts, via recognise_funding_treasury:
--     DR A3  bridge   fee_receivable_created     (access + registration fee)
--     CR L7  platform treasury_fee_recognised
--
-- cancel_tenant_and_return_landlord_float reversed the PRINCIPAL only, so the
-- fee stayed on the books as a receivable against a plan that no longer exists,
-- with the matching credit parked in L7 for ever. One closed plan already
-- carries 119,000 that way; with an automatic recall it becomes routine, at
-- roughly 100,000 per cancelled 250,000 plan.
--
-- This is the exact mirror: DR L7 / CR A3, balanced on base mapping alone.
-- That last part matters — both categories are treasury categories, so
-- trg_enforce_ledger_group_mapped_balance RAISES on them rather than logging.
-- Verified against a real plan: DR L7 119,000 / CR A3 119,000.
--
-- Netted against anything already drawn down by repayments (those legs hang off
-- agent_collections, not rent_requests, so they join through the receipt) and
-- against any previous reversal, so it is safe on a plan that repaid something
-- and safe to call twice.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reverse_funding_treasury(p_rent_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_recognised numeric := 0;
  v_drawn      numeric := 0;
  v_reversed   numeric := 0;
  v_net        numeric := 0;
  v_grp        uuid;
BEGIN
  IF p_rent_request_id IS NULL THEN
    RETURN jsonb_build_object('status','skipped','reason','no_plan');
  END IF;

  SELECT COALESCE(SUM(gl.amount),0) INTO v_recognised
  FROM public.general_ledger gl
  WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
    AND gl.source_table='rent_requests' AND gl.source_id = p_rent_request_id
    AND gl.direction='cash_out';

  IF v_recognised <= 0 THEN
    RETURN jsonb_build_object('status','nothing_recognised');
  END IF;

  SELECT COALESCE(SUM(gl.amount),0) INTO v_drawn
  FROM public.general_ledger gl
  JOIN public.agent_collections c ON c.id = gl.source_id
  WHERE gl.category='treasury_fee_drawdown' AND gl.ledger_scope='platform'
    AND gl.source_table='agent_collections'
    AND c.rent_request_id = p_rent_request_id;

  SELECT COALESCE(SUM(gl.amount),0) INTO v_reversed
  FROM public.general_ledger gl
  WHERE gl.category='treasury_fee_recognised' AND gl.ledger_scope='platform'
    AND gl.source_table='rent_requests' AND gl.source_id = p_rent_request_id
    AND gl.direction='cash_in';

  v_net := v_recognised - v_drawn - v_reversed;

  IF v_net <= 0 THEN
    RETURN jsonb_build_object('status','nothing_to_reverse',
      'recognised', v_recognised, 'drawn_down', v_drawn, 'already_reversed', v_reversed);
  END IF;

  SELECT public.create_ledger_transaction(
    entries := jsonb_build_array(
      jsonb_build_object('direction','cash_out','amount',v_net,'category','fee_receivable_created',
        'ledger_scope','bridge','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Fee receivable reversed — Rent Plan cancelled before the landlord was paid'),
      jsonb_build_object('direction','cash_in','amount',v_net,'category','treasury_fee_recognised',
        'ledger_scope','platform','source_table','rent_requests','source_id',p_rent_request_id::text,
        'currency','UGX','transaction_date',now(),
        'description','Landlord Flow Treasury recognition reversed — Rent Plan cancelled')),
    idempotency_key := 'treasury-funding-reversal:'||p_rent_request_id::text) INTO v_grp;

  RETURN jsonb_build_object('status','reversed','amount',v_net,
    'recognised',v_recognised,'drawn_down',v_drawn,'transaction_group_id',v_grp);
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_funding_treasury(uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 20. Let a cron cancel, and stop the cancel path silently failing
--
-- Two changes to cancel_tenant_and_return_landlord_float, applied as anchored
-- patches against the live definition rather than a retyped copy — the function
-- is 7.5k of money-moving logic and transcription is how that gets broken. Each
-- patch RAISES if its anchor has moved, so drift fails loudly.
--
--   (a) A cron has no auth.uid(). It may now act by naming a system actor in a
--       transaction-local GUC. A logged-in session can never reach that branch
--       because auth.uid() is non-null there.
--
--   (b) agent_tenant_float_reversals.original_transaction_group is NOT NULL
--       with no default, and the INSERT never supplied it. Every cancel of a
--       plan that still had float to return died on that constraint — the table
--       holds exactly one row, and only 4 plans have ever reached `cancelled`.
--       The CFO's own cancel button has been broken all along. It now records
--       the funding group being reversed, falling back to the reversal group so
--       the column can never be null again.
--
--   (c) The fee reversal above is called before the plan is cancelled.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE src text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='cancel_tenant_and_return_landlord_float';

  IF src IS NULL THEN RAISE EXCEPTION 'cancel_tenant_and_return_landlord_float not found'; END IF;

  IF position('  v_is_system  boolean := false;' in src) > 0 THEN
    RAISE NOTICE 'already patched, skipping';
    RETURN;
  END IF;

  IF position('  v_reason     text;' in src) = 0 THEN RAISE EXCEPTION 'anchor 1 missing'; END IF;
  src := replace(src, '  v_reason     text;',
                      '  v_reason     text;'||chr(10)||
                      '  v_is_system  boolean := false;'||chr(10)||
                      '  v_fee_rev    jsonb;');

  src := replace(src,
    '  IF v_caller IS NULL THEN
    RAISE EXCEPTION ''AUTH_REQUIRED''',
    '  IF v_caller IS NULL THEN
    v_caller := NULLIF(current_setting(''app.system_actor'', true), '''')::uuid;
    v_is_system := v_caller IS NOT NULL;
  END IF;

  IF v_caller IS NULL THEN
    RAISE EXCEPTION ''AUTH_REQUIRED''');

  src := replace(src, '  IF NOT (public.has_role(v_caller,''cfo''::app_role)',
                      '  IF NOT v_is_system AND NOT (public.has_role(v_caller,''cfo''::app_role)');

  src := replace(src, '  -- ===== 2. Cancel the tenant =====',
'  BEGIN
    v_fee_rev := public.reverse_funding_treasury(p_rent_request_id);
  EXCEPTION WHEN OTHERS THEN
    v_fee_rev := jsonb_build_object(''status'',''error'',''message'',SQLERRM);
    RAISE WARNING ''reverse_funding_treasury failed for %: %'', p_rent_request_id, SQLERRM;
  END;

  -- ===== 2. Cancel the tenant =====');

  src := replace(src, '        v_group, v_alloc.remaining_amount, 0,',
    '        COALESCE(
          (SELECT gl.transaction_group_id FROM public.general_ledger gl
            WHERE gl.source_table = ''rent_requests'' AND gl.source_id = p_rent_request_id
              AND gl.category = ''rent_disbursement'' AND gl.direction = ''cash_out''
            ORDER BY gl.created_at ASC LIMIT 1),
          v_group),
        v_group, v_alloc.remaining_amount, 0,');

  src := replace(src,
    '        agent_id, rent_request_id, landlord_id, landlord_name,
        reversal_transaction_group, amount, commission_clawback, reason',
    '        agent_id, rent_request_id, landlord_id, landlord_name,
        original_transaction_group, reversal_transaction_group, amount, commission_clawback, reason');

  src := replace(src, '      ''reversal_transaction_groups'', to_jsonb(v_groups)',
                      '      ''reversal_transaction_groups'', to_jsonb(v_groups),
      ''fee_recognition_reversal'', v_fee_rev,
      ''actor_kind'', CASE WHEN v_is_system THEN ''system'' ELSE ''user'' END');

  src := replace(src, '    ''houses_freed'', v_freed
  );',
                      '    ''houses_freed'', v_freed,
    ''fee_recognition_reversal'', v_fee_rev
  );');

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.cancel_tenant_and_return_landlord_float(p_rent_request_id uuid, p_reason text)
     RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''public'' AS %L', src);
END
$do$;

-- ---------------------------------------------------------------------------
-- The go-live floor. Same pattern as rent_arrears_go_live().
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.landlord_float_recall_go_live()
RETURNS timestamptz LANGUAGE sql IMMUTABLE
AS $function$ SELECT timestamptz '2026-09-26 00:00:00+03' $function$;

COMMENT ON FUNCTION public.landlord_float_recall_go_live() IS
  'Float funded before this moment is never auto-recalled: the rule did not '
  'exist when it was disbursed. Tracked and alerted only, for a human to work.';

-- ---------------------------------------------------------------------------
-- 19. The alert table. Modelled on float_promise_alerts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.landlord_float_idle_alerts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id     uuid NOT NULL UNIQUE,
  rent_request_id   uuid NOT NULL,
  agent_id          uuid,
  agent_name        text,
  landlord_name     text,
  tenant_name       text,
  amount            numeric NOT NULL DEFAULT 0,
  funded_at         timestamptz NOT NULL,
  deadline_at       timestamptz NOT NULL,
  hours_outstanding numeric NOT NULL DEFAULT 0,
  severity          text NOT NULL DEFAULT 'reminder',
  payout_attempted  boolean NOT NULL DEFAULT false,
  outcome           text,
  acknowledged_at   timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.landlord_float_idle_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.landlord_float_idle_alerts FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS idx_lfia_open
  ON public.landlord_float_idle_alerts (severity, deadline_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lfia_plan
  ON public.landlord_float_idle_alerts (rent_request_id);

COMMENT ON TABLE public.landlord_float_idle_alerts IS
  'Landlord float sitting in an agent wallet with the landlord still unpaid. '
  'severity: reminder (6h) -> warning (18h) -> overdue (24h). '
  'payout_attempted=true means the agent DID dispatch and it failed, which is '
  'escalated to FinOps and never auto-cancelled.';

-- ---------------------------------------------------------------------------
-- 19 + 21. The detector.
--
-- Three outcomes at the deadline, which is the whole point of the design:
--   * no payout ever dispatched  -> recall the float, cancel the plan
--   * a payout was dispatched or failed -> escalate, never auto-cancel. The
--     agent did their part; a merchant or telecom failure is not theirs to pay
--     for. This is the Patience Ruba shape: payout raised day one, OTP
--     verified, merchant failed, retried five days later. A blunt timer would
--     have cancelled that tenant on day two.
--   * funded before go-live -> surfaced, never acted on.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.detect_idle_landlord_float(p_system_actor uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  r             record;
  v_recalled    int := 0;
  v_escalated   int := 0;
  v_tracked     int := 0;
  v_pre_go_live int := 0;
  v_amount      numeric := 0;
  v_actor       uuid := COALESCE(p_system_actor,
                                 NULLIF(current_setting('app.system_actor', true), '')::uuid);
  v_res         jsonb;
BEGIN
  FOR r IN
    SELECT al.id AS allocation_id, al.rent_request_id, al.agent_id,
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
                      AND lp.status = 'failed') AS has_failed_payout
    FROM public.agent_landlord_float_allocations al
    JOIN public.rent_requests rr ON rr.id = al.rent_request_id
    LEFT JOIN public.profiles ap  ON ap.id = al.agent_id
    LEFT JOIN public.profiles tp  ON tp.id = rr.tenant_id
    LEFT JOIN public.landlords ll ON ll.id = al.landlord_id
    WHERE al.status IN ('open','partially_paid')
      AND rr.status = 'funded'
      AND COALESCE(al.paid_out_amount, 0) = 0
      AND al.created_at < now() - interval '6 hours'
  LOOP
    v_tracked := v_tracked + 1;

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

    IF r.hrs >= 24 THEN
      IF r.ever_dispatched OR r.has_failed_payout THEN
        UPDATE public.landlord_float_idle_alerts
           SET outcome = 'escalated_payout_attempted', updated_at = now()
         WHERE allocation_id = r.allocation_id
           AND outcome IS DISTINCT FROM 'escalated_payout_attempted';

        INSERT INTO public.system_events (event_type, user_id, related_entity_type, related_entity_id, metadata)
        VALUES ('landlord_float_idle_escalated', r.agent_id, 'rent_request', r.rent_request_id,
          jsonb_build_object('severity','high','allocation_id',r.allocation_id,
            'amount',r.amount,'hours_outstanding',r.hrs,'landlord_name',r.landlord_name,
            'reason','Payout was dispatched or failed — needs FinOps, not an automatic recall.'));
        v_escalated := v_escalated + 1;

      ELSIF r.funded_at < public.landlord_float_recall_go_live() THEN
        UPDATE public.landlord_float_idle_alerts
           SET outcome = 'pre_go_live_manual_review', updated_at = now()
         WHERE allocation_id = r.allocation_id
           AND outcome IS DISTINCT FROM 'pre_go_live_manual_review';
        v_pre_go_live := v_pre_go_live + 1;

      ELSE
        BEGIN
          PERFORM set_config('app.system_actor', COALESCE(v_actor::text, ''), true);
          v_res := public.cancel_tenant_and_return_landlord_float(
                     r.rent_request_id,
                     format('Automatic recall: landlord %s was not paid within 24 hours of funding.',
                            COALESCE(r.landlord_name,'')));
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
    'go_live',public.landlord_float_recall_go_live());
END;
$function$;

REVOKE ALL ON FUNCTION public.detect_idle_landlord_float(uuid) FROM public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 18 + 22. Two more lists on the notices RPC: the 6h/18h agent nudges, and the
-- tenant's cancellation notice. Quiet hours (22:00-06:00 Kampala) are enforced
-- here, in one place, because landlord payouts are blocked then anyway.
-- Applied as an anchored patch for the same reason as the cancel function.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE src text; anchor text;
BEGIN
  SELECT p.prosrc INTO src FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname='rent_plan_transition_notices_pending';

  IF position('agent_nudge' in src) > 0 THEN RAISE NOTICE 'already patched'; RETURN; END IF;

  anchor := '  )' || chr(10) || '  SELECT jsonb_build_object(' || chr(10) || '    ''as_of'', now(),';
  IF position(anchor in src) = 0 THEN RAISE EXCEPTION 'anchor missing'; END IF;

  src := replace(src, anchor,
'  ),
  quiet AS (
    SELECT (EXTRACT(HOUR FROM (now() AT TIME ZONE ''Africa/Kampala'')) < 6
         OR EXTRACT(HOUR FROM (now() AT TIME ZONE ''Africa/Kampala'')) >= 22) AS is_quiet
  ),
  nudge AS (
    SELECT jsonb_agg(jsonb_build_object(
      ''kind'', CASE WHEN a.severity=''warning'' THEN ''agent_warning'' ELSE ''agent_reminder'' END,
      ''rent_request_id'',a.rent_request_id,''agent_id'',a.agent_id,''agent_phone'',ap.phone,
      ''agent_name'',a.agent_name,''landlord_name'',a.landlord_name,''tenant_name'',a.tenant_name,
      ''amount'',a.amount,''deadline_at'',a.deadline_at,''severity'',a.severity,
      ''hours_left'', GREATEST(0, round(EXTRACT(EPOCH FROM (a.deadline_at - now()))/3600.0, 1))
    ) ORDER BY a.deadline_at) AS rows
    FROM public.landlord_float_idle_alerts a
    JOIN public.profiles ap ON ap.id = a.agent_id
    CROSS JOIN quiet
    WHERE a.resolved_at IS NULL
      AND NOT quiet.is_quiet
      AND a.severity IN (''reminder'',''warning'')
      AND a.funded_at >= public.landlord_float_recall_go_live()
      AND COALESCE(btrim(ap.phone),'''') <> ''''
      AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                       WHERE s.idempotency_key = ''rent-plan-''||a.severity||'':''||a.rent_request_id::text)
  ),
  cancelled AS (
    SELECT jsonb_agg(jsonb_build_object(
      ''kind'',''tenant_cancelled'',''rent_request_id'',a.rent_request_id,
      ''tenant_id'',rr.tenant_id,''tenant_phone'',tp.phone,
      ''tenant_first_name'',split_part(btrim(COALESCE(tp.full_name,'''')),'' '',1),
      ''rent_amount'',rr.rent_amount,''landlord_name'',a.landlord_name
    ) ORDER BY a.resolved_at) AS rows
    FROM public.landlord_float_idle_alerts a
    JOIN public.rent_requests rr ON rr.id = a.rent_request_id
    JOIN public.profiles tp ON tp.id = rr.tenant_id
    WHERE a.outcome = ''auto_recalled''
      AND rr.status = ''cancelled''
      AND COALESCE(btrim(tp.phone),'''') <> ''''
      AND NOT EXISTS (SELECT 1 FROM public.sms_delivery_log s
                       WHERE s.idempotency_key = ''rent-plan-t2:''||a.rent_request_id::text)
  )
  SELECT jsonb_build_object(
    ''as_of'', now(),
    ''agent_nudge'',      COALESCE((SELECT rows FROM nudge), ''[]''::jsonb),
    ''tenant_cancelled'', COALESCE((SELECT rows FROM cancelled), ''[]''::jsonb),');

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.rent_plan_transition_notices_pending(p_lookback_hours integer DEFAULT 48)
     RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''public'' AS %L', src);
END
$do$;

-- Cron, registered in production as jobid 41658:
--   select cron.schedule('detect-idle-landlord-float', '*/15 * * * *',
--                        $cron$ select public.detect_idle_landlord_float(); $cron$);
-- The notices drain (jobid 41650, every 10 minutes) carries the new messages.
