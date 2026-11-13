-- ============================================================================
-- Part 1: new objects for merchant-direct self-support.
-- ============================================================================

INSERT INTO public.pipeline_switches (key, is_on, note)
VALUES ('self_support_merchant_direct', false,
        'Self-support Rent Plans go straight to the merchant payout queue (landlord''s approved number); '
        || 'portfolio activates when the landlord is paid, Rent Profit Share from the next day; 48h refund. '
        || 'Empty houses are instant.')
ON CONFLICT (key) DO NOTHING;

-- A commitment whose money is debited and waiting for the merchant to pay the landlord.
ALTER TABLE public.partner_self_commitments DROP CONSTRAINT partner_self_commitments_status_check;
ALTER TABLE public.partner_self_commitments ADD CONSTRAINT partner_self_commitments_status_check
  CHECK (status = ANY (ARRAY['pending_ops_approval'::text, 'awaiting_landlord'::text, 'active'::text,
                             'matured'::text, 'cancelled'::text]));

-- One row per Rent Plan whose landlord a merchant pays straight from partner money.
CREATE TABLE public.self_support_landlord_payments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rent_request_id       uuid NOT NULL,
  landlord_payout_id    uuid UNIQUE,
  withdrawal_request_id uuid,
  agent_id              uuid NOT NULL,
  landlord_id           uuid NOT NULL,
  landlord_name         text,
  landlord_phone        text NOT NULL,
  amount                numeric NOT NULL CHECK (amount > 0),
  line_ids              uuid[] NOT NULL,
  commitment_ids        uuid[] NOT NULL,
  partner_ids           uuid[] NOT NULL,
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'paid', 'refunded')),
  expires_at            timestamptz NOT NULL,
  paid_at               timestamptz,
  earning_from          date,
  refunded_at           timestamptz,
  refund_reason         text,
  stuck_flagged_at      timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_sslp_live_plan ON public.self_support_landlord_payments (rent_request_id)
  WHERE status IN ('queued', 'paid');
CREATE INDEX ix_sslp_queued_expiry ON public.self_support_landlord_payments (expires_at) WHERE status = 'queued';
CREATE INDEX ix_sslp_agent ON public.self_support_landlord_payments (agent_id);
CREATE INDEX ix_sslp_partners ON public.self_support_landlord_payments USING gin (partner_ids);

ALTER TABLE public.self_support_landlord_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY sslp_read_own ON public.self_support_landlord_payments FOR SELECT TO authenticated
  USING ((select auth.uid()) = agent_id
         OR (select auth.uid()) = ANY (partner_ids)
         OR (select public.is_partner_ops((select auth.uid()))));
CREATE POLICY mfa_required_for_staff ON public.self_support_landlord_payments AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
REVOKE ALL ON public.self_support_landlord_payments FROM anon, authenticated;
GRANT SELECT ON public.self_support_landlord_payments TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.self_support_landlord_payments TO service_role;

-- One outbox for this flow's SMS and email (drained by notify-funder-release-sms with the release SMS).
CREATE TABLE public.self_support_notices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_type     text NOT NULL CHECK (ref_type IN ('landlord_payment', 'house_portfolio')),
  ref_id       uuid NOT NULL,
  event        text NOT NULL CHECK (event IN ('queued', 'paid', 'refunded', 'house_active')),
  audience     text NOT NULL CHECK (audience IN ('partner', 'agent', 'landlord')),
  recipient_id uuid NOT NULL,
  channel      text NOT NULL CHECK (channel IN ('sms', 'email')),
  to_address   text,
  subject      text,
  message      text NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'queued', 'skipped')),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_ssn_once UNIQUE (ref_id, event, audience, recipient_id, channel)
);
CREATE INDEX ix_ssn_pending_sms ON public.self_support_notices (created_at)
  WHERE status = 'pending' AND channel = 'sms';
ALTER TABLE public.self_support_notices ENABLE ROW LEVEL SECURITY;
CREATE POLICY mfa_required_for_staff ON public.self_support_notices AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
REVOKE ALL ON public.self_support_notices FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.self_support_notices TO service_role;

-- ---------------------------------------------------------------- helpers
CREATE OR REPLACE FUNCTION public._ssd_on() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT public._pipeline_switch_on('self_support_merchant_direct') $$;

-- Rent Profit Share starts the day after the landlord is paid (Kampala calendar).
CREATE OR REPLACE FUNCTION public._ssd_earning_date() RETURNS date
LANGUAGE sql STABLE SET search_path TO 'public' AS
$$ SELECT (now() AT TIME ZONE 'Africa/Kampala')::date + 1 $$;

-- 00:00 UTC (03:00 Kampala) on that date: the same calendar date in both zones,
-- so ::date in any session gives the earning date.
CREATE OR REPLACE FUNCTION public._ssd_day_start(p_day date) RETURNS timestamptz
LANGUAGE sql IMMUTABLE AS
$$ SELECT (p_day::timestamp AT TIME ZONE 'UTC') $$;

-- Keyed on our own table (only SECURITY DEFINER code writes it), never on a column a browser can set.
CREATE OR REPLACE FUNCTION public._ssd_payout_is_direct(p_landlord_payout_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT p_landlord_payout_id IS NOT NULL AND EXISTS (
     SELECT 1 FROM public.self_support_landlord_payments s WHERE s.landlord_payout_id = p_landlord_payout_id) $$;

-- True only inside _ssd_queue_plan while it inserts its own payout rows (transaction-local flag).
CREATE OR REPLACE FUNCTION public._ssd_inserting() RETURNS boolean
LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('app.ssd_payout_insert', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION public._ssd_wr_insert_is_direct(p_landlord_payout_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT public._ssd_inserting() AND public._ssd_payout_is_direct(p_landlord_payout_id) $$;

CREATE OR REPLACE FUNCTION public._ssd_momo_provider(p_phone text, p_title boolean DEFAULT false) RETURNS text
LANGUAGE sql IMMUTABLE AS
$$ SELECT CASE WHEN substr(right(regexp_replace(COALESCE(p_phone, ''), '\D', '', 'g'), 9), 1, 2) IN ('70', '74', '75')
               THEN CASE WHEN p_title THEN 'Airtel' ELSE 'airtel' END
               ELSE CASE WHEN p_title THEN 'MTN' ELSE 'mtn' END END $$;

CREATE OR REPLACE FUNCTION public._ssd_first(p_name text) RETURNS text
LANGUAGE sql IMMUTABLE AS
$$ SELECT NULLIF(initcap(split_part(btrim(COALESCE(p_name, '')), ' ', 1)), '') $$;

CREATE OR REPLACE FUNCTION public._ssd_portfolio_queued(p_portfolio_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.investor_portfolios WHERE id = p_portfolio_id AND status = 'awaiting_landlord_payment') $$;

CREATE OR REPLACE FUNCTION public._ssd_plan_queued(p_rent_request_id uuid, p_amount numeric DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT EXISTS (SELECT 1 FROM public.self_support_landlord_payments s
                   WHERE s.rent_request_id = p_rent_request_id AND s.status = 'queued'
                     AND (p_amount IS NULL OR s.amount = p_amount)) $$;

CREATE OR REPLACE FUNCTION public._ssd_payment_json(p_payment_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT jsonb_build_object(
     'id', s.id, 'status', s.status, 'rent_request_id', s.rent_request_id, 'amount', s.amount,
     'landlord_name', s.landlord_name, 'expires_at', s.expires_at, 'paid_at', s.paid_at,
     'earning_from', s.earning_from, 'refunded_at', s.refunded_at)
   FROM public.self_support_landlord_payments s WHERE s.id = p_payment_id $$;

CREATE OR REPLACE FUNCTION public._ssd_plan_result(p_rent_request_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT COALESCE((
     SELECT jsonb_build_object('merchant_direct', true, 'status', 'awaiting_landlord_payment',
                               'landlord_payment', public._ssd_payment_json(s.id),
                               'earning_starts', 'the day after the landlord is paid')
       FROM public.self_support_landlord_payments s
      WHERE s.rent_request_id = p_rent_request_id AND s.status = 'queued'), '{}'::jsonb) $$;

-- What funder_support_tenant_direct returns once the money is in the merchant queue.
CREATE OR REPLACE FUNCTION public._ssd_support_result(p_portfolio_id uuid, p_partner uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$$ SELECT jsonb_build_object(
     'funding_mode', 'float', 'status', 'awaiting_landlord_payment', 'merchant_direct', true,
     'awaiting_ops_approval', false, 'landlord_float_released', false,
     'from_withdrawable', 0, 'from_float', (SELECT investment_amount FROM public.investor_portfolios WHERE id = p_portfolio_id),
     'earning_starts', 'the day after the landlord is paid',
     'landlord_payments', COALESCE((
        SELECT jsonb_agg(public._ssd_payment_json(s.id) ORDER BY s.created_at)
          FROM public.self_support_landlord_payments s
         WHERE s.commitment_ids && ARRAY(SELECT fp.commitment_id FROM public.funder_pending_portfolios fp
                                          WHERE fp.portfolio_id = p_portfolio_id AND fp.commitment_id IS NOT NULL)), '[]'::jsonb),
     'available_balance', public.funder_float_available(p_partner)) $$;

-- The core references a partner's debit by plan id; general_ledger allows that once per partner and
-- plan (uq_general_ledger_reference_dedupe). A second support of the same plan after a refund uses the line.
CREATE OR REPLACE FUNCTION public._ssd_debit_ref(p_partner uuid, p_rent_request_id uuid, p_line_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS
$f$ SELECT CASE WHEN EXISTS (SELECT 1 FROM public.general_ledger g
                             WHERE g.user_id = p_partner AND g.category = 'supporter_rent_fund'
                               AND g.reference_id = p_rent_request_id::text AND g.direction = 'cash_out'
                               AND g.ledger_scope = 'wallet')
             THEN p_rent_request_id::text || ':' || left(p_line_id::text, 8)
             ELSE p_rent_request_id::text END $f$;

-- ---------------------------------------------------------------- outbox
-- SMS rows wait for the 1-minute batch dispatcher; email goes straight to the pgmq
-- email queue (itself an outbox), once. Never raises: a message must not undo money.
CREATE OR REPLACE FUNCTION public._ssd_notice(
  p_ref_type text, p_ref_id uuid, p_event text, p_audience text, p_recipient uuid,
  p_channel text, p_to text, p_message text, p_subject text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_id uuid; v_to text := NULLIF(btrim(COALESCE(p_to, '')), '');
BEGIN
  IF p_recipient IS NULL OR p_message IS NULL THEN RETURN; END IF;
  IF p_channel = 'sms' AND (v_to IS NULL OR length(regexp_replace(v_to, '\D', '', 'g')) < 9) THEN RETURN; END IF;
  IF p_channel = 'email' AND (v_to IS NULL OR v_to !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') THEN RETURN; END IF;

  INSERT INTO public.self_support_notices (ref_type, ref_id, event, audience, recipient_id, channel, to_address, subject, message,
                                           status)
  VALUES (p_ref_type, p_ref_id, p_event, p_audience, p_recipient, p_channel, v_to, p_subject, p_message,
          CASE WHEN p_channel = 'email' THEN 'queued' ELSE 'pending' END)
  ON CONFLICT ON CONSTRAINT ux_ssn_once DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL AND p_channel = 'email' THEN
    PERFORM public.enqueue_email('transactional_emails', jsonb_build_object(
      'message_id', v_id::text, 'to', v_to,
      'from', 'Welile Partnerships <partnership@welile.com>', 'sender_domain', 'notify.welile.com',
      'subject', COALESCE(p_subject, 'Welile'),
      'html', '<p>' || replace(replace(replace(p_message, '&', '&amp;'), '<', '&lt;'), '>', '&gt;') || '</p>',
      'text', p_message, 'purpose', 'transactional', 'label', 'self-support-' || p_event || '-' || p_audience,
      'idempotency_key', 'ssd:' || p_ref_id::text || ':' || p_event || ':' || p_audience || ':' || p_recipient::text,
      'queued_at', now()));
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'self-support notice % % % failed: %', p_ref_id, p_event, p_audience, SQLERRM;
END $$;

-- All messages for one landlord payment event, built from one read of the rows involved.
CREATE OR REPLACE FUNCTION public._ssd_notify(p_payment_id uuid, p_event text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  s public.self_support_landlord_payments%ROWTYPE;
  v_tenant text; v_landlord text; v_agent record; v_partner record; v_receipt text; v_partners text;
  v_amt text; v_from text; v_msg text;
BEGIN
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT COALESCE(public._ssd_first(tp.full_name), 'your tenant') INTO v_tenant
    FROM public.rent_requests rr LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id WHERE rr.id = s.rent_request_id;
  v_tenant := COALESCE(v_tenant, 'your tenant');
  v_landlord := COALESCE(NULLIF(btrim(s.landlord_name), ''), 'the landlord');
  SELECT p.id, public._ssd_first(p.full_name) AS first, NULLIF(btrim(p.phone), '') AS phone, NULLIF(btrim(p.email), '') AS email
    INTO v_agent FROM public.profiles p WHERE p.id = s.agent_id;
  SELECT string_agg(COALESCE(public._ssd_first(p.full_name), 'A partner'), ' and ') INTO v_partners
    FROM public.profiles p WHERE p.id = ANY (s.partner_ids);
  v_partners := COALESCE(v_partners, 'A partner');
  v_amt := 'UGX ' || public._co_support_fmt(s.amount);
  v_from := to_char(s.earning_from, 'FMDD Mon YYYY');
  IF p_event = 'paid' THEN
    SELECT r.receipt_number INTO v_receipt FROM public.landlord_payout_receipts r
     WHERE r.payout_id = s.landlord_payout_id ORDER BY r.created_at DESC LIMIT 1;
  END IF;

  -- partners: each gets their own half (sum of their own lines)
  FOR v_partner IN
    SELECT p.id, public._ssd_first(p.full_name) AS first, NULLIF(btrim(p.phone), '') AS phone,
           NULLIF(btrim(p.email), '') AS email, SUM(l.principal) AS mine
      FROM public.partner_self_funding_lines l JOIN public.profiles p ON p.id = l.partner_id
     WHERE l.id = ANY (s.line_ids)
     GROUP BY p.id, p.full_name, p.phone, p.email
  LOOP
    v_msg := CASE p_event
      WHEN 'queued' THEN 'WELILE: You supported ' || v_tenant || '''s Rent Plan with UGX ' || public._co_support_fmt(v_partner.mine)
        || '. A Welile merchant will pay the landlord ' || v_landlord || ' directly within 48 hours. '
        || 'Your Rent Profit Share starts the day after the landlord is paid.'
      WHEN 'paid' THEN 'WELILE: Landlord ' || v_landlord || ' has been paid ' || v_amt || ' for ' || v_tenant
        || '''s Rent Plan. Your Rent Profit Share starts on ' || v_from || '.'
      WHEN 'refunded' THEN 'WELILE: The landlord for ' || v_tenant || '''s Rent Plan could not be paid, so UGX '
        || public._co_support_fmt(v_partner.mine) || ' is back in your Welile float. Nothing was lost.'
    END;
    PERFORM public._ssd_notice('landlord_payment', s.id, p_event, 'partner', v_partner.id, 'sms', v_partner.phone, v_msg);
    PERFORM public._ssd_notice('landlord_payment', s.id, p_event, 'partner', v_partner.id, 'email', v_partner.email,
      replace(v_msg, 'WELILE: ', ''),
      CASE p_event WHEN 'queued' THEN 'Your rent support is with the merchant'
                   WHEN 'paid' THEN 'The landlord is paid: your Rent Profit Share starts ' || v_from
                   ELSE 'Your rent support is back in your float' END);
  END LOOP;

  -- agent: the merchant pays the landlord; the agent handles no money
  IF v_agent.id IS NOT NULL THEN
    v_msg := CASE p_event
      WHEN 'queued' THEN 'WELILE: ' || v_partners || ' supported ' || v_tenant || '''s rent of ' || v_amt
        || '. A Welile merchant will pay landlord ' || v_landlord || ' directly. You do not handle this money. '
        || 'We will text you the receipt when the landlord is paid.'
      WHEN 'paid' THEN 'WELILE: Landlord ' || v_landlord || ' has been paid ' || v_amt || ' for ' || v_tenant
        || COALESCE('. Receipt ' || v_receipt, '') || '. ' || v_tenant || ' starts repaying tomorrow.'
      WHEN 'refunded' THEN 'WELILE: The merchant could not pay landlord ' || v_landlord || ' for ' || v_tenant
        || ', so the partner''s money was returned. The Rent Plan is open for support again.'
    END;
    PERFORM public._ssd_notice('landlord_payment', s.id, p_event, 'agent', v_agent.id, 'sms', v_agent.phone, v_msg);
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'self-support notify % % failed: %', p_payment_id, p_event, SQLERRM;
END $$;

-- ---------------------------------------------------------------- queue (Rent Plans)
-- Called by the core when the switch is ON, for a self_managed Rent Plan portfolio.
-- Debits the partner once, marks everything waiting for the landlord, then queues
-- the payout for each plan whose halves are all debited.
CREATE OR REPLACE FUNCTION public._ssd_queue_commitment(p_portfolio_id uuid, p_pending_id uuid, p_actor uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_p public.funder_pending_portfolios%ROWTYPE;
  v_group uuid;
  v_entries jsonb;
  v_rr uuid;
BEGIN
  SELECT * INTO v_p FROM public.funder_pending_portfolios WHERE id = p_pending_id FOR UPDATE;
  PERFORM 1 FROM public.partner_self_commitments WHERE id = v_p.commitment_id FOR UPDATE;

  -- Same legs and key as the core's self_managed branch, so holds and integrity checks read it unchanged.
  IF NOT EXISTS (SELECT 1 FROM public.general_ledger g WHERE g.idempotency_key = 'psm-commit-' || v_p.commitment_id::text) THEN
    SELECT jsonb_agg(e) INTO v_entries FROM (
      SELECT jsonb_build_object(
        'user_id', v_p.funder_id, 'amount', l.principal, 'direction', 'cash_out',
        'category', 'supporter_rent_fund', 'ledger_scope', 'wallet',
        'recipient_type', 'operational_wallet', 'wallet_bucket', 'float',
        'source_table', 'partner_self_funding_lines', 'source_id', l.id,
        'reference_id', public._ssd_debit_ref(v_p.funder_id, l.rent_request_id, l.id),
        'description', 'Self-managed partner funding sent to the merchant payout queue (self_managed_partner; float_usage=self_portfolio_funding)'
      ) AS e
      FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_p.commitment_id AND l.status <> 'cancelled'
      UNION ALL
      SELECT jsonb_build_object(
        'amount', l.principal, 'direction', 'cash_in',
        'category', 'partner_funding', 'ledger_scope', 'platform',
        'source_table', 'partner_self_funding_lines', 'source_id', l.id,
        'reference_id', public._ssd_debit_ref(v_p.funder_id, l.rent_request_id, l.id), 'linked_party', v_p.funder_id::text,
        'description', 'Self-managed partner capital received (self_managed_partner; float_usage=self_portfolio_funding)'
      )
      FROM public.partner_self_funding_lines l WHERE l.commitment_id = v_p.commitment_id AND l.status <> 'cancelled'
    ) x;
    v_group := public.create_ledger_transaction(entries := v_entries,
                 idempotency_key := 'psm-commit-' || v_p.commitment_id::text);
  END IF;

  UPDATE public.funder_pending_portfolios
     SET status = 'approved', reviewed_by = p_actor, reviewed_at = now(),
         review_reason = 'Merchant-direct: landlord payout queued, no Partner Ops step', updated_at = now()
   WHERE id = v_p.id;

  PERFORM set_config('app.ss_system_release', 'on', true);
  UPDATE public.partner_self_commitments
     SET status = 'awaiting_landlord', ledger_group_id = COALESCE(v_group, ledger_group_id),
         payout_anchor_at = NULL, payout_day = NULL, next_payout_at = NULL, term_end_at = NULL, updated_at = now()
   WHERE id = v_p.commitment_id;
  PERFORM set_config('app.ss_system_release', '', true);

  -- Lines were made live at insert; nothing earns until the landlord is paid.
  UPDATE public.partner_self_funding_lines
     SET status = 'idle', live_at = NULL, term_end_at = NULL, updated_at = now()
   WHERE commitment_id = v_p.commitment_id AND status <> 'cancelled';

  -- trusted server flow: the owner-edit guard on investor_portfolios does not apply
  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  UPDATE public.investor_portfolios SET status = 'awaiting_landlord_payment' WHERE id = p_portfolio_id;
  PERFORM set_config('welile.portfolio_trusted', '', true);

  FOR v_rr IN SELECT DISTINCT rent_request_id FROM public.partner_self_funding_lines
               WHERE commitment_id = v_p.commitment_id AND status = 'idle' LOOP
    PERFORM public._ssd_queue_plan(v_rr);
  END LOOP;

  PERFORM public.psm_audit(p_actor, v_p.funder_id, 'merchant_direct_queued', 'partner_self_commitments', v_p.commitment_id,
    jsonb_build_object('portfolio_id', p_portfolio_id, 'ledger_group_id', v_group));
END $$;

-- One payout per plan, once every live half of it is debited (co-support: both).
CREATE OR REPLACE FUNCTION public._ssd_queue_plan(p_rent_request_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  v_lines uuid[]; v_commitments uuid[]; v_partners uuid[]; v_amount numeric;
  v_rr record; v_ld record; v_phone text; v_payment uuid; v_payout uuid; v_wr uuid; v_name text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('ssd-plan-' || p_rent_request_id::text));
  IF EXISTS (SELECT 1 FROM public.self_support_landlord_payments
              WHERE rent_request_id = p_rent_request_id AND status IN ('queued', 'paid')) THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines l
               JOIN public.partner_self_commitments c ON c.id = l.commitment_id
              WHERE l.rent_request_id = p_rent_request_id AND l.status <> 'cancelled'
                AND c.status <> 'awaiting_landlord') THEN
    RETURN NULL;  -- the other half is not debited yet
  END IF;

  SELECT array_agg(l.id ORDER BY l.created_at), array_agg(DISTINCT l.commitment_id),
         array_agg(DISTINCT l.partner_id), SUM(COALESCE(l.rent_amount, l.principal))
    INTO v_lines, v_commitments, v_partners, v_amount
    FROM public.partner_self_funding_lines l
   WHERE l.rent_request_id = p_rent_request_id AND l.status = 'idle';
  IF v_lines IS NULL OR v_amount IS NULL OR v_amount <= 0 THEN RETURN NULL; END IF;

  SELECT rr.id, rr.tenant_id, rr.landlord_id, COALESCE(rr.assigned_agent_id, rr.agent_id) AS agent_id
    INTO v_rr FROM public.rent_requests rr WHERE rr.id = p_rent_request_id;
  IF v_rr.agent_id IS NULL THEN
    RAISE EXCEPTION 'NO_AGENT_ASSIGNED: This Rent Plan has no assigned agent, so it cannot be funded.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT ld.id, ld.name, ld.verified, ld.verified_mobile_money_number INTO v_ld
    FROM public.landlords ld WHERE ld.id = v_rr.landlord_id;
  v_phone := NULLIF(btrim(COALESCE(v_ld.verified_mobile_money_number, '')), '');
  IF v_ld.id IS NULL OR v_ld.verified IS NOT TRUE OR v_phone IS NULL THEN
    RAISE EXCEPTION 'LANDLORD_NOT_READY: Welile has not yet approved this landlord''s payout number, so this Rent Plan cannot be supported right now. Nothing was taken from your wallet.'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Money never goes to a landlord through a restricted agent's plan.
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_rr.agent_id AND COALESCE(p.is_frozen, false))
     OR public.is_fraud_identifier_blocked('user_id', v_rr.agent_id::text) THEN
    RAISE EXCEPTION 'PLAN_AGENT_RESTRICTED: This Rent Plan cannot be supported right now. Nothing was taken from your wallet.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_name := COALESCE(NULLIF(btrim(v_ld.name), ''), 'Landlord');

  INSERT INTO public.self_support_landlord_payments (
    rent_request_id, agent_id, landlord_id, landlord_name, landlord_phone, amount,
    line_ids, commitment_ids, partner_ids, expires_at)
  VALUES (p_rent_request_id, v_rr.agent_id, v_ld.id, v_name, v_phone, v_amount,
          v_lines, v_commitments, v_partners, now() + interval '48 hours')
  RETURNING id INTO v_payment;

  PERFORM set_config('app.ssd_payout_insert', 'on', true);
  BEGIN
    INSERT INTO public.landlord_payouts (
      agent_id, landlord_id, tenant_id, rent_request_id, amount, landlord_phone, landlord_name,
      mobile_money_provider, otp_verified_at, status, metadata)
    VALUES (v_rr.agent_id, v_ld.id, v_rr.tenant_id, p_rent_request_id, v_amount, v_phone, v_name,
            public._ssd_momo_provider(v_phone, true), now(), 'pending_merchant_payout',
            jsonb_build_object('direct_partner', true, 'source', 'self_support_merchant_direct',
                               'ssd_payment_id', v_payment, 'line_ids', to_jsonb(v_lines),
                               'commitment_ids', to_jsonb(v_commitments), 'no_landlord_otp', true))
    RETURNING id INTO v_payout;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'LANDLORD_NOT_READY: Welile cannot pay this landlord yet (%), so this Rent Plan cannot be supported right now. Nothing was taken from your wallet.',
      SQLERRM USING ERRCODE = 'check_violation';
  END;
  UPDATE public.self_support_landlord_payments SET landlord_payout_id = v_payout WHERE id = v_payment;

  INSERT INTO public.withdrawal_requests (
    user_id, amount, status, payout_method, mobile_money_provider, mobile_money_number, mobile_money_name,
    reason, landlord_payout_id, landlord_block_exempt_at)
  VALUES (v_rr.agent_id, v_amount, 'pending', 'mobile_money', public._ssd_momo_provider(v_phone), v_phone, v_name,
          'Landlord float payout — ' || v_name || ' (' || v_phone || ')', v_payout, now())
  RETURNING id INTO v_wr;
  PERFORM set_config('app.ssd_payout_insert', '', true);

  UPDATE public.self_support_landlord_payments SET withdrawal_request_id = v_wr, updated_at = now() WHERE id = v_payment;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (auth.uid(), 'self_support_landlord_payout_queued', 'landlord_payouts', v_payout::text,
          'self_support_landlord_payout_queued', 'Partner money sent straight to the merchant payout queue',
          jsonb_build_object('ssd_payment_id', v_payment, 'withdrawal_request_id', v_wr, 'amount', v_amount,
                             'rent_request_id', p_rent_request_id, 'partners', to_jsonb(v_partners)));

  PERFORM public._ssd_notify(v_payment, 'queued');
  RETURN v_payment;
END $$;

-- ---------------------------------------------------------------- landlord paid
-- A commitment with nothing left waiting: pay the agent-care (proxy) fee once.
-- With nothing live left (every line refunded): close it.
CREATE OR REPLACE FUNCTION public._ssd_settle_commitment(p_commitment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_idle int; v_live int; v_refunded numeric;
BEGIN
  SELECT COUNT(*) FILTER (WHERE status = 'idle'), COUNT(*) FILTER (WHERE status IN ('active', 'completed')),
         COALESCE(SUM(principal) FILTER (WHERE status = 'cancelled' AND end_reason = 'landlord_not_paid'), 0)
    INTO v_idle, v_live, v_refunded
    FROM public.partner_self_funding_lines WHERE commitment_id = p_commitment_id;
  IF v_idle > 0 THEN RETURN; END IF;
  IF v_live > 0 THEN
    PERFORM public.self_support_pay_proxy_fee(p_commitment_id);
    -- a partly refunded commitment keeps only what is still placed
    IF v_refunded > 0 THEN
      UPDATE public.partner_self_commitments
         SET committed_amount = (SELECT SUM(principal) FROM public.partner_self_funding_lines
                                  WHERE commitment_id = p_commitment_id AND status IN ('active', 'completed')),
             lines_count = v_live, updated_at = now()
       WHERE id = p_commitment_id;
    END IF;
  ELSE
    UPDATE public.partner_self_commitments SET status = 'cancelled', updated_at = now()
     WHERE id = p_commitment_id AND status IN ('awaiting_landlord', 'active');
    -- free its replay key so the partner can support this plan again (same as psm_release_cancelled_idempotency)
    PERFORM public.psm_release_cancelled_idempotency(c.partner_id, c.idempotency_key)
       FROM public.partner_self_commitments c WHERE c.id = p_commitment_id AND c.idempotency_key IS NOT NULL;
    -- and the closed claims under that key (ux_pspc_idempotency covers closed claims too)
    UPDATE public.partner_self_plan_claims k
       SET idempotency_key = k.idempotency_key || '-void-' || left(k.id::text, 8), updated_at = now()
      FROM public.partner_self_commitments c
     WHERE c.id = p_commitment_id AND k.partner_id = c.partner_id
       AND k.idempotency_key = split_part(c.idempotency_key, '-void-', 1)
       AND k.status NOT IN ('held', 'confirmed');
    PERFORM set_config('welile.portfolio_trusted', 'on', true);
    UPDATE public.investor_portfolios ip SET status = 'cancelled'
      FROM public.funder_pending_portfolios fp
     WHERE fp.commitment_id = p_commitment_id AND ip.id = fp.portfolio_id
       AND ip.status = 'awaiting_landlord_payment';
    PERFORM set_config('welile.portfolio_trusted', '', true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public._ssd_activate(p_payment_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE
  s public.self_support_landlord_payments%ROWTYPE;
  v_day date := public._ssd_earning_date();
  v_ts timestamptz := public._ssd_day_start(public._ssd_earning_date());
  v_c record; v_l record; v_pid uuid; v_entry uuid; v_ref text;
BEGIN
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'queued' THEN RETURN; END IF;

  UPDATE public.self_support_landlord_payments
     SET status = 'paid', paid_at = now(), earning_from = v_day, updated_at = now()
   WHERE id = s.id;

  UPDATE public.partner_self_funding_lines
     SET status = 'active', live_at = v_ts,
         term_end_at = v_ts + (GREATEST(1, COALESCE(term_months, 1)) || ' months')::interval, updated_at = now()
   WHERE id = ANY (s.line_ids) AND status = 'idle';

  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  FOR v_c IN SELECT * FROM public.partner_self_commitments WHERE id = ANY (s.commitment_ids) ORDER BY id FOR UPDATE LOOP
    IF v_c.status = 'awaiting_landlord' THEN
      UPDATE public.partner_self_commitments
         SET status = 'active', payout_anchor_at = v_ts, payout_day = EXTRACT(DAY FROM v_ts)::smallint,
             next_payout_at = v_ts + interval '1 month',
             term_end_at = v_ts + (GREATEST(1, COALESCE(v_c.term_months, public.psm_contract_term_months())) || ' months')::interval,
             updated_at = now()
       WHERE id = v_c.id;
      FOR v_pid IN SELECT fp.portfolio_id FROM public.funder_pending_portfolios fp
                    WHERE fp.commitment_id = v_c.id AND fp.status = 'approved' LOOP
        UPDATE public.investor_portfolios
           SET status = 'active', next_roi_date = v_day + 30,
               maturity_date = (v_day + (GREATEST(1, COALESCE(v_c.term_months, 12)) || ' months')::interval)::date
         WHERE id = v_pid AND status = 'awaiting_landlord_payment';
        PERFORM public.landlord_pool_reserve(v_pid, NULL, 'ssd_landlord_paid');
      END LOOP;
    END IF;
    PERFORM public._ssd_settle_commitment(v_c.id);
  END LOOP;
  PERFORM set_config('welile.portfolio_trusted', '', true);

  -- Same platform legs psm_disburse_landlord_float posts, now at the moment the landlord is paid.
  FOR v_l IN SELECT l.id, l.partner_id, COALESCE(l.rent_amount, l.principal) AS rent
               FROM public.partner_self_funding_lines l WHERE l.id = ANY (s.line_ids) AND l.status = 'active' LOOP
    v_ref := 'PSF-' || upper(substr(replace(v_l.id::text, '-', ''), 1, 8));
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object('direction', 'cash_out', 'amount', v_l.rent, 'category', 'rent_disbursement',
          'ledger_scope', 'platform', 'source_table', 'partner_self_funding_lines', 'source_id', v_l.id,
          'reference_id', v_ref, 'user_id', s.agent_id, 'linked_party', v_l.partner_id::text,
          'description', 'Partner self-support rent paid to landlord ' || COALESCE(s.landlord_name, '') || ' by a merchant'),
        jsonb_build_object('direction', 'cash_in', 'amount', v_l.rent, 'category', 'rent_receivable_created',
          'ledger_scope', 'bridge', 'source_table', 'partner_self_funding_lines', 'source_id', v_l.id,
          'reference_id', v_ref, 'user_id', s.agent_id, 'linked_party', v_l.partner_id::text,
          'description', 'Rent receivable created (partner-funded, merchant paid the landlord) - ' || COALESCE(s.landlord_name, ''))),
      idempotency_key := 'psm-float-' || v_l.id::text);
    v_entry := NULL;
    SELECT e.id INTO v_entry FROM public.landlord_pool_entries e
     WHERE e.source_table = 'partner_self_funding_lines' AND e.source_id = v_l.id AND e.status = 'open' AND e.in_pool > 0;
    IF v_entry IS NOT NULL THEN
      PERFORM public.landlord_pool_deploy(s.rent_request_id, v_l.rent, 'self_support', NULL, v_entry, 'ssd_landlord_paid');
    END IF;
  END LOOP;

  -- funded now; trg_aa_start_repaying_on_landlord_paid (next) moves it to repaying from tomorrow
  UPDATE public.rent_requests
     SET status = 'funded', funded_at = COALESCE(funded_at, now()),
         self_funding_partner_id = COALESCE(self_funding_partner_id, s.partner_ids[1]),
         self_funding_line_id = COALESCE(self_funding_line_id, s.line_ids[1]), updated_at = now()
   WHERE id = s.rent_request_id
     AND status IN ('approved', 'coo_approved', 'pending', 'agent_ops_approved', 'tenant_ops_approved',
                    'landlord_ops_approved', 'agent_verified', 'cfo_approved');
  PERFORM public.recognise_funding_treasury(s.rent_request_id);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (auth.uid(), 'self_support_landlord_paid', 'self_support_landlord_payments', s.id::text,
          'self_support_landlord_paid', 'Merchant paid the landlord; partner portfolio active, earning from ' || v_day,
          jsonb_build_object('landlord_payout_id', s.landlord_payout_id, 'earning_from', v_day, 'amount', s.amount));
END $$;

-- ---------------------------------------------------------------- refund
CREATE OR REPLACE FUNCTION public._ssd_refund(p_payment_id uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE s public.self_support_landlord_payments%ROWTYPE; v_l record; v_c uuid; v_ws text;
BEGIN
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND OR s.status <> 'queued' THEN RETURN; END IF;

  -- Never refund money a merchant may already have sent. A withdrawal being settled (processing) or
  -- settled is held for Financial Ops; one still in the queue is cancelled first, so no merchant can
  -- settle it after the partner is refunded.
  SELECT status INTO v_ws FROM public.withdrawal_requests WHERE id = s.withdrawal_request_id FOR UPDATE;
  IF v_ws IN ('processing', 'completed', 'paid', 'disbursed') THEN
    UPDATE public.self_support_landlord_payments SET stuck_flagged_at = COALESCE(stuck_flagged_at, now()), updated_at = now()
     WHERE id = s.id;
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
    VALUES (auth.uid(), 'self_support_refund_held', 'self_support_landlord_payments', s.id::text,
            'self_support_refund_held', 'Landlord payout failed while its merchant withdrawal is ' || v_ws || ': not refunded, check with the merchant',
            jsonb_build_object('withdrawal_status', v_ws, 'reason', p_reason, 'landlord_payout_id', s.landlord_payout_id));
    RETURN;
  END IF;
  UPDATE public.withdrawal_requests
     SET status = 'cancelled', rejection_reason = COALESCE(rejection_reason, left(COALESCE(p_reason, 'Landlord payout failed'), 300)),
         updated_at = now()
   WHERE id = s.withdrawal_request_id AND status NOT IN ('cancelled', 'rejected');


  UPDATE public.self_support_landlord_payments
     SET status = 'refunded', refunded_at = now(), refund_reason = left(COALESCE(p_reason, 'not paid'), 300), updated_at = now()
   WHERE id = s.id;

  FOR v_l IN SELECT l.id, l.partner_id, l.principal, l.rent_request_id FROM public.partner_self_funding_lines l
              WHERE l.id = ANY (s.line_ids) AND l.status = 'idle' ORDER BY l.id FOR UPDATE LOOP
    PERFORM public.create_ledger_transaction(
      entries := jsonb_build_array(
        jsonb_build_object('user_id', v_l.partner_id, 'amount', v_l.principal, 'direction', 'cash_in',
          'category', 'supporter_rent_fund', 'ledger_scope', 'wallet', 'recipient_type', 'operational_wallet',
          'wallet_bucket', 'float', 'source_table', 'partner_self_funding_lines', 'source_id', v_l.id,
          'reference_id', v_l.rent_request_id::text || ':refund:' || left(v_l.id::text, 8),
          'description', 'Self-support returned to partner float: landlord not paid (' || left(COALESCE(p_reason, ''), 120) || ')'),
        jsonb_build_object('amount', v_l.principal, 'direction', 'cash_out', 'category', 'partner_funding',
          'ledger_scope', 'platform', 'source_table', 'partner_self_funding_lines', 'source_id', v_l.id,
          'reference_id', v_l.rent_request_id::text || ':refund:' || left(v_l.id::text, 8), 'linked_party', v_l.partner_id::text,
          'description', 'Partner capital returned: landlord not paid')),
      idempotency_key := 'ssd-refund-' || v_l.id::text);
    -- cancelling the line releases the plan (psm_release_plan_on_line_cancel, pair-aware)
    UPDATE public.partner_self_funding_lines
       SET status = 'cancelled', end_reason = 'landlord_not_paid', plan_closed_at = now(),
           proxy_fee_status = CASE WHEN proxy_fee_status = 'pending' THEN 'cancelled' ELSE proxy_fee_status END,
           updated_at = now()
     WHERE id = v_l.id;
  END LOOP;

  FOREACH v_c IN ARRAY s.commitment_ids LOOP
    PERFORM public._ssd_settle_commitment(v_c);
  END LOOP;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (auth.uid(), 'self_support_landlord_payment_refunded', 'self_support_landlord_payments', s.id::text,
          'self_support_landlord_payment_refunded', left(COALESCE(p_reason, 'not paid'), 300),
          jsonb_build_object('landlord_payout_id', s.landlord_payout_id, 'amount', s.amount, 'partners', to_jsonb(s.partner_ids)));
  PERFORM public._ssd_notify(s.id, 'refunded');
END $$;

-- ---------------------------------------------------------------- triggers on landlord_payouts
-- Runs FIRST among the paid triggers (name order), so the lines are live from tomorrow
-- before psm_activate_line_on_disbursement or start_repaying look at the plan.
CREATE OR REPLACE FUNCTION public.trg_ssd_landlord_payout_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_payment uuid;
BEGIN
  SELECT id INTO v_payment FROM public.self_support_landlord_payments
   WHERE landlord_payout_id = NEW.id AND status = 'queued';
  IF v_payment IS NULL THEN RETURN NEW; END IF;
  IF NEW.status IN ('awaiting_agent_receipt', 'completed') THEN
    PERFORM public._ssd_activate(v_payment);
  ELSIF NEW.status = 'failed' THEN
    PERFORM public._ssd_refund(v_payment, COALESCE(NEW.last_error, NEW.escalated_reason, 'Landlord payout failed'));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_a0_ssd_landlord_payout_status
  AFTER UPDATE OF status ON public.landlord_payouts FOR EACH ROW
  WHEN (NEW.status IN ('awaiting_agent_receipt', 'completed', 'failed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_ssd_landlord_payout_status();

-- Runs LAST, after the receipt (WLR-n) is issued, to message everyone.
CREATE OR REPLACE FUNCTION public.trg_ssd_landlord_paid_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_payment uuid;
BEGIN
  SELECT id INTO v_payment FROM public.self_support_landlord_payments
   WHERE landlord_payout_id = NEW.id AND status = 'paid';
  IF v_payment IS NOT NULL THEN
    PERFORM public._ssd_notify(v_payment, 'paid');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER zzzz_ssd_landlord_paid_notify
  AFTER UPDATE OF status ON public.landlord_payouts FOR EACH ROW
  WHEN (NEW.status IN ('awaiting_agent_receipt', 'completed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.trg_ssd_landlord_paid_notify();

-- ---------------------------------------------------------------- 48-hour expiry (cron)
-- Unclaimed and unpaid after 48h: take it out of the merchant queue and refund the partner.
-- Claimed but not settled: flag once for Financial Ops and leave it (a merchant may be mid-payment).
CREATE OR REPLACE FUNCTION public.ssd_expire_unpaid(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE s record; v_n int; v_refunded int := 0; v_stuck int := 0;
BEGIN
  -- Lock order matches the merchant paying (withdrawal -> payout -> payment), so the two never deadlock:
  -- no lock on the payment here; the refund trigger takes it and re-checks it is still queued.
  FOR s IN SELECT id, withdrawal_request_id, landlord_payout_id, stuck_flagged_at
             FROM public.self_support_landlord_payments
            WHERE status = 'queued' AND expires_at < now()
            ORDER BY expires_at LIMIT p_limit LOOP
    UPDATE public.withdrawal_requests
       SET status = 'cancelled', rejection_reason = 'Not paid within 48 hours: partner refunded', updated_at = now()
     WHERE id = s.withdrawal_request_id AND status = 'pending'
       AND assigned_cashout_agent_id IS NULL AND processed_at IS NULL;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n > 0 THEN
      UPDATE public.landlord_payouts
         SET status = 'failed', last_error = 'SELF_SUPPORT_48H: not paid within 48 hours, partner refunded', updated_at = now()
       WHERE id = s.landlord_payout_id AND status = 'pending_merchant_payout';
      v_refunded := v_refunded + 1;   -- trg_a0_ssd_landlord_payout_status refunds
    ELSIF s.stuck_flagged_at IS NULL THEN
      UPDATE public.self_support_landlord_payments SET stuck_flagged_at = now(), updated_at = now()
       WHERE id = s.id AND status = 'queued' AND stuck_flagged_at IS NULL;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n > 0 THEN
        INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
        VALUES (NULL, 'self_support_landlord_payment_stuck', 'self_support_landlord_payments', s.id::text,
                'self_support_landlord_payment_stuck', 'Over 48 hours and claimed by a merchant but not paid',
                jsonb_build_object('withdrawal_request_id', s.withdrawal_request_id, 'landlord_payout_id', s.landlord_payout_id));
        v_stuck := v_stuck + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('refunded', v_refunded, 'stuck_flagged', v_stuck);
END $$;

-- ---------------------------------------------------------------- houses: instant
CREATE OR REPLACE FUNCTION public._ssd_house_instant(p_portfolio_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp' AS $$
DECLARE v_partner uuid; v_term int; v_day date := public._ssd_earning_date(); v_msg text; v_p record;
BEGIN
  SELECT fp.funder_id, fp.term_months INTO v_partner, v_term
    FROM public.funder_pending_portfolios fp WHERE fp.portfolio_id = p_portfolio_id ORDER BY fp.created_at DESC LIMIT 1;
  IF v_partner IS NULL THEN RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND'; END IF;
  PERFORM set_config('app.ss_system_release', 'on', true);
  PERFORM set_config('welile.portfolio_trusted', 'on', true);
  PERFORM public._approve_pending_portfolio_core(p_portfolio_id, v_partner);
  UPDATE public.investor_portfolios
     SET next_roi_date = v_day + 30,
         maturity_date = (v_day + (GREATEST(1, COALESCE(v_term, 12)) || ' months')::interval)::date
   WHERE id = p_portfolio_id AND status = 'active';
  PERFORM set_config('welile.portfolio_trusted', '', true);
  PERFORM set_config('app.ss_system_release', '', true);

  SELECT p.id, NULLIF(btrim(p.phone), '') AS phone, NULLIF(btrim(p.email), '') AS email, ip.investment_amount
    INTO v_p FROM public.profiles p JOIN public.investor_portfolios ip ON ip.id = p_portfolio_id WHERE p.id = v_partner;
  v_msg := 'WELILE: Your support of UGX ' || public._co_support_fmt(v_p.investment_amount)
        || ' for a verified empty house is active. Your Rent Profit Share starts on ' || to_char(v_day, 'FMDD Mon YYYY') || '.';
  PERFORM public._ssd_notice('house_portfolio', p_portfolio_id, 'house_active', 'partner', v_partner, 'sms', v_p.phone, v_msg);
  PERFORM public._ssd_notice('house_portfolio', p_portfolio_id, 'house_active', 'partner', v_partner, 'email', v_p.email,
    replace(v_msg, 'WELILE: ', ''), 'Your house support is active');
END $$;

-- ---------------------------------------------------------------- Financial Ops: resolve a held or stuck payment
-- 'refund': the merchant did NOT pay. The queue row is closed and the partner refunded.
-- 'paid':   the merchant DID pay (withdrawal completed). The payout is moved to paid, which activates the portfolio.
CREATE OR REPLACE FUNCTION public.self_support_staff_resolve(p_payment_id uuid, p_outcome text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE v_uid uuid := auth.uid(); s public.self_support_landlord_payments%ROWTYPE; v_ws text;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF v_uid IS NULL OR NOT (
         EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id = v_uid
                  AND ur.role::text = ANY (ARRAY['super_admin','ceo','coo','cfo','financial_ops']))
      OR EXISTS (SELECT 1 FROM public.staff_permissions sp WHERE sp.user_id = v_uid AND sp.revoked_at IS NULL
                  AND sp.permitted_dashboard = 'financial-ops')) THEN
      RAISE EXCEPTION 'only Financial Ops can resolve a self-support landlord payment' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF p_outcome NOT IN ('refund', 'paid') THEN RAISE EXCEPTION 'outcome must be refund or paid'; END IF;
  IF length(btrim(COALESCE(p_reason, ''))) < 10 THEN RAISE EXCEPTION 'Reason must be at least 10 characters'; END IF;

  -- lock order: withdrawal, payout, payment (as the merchant path)
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'PAYMENT_NOT_FOUND'; END IF;
  SELECT status INTO v_ws FROM public.withdrawal_requests WHERE id = s.withdrawal_request_id FOR UPDATE;
  PERFORM 1 FROM public.landlord_payouts WHERE id = s.landlord_payout_id FOR UPDATE;
  SELECT * INTO s FROM public.self_support_landlord_payments WHERE id = p_payment_id FOR UPDATE;
  IF s.status <> 'queued' THEN
    RETURN jsonb_build_object('ok', true, 'noop', true, 'status', s.status);
  END IF;

  IF p_outcome = 'refund' THEN
    IF v_ws IN ('completed', 'paid', 'disbursed') THEN
      RAISE EXCEPTION 'The merchant withdrawal is %: the landlord was paid. Resolve as paid.', v_ws;
    END IF;
    UPDATE public.withdrawal_requests
       SET status = 'cancelled', rejection_reason = 'Financial Ops: ' || left(btrim(p_reason), 280), updated_at = now()
     WHERE id = s.withdrawal_request_id AND status NOT IN ('cancelled', 'rejected');
    UPDATE public.landlord_payouts SET status = 'failed', last_error = 'Financial Ops: ' || left(btrim(p_reason), 280), updated_at = now()
     WHERE id = s.landlord_payout_id AND status <> 'failed';
    PERFORM public._ssd_refund(s.id, 'Financial Ops: ' || btrim(p_reason));   -- no-op if the trigger already did it
  ELSE
    IF v_ws NOT IN ('completed', 'paid', 'disbursed') THEN
      RAISE EXCEPTION 'The merchant withdrawal is %, not completed: the landlord was not paid.', v_ws;
    END IF;
    UPDATE public.landlord_payouts
       SET status = 'awaiting_agent_receipt', disbursed_at = COALESCE(disbursed_at, now()), last_error = NULL, updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('resolved_paid_by', v_uid, 'resolved_reason', btrim(p_reason))
     WHERE id = s.landlord_payout_id AND status NOT IN ('awaiting_agent_receipt', 'completed');
    PERFORM public._ssd_activate(s.id);   -- no-op if the trigger already did it
    PERFORM public._ssd_notify(s.id, 'paid');
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, action, reason, metadata)
  VALUES (v_uid, 'self_support_staff_resolve', 'self_support_landlord_payments', s.id::text,
          'self_support_staff_resolve', btrim(p_reason), jsonb_build_object('outcome', p_outcome, 'withdrawal_status', v_ws));
  RETURN jsonb_build_object('ok', true, 'outcome', p_outcome,
                            'status', (SELECT status FROM public.self_support_landlord_payments WHERE id = s.id));
END $$;

-- ---------------------------------------------------------------- read RPC for the screens
-- Landlord payments I am part of: as a partner (my halves) or as the plan's agent.
CREATE OR REPLACE FUNCTION public.self_support_my_landlord_payments(p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'created_at' DESC), '[]'::jsonb) FROM (
    SELECT public._ssd_payment_json(s.id) || jsonb_build_object(
             'created_at', s.created_at,
             'role', CASE WHEN auth.uid() = ANY (s.partner_ids) THEN 'partner' ELSE 'agent' END,
             'tenant_first_name', (SELECT public._ssd_first(tp.full_name) FROM public.rent_requests rr
                                     LEFT JOIN public.profiles tp ON tp.id = rr.tenant_id WHERE rr.id = s.rent_request_id),
             'my_share', (SELECT SUM(l.principal) FROM public.partner_self_funding_lines l
                           WHERE l.id = ANY (s.line_ids) AND l.partner_id = auth.uid())) AS x
      FROM public.self_support_landlord_payments s
     WHERE auth.uid() IS NOT NULL AND (auth.uid() = ANY (s.partner_ids) OR s.agent_id = auth.uid())
     ORDER BY s.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
  ) q;
$$;

-- Internal functions are closed (owner + service_role); only the read RPC is for browsers.
DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public._ssd_on()', 'public._ssd_debit_ref(uuid, uuid, uuid)',
    'public._ssd_portfolio_queued(uuid)', 'public._ssd_plan_queued(uuid, numeric)', 'public._ssd_payment_json(uuid)',
    'public._ssd_plan_result(uuid)', 'public._ssd_support_result(uuid, uuid)',
    'public._ssd_notice(text, uuid, text, text, uuid, text, text, text, text)', 'public._ssd_notify(uuid, text)',
    'public._ssd_queue_commitment(uuid, uuid, uuid)', 'public._ssd_queue_plan(uuid)', 'public._ssd_settle_commitment(uuid)',
    'public._ssd_activate(uuid)', 'public._ssd_refund(uuid, text)', 'public.ssd_expire_unpaid(integer)',
    'public._ssd_house_instant(uuid)', 'public.trg_ssd_landlord_payout_status()', 'public.trg_ssd_landlord_paid_notify()']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
-- Called from guard triggers that may run as the signed-in user; they return a boolean only.
GRANT EXECUTE ON FUNCTION public._ssd_inserting(), public._ssd_payout_is_direct(uuid), public._ssd_wr_insert_is_direct(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.self_support_my_landlord_payments(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.self_support_my_landlord_payments(integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.self_support_staff_resolve(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.self_support_staff_resolve(uuid, text, text) TO authenticated, service_role;

SELECT cron.schedule('ssd_expire_unpaid', '*/15 * * * *', 'select public.ssd_expire_unpaid()');
