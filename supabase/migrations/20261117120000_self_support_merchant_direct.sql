-- Self-support merchant-direct (owner decisions 2026-11-12).
--
-- With pipeline switch self_support_merchant_direct ON:
--   * Rent Plan (one partner or a co-support pair): no Partner Ops, no agent landlord float, no landlord OTP.
--     The partner is debited and a payout to the landlord's Landlord-Ops-approved number goes straight
--     into the merchant payout queue (exempt from the night window and the landlord-payout freeze).
--     When the merchant pays (landlord_payouts -> awaiting_agent_receipt) the portfolio activates and
--     Rent Profit Share earns from the NEXT day (Kampala). Not paid in 48h, or rejected: partner refunded.
--     Agent: keeps the UGX 5,000 posted-rent bonus, no 1% payout commission.
--   * Empty house: instant (debited and active at once), earning from the next day.
-- Switch OFF: every patched function behaves exactly as before.
-- Also fixes E60: a partner's own direct release / co-support accept no longer trips the
-- self-approval guard (system releases set app.ss_system_release).
-- Built by supabase/tests/self_support_direct/build.js from production definitions.

-- Fail fast instead of queueing behind live traffic for the table locks below.
SET LOCAL lock_timeout = '5s';

-- Refuse to run if production changed any function this migration patches since 2026-11-12.
DO $guard$
DECLARE r record; v_md5 text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('enforce_landlord_payout_eligibility', 0, '15df1e4565023b1c47356ac77b12cf4c'),
    ('enforce_landlord_float_performance_gate', 0, 'b0b8d16ad3dca478e1de97d7e9dd0f6d'),
    ('trg_bike_sweep_block_withdrawal_fn', 0, '0dcde90af2705045f61b98272c95a04c'),
    ('require_withdrawal_pin_proof', 0, '7b426c9f265a59bbd020dd99c104511c'),
    ('prevent_duplicate_pending_withdrawal', 0, 'c03c649731ae095434570757f613fa3e'),
    ('get_agent_lp_float_available', 1, '27ae917bc6d56642411e31eaabd542a6'),
    ('deduct_agent_float_for_payout', 1, 'be40c177467cc058f05439cff0f0e79e'),
    ('refund_agent_float_for_payout', 2, '44a77dab6e840c8ae5e74108884a666a'),
    ('apply_landlord_payout_to_allocation', 0, '1a841838e02a13a14f03dcbb04883f1b'),
    ('post_landlord_payout_finops_commission', 0, '22a89bedab5aa9b91ccb6f317af4db97'),
    ('landlord_payout_allowed_today', 0, '4dfe7d58abca0c3f4fdd2919cd4bb790'),
    ('landlord_payout_goal_allowed', 0, '985d726d8156b84e18db46528c315a69'),
    ('trg_e60_no_self_approval', 0, '73a0d2b7c1bfad73dacb5cce4c7cadeb'),
    ('_approve_pending_portfolio_core', 2, 'bac5d552cdfa41eba35839303021011d'),
    ('funder_support_tenant_direct', 3, '177445c208cca6f8c1f18056be06fa02'),
    ('co_support_accept', 1, '082cc985ebf2bf16a7a39ae7dc62d004'),
    ('partner_support_houses', 3, 'b4309406a3b4ea689b2abe0883296040'),
    ('partner_support_houses', 4, '609fb423e3feca5d2b4e1589ceec747c'),
    ('funder_release_sms_dispatch', 0, '7c137828738a3edadac0710e5d0da3ca')
  ) AS t(proname, nargs, expected) LOOP
    -- line endings ignored: some live bodies were saved with CRLF
    SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5 FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace AND p.proname = r.proname AND p.pronargs = r.nargs;
    IF v_md5 IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION 'self_support_merchant_direct: %(% args) changed on production (md5 % <> %). Re-export and rebuild.',
        r.proname, r.nargs, v_md5, r.expected;
    END IF;
  END LOOP;
END $guard$;

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

-- ============================================================================
-- Part 2: production functions with the merchant-direct branch.
-- ============================================================================

-- enforce_landlord_payout_eligibility
CREATE OR REPLACE FUNCTION public.enforce_landlord_payout_eligibility()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_landlord_verified boolean;
  v_landlord_phone text;
  v_record_phone text;
  v_float_balance numeric;
  v_kampala_hour int;
BEGIN
  IF public.landlord_float_withdrawals_paused() THEN
    RAISE EXCEPTION 'Landlord float withdrawals are currently paused from Platform Controls. Try again once they are re-enabled.'
      USING ERRCODE = 'check_violation';
  END IF;

  v_kampala_hour := EXTRACT(HOUR FROM (now() AT TIME ZONE 'Africa/Kampala'));
  -- Self-support merchant-direct (switch self_support_merchant_direct): partner-direct payouts are exempt from the night window.
  IF NOT public._ssd_inserting() AND (v_kampala_hour < 6 OR v_kampala_hour >= 22) THEN
    RAISE EXCEPTION 'Landlord payouts are only allowed between 06:00 and 22:00 Africa/Kampala.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- verified_mobile_money_number (never raw phone/mobile_money_number) is the
  -- only number Landlord Ops actually approved -- see migration 20260922150000.
  SELECT verified, verified_mobile_money_number,
         phone
    INTO v_landlord_verified, v_landlord_phone, v_record_phone
  FROM public.landlords WHERE id = NEW.landlord_id;

  IF v_landlord_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'Landlord is not verified — Landlord Ops must verify the phone number first.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_landlord_phone IS NULL OR length(public.landlord_number_norm(v_landlord_phone)) < 9 THEN
    RAISE EXCEPTION 'Landlord Ops has not approved a payout number for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Structural guarantee, independent of any application code: the phone
  -- actually being paid out to must be the number Landlord Ops approved.
  -- Compared as the subscriber number (last 9 digits) so formatting
  -- ("0772 363 578" vs "0772363578" vs "+256772363578") can't block a payout,
  -- while any different number is still refused (doc 122).
  IF public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_landlord_phone) THEN
    RAISE EXCEPTION 'Payout phone does not match the number Landlord Ops approved for this landlord.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The approved number must also be the landlord's registered phone. If it is not, the approval is stale or came from
  -- the backfill, so the payout is refused until Landlord Ops confirms which number is correct.
  IF v_record_phone IS NOT NULL
     AND length(public.landlord_number_norm(v_record_phone)) >= 9
     AND public.landlord_number_norm(NEW.landlord_phone) <> public.landlord_number_norm(v_record_phone) THEN
    RAISE EXCEPTION 'PAYOUT_NUMBER_MISMATCH: the payout number does not match the phone number registered for this landlord. Landlord Ops must confirm the correct number before a payout can be made.'
      USING ERRCODE = 'check_violation',
            HINT = 'Landlord Ops: use the Payout number review to confirm the number on the landlord record.';
  END IF;

  -- Self-support merchant-direct (switch self_support_merchant_direct): a partner-direct payout never touches the agent's landlord float.
  IF public._ssd_inserting() THEN
    RETURN NEW;
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float WHERE agent_id = NEW.agent_id;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent has no landlord float account.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_float_balance < NEW.amount THEN
    RAISE EXCEPTION 'Insufficient landlord float (balance: %, requested: %).', v_float_balance, NEW.amount
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

-- enforce_landlord_float_performance_gate
CREATE OR REPLACE FUNCTION public.enforce_landlord_float_performance_gate()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE c record;
BEGIN
  IF NEW.landlord_payout_id IS NULL THEN RETURN NEW; END IF;
  -- Self-support merchant-direct (switch self_support_merchant_direct): partner money, not the agent's float.
  IF public._ssd_wr_insert_is_direct(NEW.landlord_payout_id) THEN RETURN NEW; END IF;

  -- Renewal payouts are not held by the weekly collection target (doc 250).
  IF public.landlord_payout_is_renewal(NEW.landlord_payout_id) THEN
    SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
    IF c.passes IS FALSE THEN
      INSERT INTO public.audit_logs (user_id, action_type, action, table_name, record_id, metadata)
      VALUES (NEW.user_id, 'landlord_gate_renewal_skip',
              'Renewal landlord payout let through while the agent was under the weekly collection target',
              'withdrawal_requests', NEW.id::text,
              jsonb_build_object('landlord_payout_id', NEW.landlord_payout_id, 'amount', NEW.amount,
                                 'rate_pct', c.rate_pct, 'required_pct', c.required_pct, 'basis', c.basis));
    END IF;
    RETURN NEW;
  END IF;

  SELECT * INTO c FROM public._agent_landlord_float_check(NEW.user_id);
  IF c.passes IS NOT FALSE THEN RETURN NEW; END IF;
  IF EXISTS (SELECT 1 FROM public.landlord_float_withdrawal_exceptions e
              WHERE e.agent_id = NEW.user_id AND e.week_start = public.current_welile_week_start(now())) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '%', public.landlord_float_blocked_message(NEW.user_id, NEW.amount) USING ERRCODE = 'P0001';
END;
$function$;

-- trg_bike_sweep_block_withdrawal_fn
CREATE OR REPLACE FUNCTION public.trg_bike_sweep_block_withdrawal_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Self-support merchant-direct (switch self_support_merchant_direct): the agent receives nothing from this row.
  IF NEW.landlord_payout_id IS NOT NULL AND public._ssd_wr_insert_is_direct(NEW.landlord_payout_id) THEN
    RETURN NEW;
  END IF;
  IF public._bike_sweep_blocks_outflow(NEW.user_id) THEN
    RAISE EXCEPTION 'BIKE_LEASE_FIRST: withdrawals are paused until the bike lease is fully paid' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $function$;

-- require_withdrawal_pin_proof
CREATE OR REPLACE FUNCTION public.require_withdrawal_pin_proof()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_mode text;
  v_has boolean;
  v_purpose text;
  v_proof jsonb;
begin
  if v_uid is null or v_uid is distinct from NEW.user_id then
    return NEW;
  end if;

  -- Self-support merchant-direct (switch self_support_merchant_direct): not the user's own withdrawal.
  if TG_TABLE_NAME = 'withdrawal_requests' then
    if NEW.landlord_payout_id IS NOT NULL AND public._ssd_wr_insert_is_direct(NEW.landlord_payout_id) then
      return NEW;
    end if;
  end if;

  if TG_TABLE_NAME = 'withdrawal_requests' then
    v_purpose := 'withdrawal';
  else
    v_purpose := 'payout_number_change';
  end if;

  select enforce_mode into v_mode from public.withdrawal_pin_config where id;
  if v_mode is null or v_mode = 'off' then
    return NEW;
  end if;

  select exists (select 1 from public.user_withdrawal_pins where user_id = v_uid) into v_has;
  if not v_has then
    if v_mode = 'all' then
      raise exception using errcode = '28000', message = 'withdrawal_pin_required',
        detail = 'Set your withdrawal PIN before withdrawing or changing your payout number.';
    end if;
    return NEW;
  end if;

  v_proof := public.consume_withdrawal_pin_proof(v_uid, v_purpose);
  if v_proof is null then
    raise exception using errcode = '28000', message = 'withdrawal_pin_proof_required',
      detail = 'Enter your withdrawal PIN to continue.';
  end if;

  if TG_TABLE_NAME = 'payout_number_change_requests' then
    NEW.pin_verified := true;
    NEW.device_fp := v_proof ->> 'device_fp';
    NEW.device_trusted := (v_proof ->> 'device_trusted')::boolean;
  end if;
  return NEW;
end;
$function$;

-- prevent_duplicate_pending_withdrawal
CREATE OR REPLACE FUNCTION public.prevent_duplicate_pending_withdrawal()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  duplicate_id uuid;
  window_minutes int := 15;
  -- Proxy partner payouts are manually keyed by an agent who may re-submit
  -- after doubting whether the first attempt landed. 15 minutes was too short.
  proxy_window_minutes int := 60;
BEGIN
  -- Self-support merchant-direct (switch self_support_merchant_direct): one payout per Rent Plan is enforced by its own unique index.
  IF NEW.landlord_payout_id IS NOT NULL AND public._ssd_wr_insert_is_direct(NEW.landlord_payout_id) THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS DISTINCT FROM 'pending'
     AND NEW.status IS DISTINCT FROM 'manager_approved' THEN
    RETURN NEW;
  END IF;

  IF NEW.payout_method = 'mobile_money'
     AND NEW.mobile_money_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'mobile_money'
      AND mobile_money_provider IS NOT DISTINCT FROM NEW.mobile_money_provider
      AND regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(NEW.mobile_money_number, ''), '\D', '', 'g')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  ELSIF NEW.payout_method = 'bank_transfer'
        AND NEW.bank_account_number IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'bank_transfer'
      AND bank_name IS NOT DISTINCT FROM NEW.bank_name
      AND bank_account_number = NEW.bank_account_number
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;

  ELSIF NEW.payout_method = 'cash' THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND payout_method = 'cash'
      AND coalesce(agent_location, '') = coalesce(NEW.agent_location, '')
      AND amount = NEW.amount
      AND created_at > now() - make_interval(mins => window_minutes)
    LIMIT 1;
  END IF;

  -- Proxy fallback: one partner can hold several portfolios, each with its own
  -- payout route and recipient. Two portfolios paying the SAME amount within
  -- the window are legitimately different payouts, so the proxy guard must
  -- compare the destination (route ref + recipient), not only partner+amount.
  IF duplicate_id IS NULL
     AND NEW.proxy_partner_id IS NOT NULL THEN
    SELECT id INTO duplicate_id
    FROM public.withdrawal_requests
    WHERE user_id = NEW.user_id
      AND status <> 'cancelled'
      AND proxy_partner_id = NEW.proxy_partner_id
      AND amount = NEW.amount
      AND coalesce(payout_route_ref, '') = coalesce(NEW.payout_route_ref, '')
      AND coalesce(payout_method, '') = coalesce(NEW.payout_method, '')
      AND regexp_replace(coalesce(mobile_money_number, ''), '\D', '', 'g')
          = regexp_replace(coalesce(NEW.mobile_money_number, ''), '\D', '', 'g')
      AND coalesce(bank_account_number, '') = coalesce(NEW.bank_account_number, '')
      AND created_at > now() - make_interval(mins => proxy_window_minutes)
    LIMIT 1;
  END IF;

  IF duplicate_id IS NOT NULL THEN
    RAISE EXCEPTION
      'DUPLICATE_PENDING_WITHDRAWAL: identical request submitted recently (id=%)',
      duplicate_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$function$;

-- get_agent_lp_float_available
CREATE OR REPLACE FUNCTION public.get_agent_lp_float_available(p_agent_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_agent_id IS NOT NULL AND NOT public.agent_float_read_allowed(p_agent_id) THEN
    RAISE EXCEPTION 'not_authorized' USING ERRCODE = '42501';
  END IF;

  RETURN GREATEST(
    0,
    COALESCE((SELECT balance FROM public.agent_landlord_float WHERE agent_id = p_agent_id), 0)
    - COALESCE((
        SELECT SUM(amount)
        FROM public.landlord_payouts
        WHERE agent_id = p_agent_id
          AND status IN ('otp_verified','pending_merchant_payout')
          AND NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments s
                           WHERE s.landlord_payout_id = landlord_payouts.id)
      ), 0)
    - COALESCE((
        SELECT SUM(remaining_amount)
        FROM public.agent_landlord_float_allocations
        WHERE agent_id = p_agent_id
          AND status = 'return_pending'
      ), 0)
  );
END;
$function$;

-- deduct_agent_float_for_payout
CREATE OR REPLACE FUNCTION public.deduct_agent_float_for_payout(p_payout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_payout public.landlord_payouts%ROWTYPE;
  v_float_balance numeric;
  v_new_balance numeric;
BEGIN
  SELECT * INTO v_payout FROM public.landlord_payouts WHERE id = p_payout_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payout % not found', p_payout_id; END IF;

  -- Self-support merchant-direct (switch self_support_merchant_direct): never on the agent's landlord float, so nothing to deduct.
  IF public._ssd_payout_is_direct(p_payout_id) THEN
    UPDATE public.landlord_payouts SET attempts = attempts + 1, last_attempt_at = now()
     WHERE id = p_payout_id AND last_attempt_at IS NULL;
    RETURN jsonb_build_object('ok', true, 'skipped', 'direct_partner', 'status', v_payout.status);
  END IF;

  IF v_payout.allocation_applied_id IS NOT NULL
     OR v_payout.status IN ('awaiting_agent_receipt','completed')
     OR v_payout.last_attempt_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'already_accounted', 'status', v_payout.status);
  END IF;

  IF v_payout.status NOT IN ('otp_verified','pending_merchant_payout','pending_finops_disbursement','disbursing') THEN
    RAISE EXCEPTION 'Payout % not in deductible status (%)', p_payout_id, v_payout.status;
  END IF;

  SELECT balance INTO v_float_balance
  FROM public.agent_landlord_float
  WHERE agent_id = v_payout.agent_id
  FOR UPDATE;

  IF v_float_balance IS NULL THEN
    RAISE EXCEPTION 'Agent % has no float account', v_payout.agent_id;
  END IF;

  IF v_float_balance < v_payout.amount THEN
    RAISE EXCEPTION 'Insufficient float (balance %, requested %)', v_float_balance, v_payout.amount;
  END IF;

  v_new_balance := v_float_balance - v_payout.amount;

  UPDATE public.agent_landlord_float
  SET balance = v_new_balance,
      total_paid_out = COALESCE(total_paid_out, 0) + v_payout.amount,
      updated_at = now()
  WHERE agent_id = v_payout.agent_id;

  UPDATE public.landlord_payouts
  SET attempts = attempts + 1,
      last_attempt_at = now()
  WHERE id = p_payout_id;

  RETURN jsonb_build_object('ok', true, 'previous_balance', v_float_balance, 'new_balance', v_new_balance, 'deducted', v_payout.amount);
END;
$function$;

-- refund_agent_float_for_payout
CREATE OR REPLACE FUNCTION public.refund_agent_float_for_payout(p_payout_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_service boolean := coalesce(auth.role(), 'service_role') = 'service_role';
  v_payout public.landlord_payouts%rowtype;
begin
  if not v_service then
    if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
    if not (
         exists (select 1 from public.user_roles ur where ur.user_id = v_uid
                  and ur.role::text = any (array['manager','super_admin','ceo','coo','cfo','financial_ops','admin']))
      or exists (select 1 from public.staff_permissions sp where sp.user_id = v_uid and sp.revoked_at is null
                  and sp.permitted_dashboard = any (array['financial-ops','company-ops']))
    ) then
      raise exception 'only finance staff can refund a landlord payout' using errcode = '42501';
    end if;
  end if;

  if p_reason is null or length(p_reason) < 10 then
    raise exception 'Refund reason must be at least 10 characters';
  end if;

  select * into v_payout from public.landlord_payouts where id = p_payout_id for update;
  if not found then raise exception 'Payout % not found', p_payout_id; end if;

  if v_payout.status in ('failed', 'refunded', 'escalated') then
    return jsonb_build_object('ok', true, 'noop', true, 'status', v_payout.status);
  end if;

  if v_payout.status not in ('otp_verified', 'pending_finops_disbursement', 'pending_merchant_payout', 'disbursing') then
    raise exception 'Cannot refund a payout in status % (the landlord has already been paid)', v_payout.status using errcode = 'P0001';
  end if;

  -- Self-support merchant-direct (switch self_support_merchant_direct): nothing to return to the agent; failing the payout
  -- refunds the partner (trg_a0_ssd_landlord_payout_status).
  if public._ssd_payout_is_direct(p_payout_id) then
    update public.landlord_payouts
       set status = 'failed', last_error = p_reason, escalated_at = now(), escalated_reason = p_reason, updated_at = now()
     where id = p_payout_id;
    return jsonb_build_object('ok', true, 'refunded', 0, 'reason', p_reason, 'status', 'failed',
                              'direct_partner', true, 'partner_refunded', true);
  end if;

  perform 1 from public.agent_landlord_float where agent_id = v_payout.agent_id for update;

  update public.agent_landlord_float
     set balance = coalesce(balance, 0) + v_payout.amount,
         total_paid_out = greatest(coalesce(total_paid_out, 0) - v_payout.amount, 0),
         updated_at = now()
   where agent_id = v_payout.agent_id;

  if v_payout.allocation_applied_id is not null then
    update public.agent_landlord_float_allocations
       set paid_out_amount = greatest(coalesce(paid_out_amount, 0) - v_payout.amount, 0),
           status = case
             when greatest(coalesce(paid_out_amount, 0) - v_payout.amount, 0) <= 0 then 'open'
             else 'partially_paid'
           end,
           updated_at = now()
     where id = v_payout.allocation_applied_id;
  end if;

  update public.landlord_payouts
     set status = 'failed',
         last_error = p_reason,
         escalated_at = now(),
         escalated_reason = p_reason,
         updated_at = now()
   where id = p_payout_id;

  return jsonb_build_object('ok', true, 'refunded', v_payout.amount, 'reason', p_reason, 'status', 'failed',
                            'allocation_reopened', v_payout.allocation_applied_id is not null);
end;
$function$;

-- apply_landlord_payout_to_allocation
CREATE OR REPLACE FUNCTION public.apply_landlord_payout_to_allocation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_alloc_id uuid;
BEGIN
  -- Only act once the agent's float is actually committed to this payout.
  IF NEW.status NOT IN ('pending_finops_disbursement','awaiting_agent_receipt','disbursed','completed') THEN
    RETURN NEW;
  END IF;

  -- Idempotency: never apply the same payout twice as it moves through states.
  IF NEW.allocation_applied_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Self-support merchant-direct (switch self_support_merchant_direct): there is no allocation, and the tenant
  -- fallback below could otherwise match an unrelated one.
  IF public._ssd_payout_is_direct(NEW.id) THEN
    RETURN NEW;
  END IF;

  IF NEW.rent_request_id IS NULL AND NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Prefer the allocation tied to the exact rent request.
  SELECT id INTO v_alloc_id
  FROM public.agent_landlord_float_allocations
  WHERE agent_id = NEW.agent_id
    AND rent_request_id = NEW.rent_request_id
    AND status IN ('open','partially_paid')
  ORDER BY created_at ASC LIMIT 1;

  -- Fallback: match by tenant.
  IF v_alloc_id IS NULL THEN
    SELECT id INTO v_alloc_id
    FROM public.agent_landlord_float_allocations
    WHERE agent_id = NEW.agent_id
      AND tenant_id IS NOT DISTINCT FROM NEW.tenant_id
      AND status IN ('open','partially_paid')
    ORDER BY created_at ASC LIMIT 1;
  END IF;

  IF v_alloc_id IS NOT NULL THEN
    UPDATE public.agent_landlord_float_allocations
    SET paid_out_amount = paid_out_amount + NEW.amount
    WHERE id = v_alloc_id;

    -- Lock this payout so later status changes can't re-apply it.
    UPDATE public.landlord_payouts
    SET allocation_applied_id = v_alloc_id
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$function$;

-- post_landlord_payout_finops_commission
CREATE OR REPLACE FUNCTION public.post_landlord_payout_finops_commission()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_commission numeric;
  v_txn_group uuid;
  v_reference text;
BEGIN
  IF NEW.status NOT IN ('awaiting_agent_receipt', 'completed') THEN
    RETURN NEW;
  END IF;

  IF OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.finops_disbursed_at IS NOT DISTINCT FROM NEW.finops_disbursed_at THEN
    RETURN NEW;
  END IF;

  IF NEW.agent_id IS NULL OR COALESCE(NEW.amount, 0) <= 0 THEN
    RETURN NEW;
  END IF;

  -- Self-support merchant-direct (switch self_support_merchant_direct): owner decision 2026-11-12: no 1% payout
  -- commission (the agent keeps the UGX 5,000 posted-rent bonus).
  IF public._ssd_payout_is_direct(NEW.id) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.general_ledger
    WHERE source_table = 'landlord_payouts'
      AND source_id = NEW.id
      AND category = 'agent_commission_earned'
      AND ledger_scope = 'wallet'
  ) THEN
    RETURN NEW;
  END IF;

  v_commission := ROUND(NEW.amount * 0.01);
  IF v_commission <= 0 THEN
    RETURN NEW;
  END IF;

  v_reference := COALESCE(NULLIF(NEW.finops_momo_reference, ''), NULLIF(NEW.external_reference, ''), NEW.id::text);

  SELECT public.create_ledger_transaction(
    jsonb_build_array(
      jsonb_build_object(
        'user_id', NEW.agent_id,
        'amount', v_commission,
        'direction', 'cash_in',
        'category', 'agent_commission_earned',
        'ledger_scope', 'wallet',
        'recipient_type', 'user',
        'source_table', 'landlord_payouts',
        'source_id', NEW.id,
        'description', '1% commission on FinOps-approved landlord payout to ' || COALESCE(NEW.landlord_name, 'landlord') || ' (Ref: ' || v_reference || ')',
        'currency', 'UGX',
        'reference_id', NEW.id::text || '-landlord-payout-commission',
        'transaction_date', COALESCE(NEW.finops_disbursed_at, NEW.disbursed_at, now())
      ),
      jsonb_build_object(
        'amount', v_commission,
        'direction', 'cash_out',
        'category', 'marketing_expense',
        'ledger_scope', 'platform',
        'source_table', 'landlord_payouts',
        'source_id', NEW.id,
        'description', 'Platform expense: 1% agent commission for landlord payout ' || NEW.id::text,
        'currency', 'UGX',
        'reference_id', NEW.id::text || '-landlord-payout-commission',
        'transaction_date', COALESCE(NEW.finops_disbursed_at, NEW.disbursed_at, now())
      )
    ),
    'landlord-payout-commission-' || NEW.id::text,
    true
  ) INTO v_txn_group;

  INSERT INTO public.system_events (
    event_type,
    user_id,
    related_entity_type,
    related_entity_id,
    metadata
  ) VALUES (
    'funds_added'::public.system_event_type,
    NEW.agent_id,
    'landlord_payout',
    NEW.id,
    jsonb_build_object(
      'amount', v_commission,
      'currency', 'UGX',
      'source', 'finops_landlord_payout_commission',
      'payout_amount', NEW.amount,
      'commission_rate', 0.01,
      'transaction_group_id', v_txn_group
    )
  );

  INSERT INTO public.welile_trust_score_cache (
    user_id,
    ai_id,
    score,
    tier,
    data_points,
    borrowing_limit_ugx,
    breakdown,
    is_agent_managed,
    last_calculated_at
  ) VALUES (
    NEW.agent_id,
    'WELILE-' || left(replace(NEW.agent_id::text, '-', ''), 10),
    1,
    'new',
    1,
    0,
    jsonb_build_object('landlord_payout_commissions', 1),
    true,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET data_points = public.welile_trust_score_cache.data_points + 1,
      breakdown = COALESCE(public.welile_trust_score_cache.breakdown, '{}'::jsonb) || jsonb_build_object(
        'last_landlord_payout_commission_at', now(),
        'last_landlord_payout_commission_ugx', v_commission
      ),
      last_calculated_at = now();

  RETURN NEW;
END;
$function$;

-- landlord_payout_allowed_today
CREATE OR REPLACE FUNCTION public.landlord_payout_allowed_today()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(SUM(w.amount), 0)
    FROM public.withdrawal_requests w
   WHERE w.landlord_payout_id IS NOT NULL
     -- partner-direct payouts are partner money, not this allowance
     AND NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments s WHERE s.landlord_payout_id = w.landlord_payout_id)
     AND w.landlord_block_exempt_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Kampala') AT TIME ZONE 'Africa/Kampala');
$function$;

-- landlord_payout_goal_allowed
CREATE OR REPLACE FUNCTION public.landlord_payout_goal_allowed()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT COALESCE(SUM(w.amount), 0) FROM public.withdrawal_requests w
     WHERE w.landlord_payout_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.self_support_landlord_payments s WHERE s.landlord_payout_id = w.landlord_payout_id)
       AND w.landlord_block_exempt_at >= public.landlord_payout_goal_started_at();
  $function$;

-- trg_e60_no_self_approval
CREATE OR REPLACE FUNCTION public.trg_e60_no_self_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- System releases (merchant-direct queue, instant houses) are nobody's approval.
  if coalesce(current_setting('app.ss_system_release', true), '') = 'on' then
    return new;
  end if;
  if auth.uid() is not null and auth.uid() = new.partner_id then
    -- Direct release: the funder releases their own float, no Partner Ops approval by design.
    if coalesce(current_setting('app.funder_direct_release', true), '') = 'on'
       and public._pipeline_switch_on('funder_direct_release') then
      return new;
    end if;
    raise exception 'E60_SELF_APPROVAL: you cannot approve your own funding. Another Partner Ops approver must approve it.' using errcode = '42501';
  end if;
  return new;
end $function$;

-- _approve_pending_portfolio_core
CREATE OR REPLACE FUNCTION public._approve_pending_portfolio_core(p_portfolio_id uuid, p_actor uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Self-support merchant-direct (switch self_support_merchant_direct): a Rent Plan is not activated here.
  -- The partner is debited and the payout queued; the portfolio activates when the landlord is paid.
  IF v_pending.id IS NOT NULL AND v_pending.source = 'self_managed' AND v_pending.commitment_id IS NOT NULL
     AND public._ssd_on() THEN
    PERFORM public._ssd_queue_commitment(p_portfolio_id, v_pending.id, v_caller);
    IF v_direct THEN
      PERFORM set_config('psm.owner_release', coalesce(v_prev_owner, ''), true);
    END IF;
    PERFORM set_config('app.funder_direct_release_busy', '', true);
    RETURN p_portfolio_id;
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
$function$;

-- funder_support_tenant_direct
CREATE OR REPLACE FUNCTION public.funder_support_tenant_direct(p_rent_request_ids uuid[], p_promised_deposit_date date DEFAULT NULL::date, p_term_months integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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

    IF public._ssd_portfolio_queued(v_portfolio) THEN
      RETURN v_res || public._ssd_support_result(v_portfolio, v_uid) || jsonb_build_object('idempotent_replay', true);
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

    -- Self-support merchant-direct (switch self_support_merchant_direct): the money is in the merchant queue.
    IF public._ssd_portfolio_queued(v_portfolio) THEN
      RETURN v_res || public._ssd_support_result(v_portfolio, v_uid);
    END IF;

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
$function$;

-- co_support_accept
CREATE OR REPLACE FUNCTION public.co_support_accept(p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_peek record;
  v public.co_support_invites%ROWTYPE;
  v_lead_avail numeric;
  v_avail numeric;
  v_problem text;
  v_claimed integer;
  v_lead jsonb;
  v_mine jsonb;
  v_is_house boolean;
BEGIN
  SELECT id, COALESCE(rent_request_id, house_id) AS target, lead_partner_id, house_id IS NOT NULL AS is_house
    INTO v_peek
    FROM public.co_support_invites WHERE code = upper(btrim(COALESCE(p_code, '')));
  IF NOT FOUND THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'INVITE_NOT_FOUND: This link is not valid. Ask your partner to share it again.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_is_house := v_peek.is_house;

  IF v_is_house THEN
    PERFORM public._co_support_require_partner_house(v_uid);
  ELSE
    PERFORM public._co_support_require_partner(v_uid);
  END IF;

  PERFORM public._co_support_lock(v_peek.target, v_peek.lead_partner_id, v_uid);
  SELECT * INTO v FROM public.co_support_invites WHERE id = v_peek.id FOR UPDATE;

  IF v.status = 'completed' AND v.invitee_id = v_uid THEN
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'idempotent_replay', true, 'landlord_float_released', NOT v_is_house);
  END IF;
  IF v.lead_partner_id = v_uid THEN
    RAISE EXCEPTION 'OWN_INVITE: You shared this. Send the link to the partner who will support it with you.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.status <> 'open' THEN
    RAISE EXCEPTION 'INVITE_CLOSED: This invitation is no longer open.' USING ERRCODE = 'check_violation';
  END IF;
  IF v.expires_at <= now() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v.declined_at IS NOT NULL THEN
    RAISE EXCEPTION 'INVITE_DECLINED: This invitation was declined. Ask your partner to send a new one.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The lead must still be a partner with a signed agreement.
  IF NOT public.psm_is_partner(v.lead_partner_id) OR NOT public.funder_has_signed_agreement(v.lead_partner_id) THEN
    RAISE EXCEPTION 'LEAD_NOT_ELIGIBLE: The partner who shared this cannot fund it right now. Ask them to check their account.'
      USING ERRCODE = 'check_violation';
  END IF;

  PERFORM public.partner_rate_now(v_uid);
  v_avail := public.funder_float_available(v_uid);
  IF v_avail < v.invitee_share THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: Your half is UGX %. You have UGX % of operational float. Add float to your wallet, then accept.',
      public._co_support_fmt(v.invitee_share), public._co_support_fmt(v_avail)
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT v_is_house THEN
    PERFORM public.psm_assert_no_foreign_booking(v_uid, ARRAY[v.rent_request_id]);
    PERFORM public.psm_assert_no_foreign_booking(v.lead_partner_id, ARRAY[v.rent_request_id]);
  END IF;

  -- Close the invite first: this ends the lead's hold, so their half can be used here.
  UPDATE public.co_support_invites
     SET status = 'completed', invitee_id = v_uid, accepted_at = now(),
         closed_at = now(), close_reason = 'accepted', updated_at = now()
   WHERE id = v.id;

  v_lead_avail := public.funder_float_available(v.lead_partner_id);
  IF v_lead_avail < v.lead_share THEN
    RAISE EXCEPTION 'LEAD_FUNDS_SHORT: Your partner no longer has their half in their wallet. Ask them to add float, then try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_house THEN
    v_problem := public._co_support_house_problem(v.house_id);
    IF v_problem IS NULL AND (SELECT hl.monthly_rent::numeric FROM public.house_listings hl WHERE hl.id = v.house_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
  ELSE
    v_problem := public._co_support_plan_problem(v.lead_partner_id, v.rent_request_id);
    -- The halves were agreed on this rent. If the rent changed since, nobody pays.
    IF v_problem IS NULL AND (SELECT rr.rent_amount FROM public.rent_requests rr WHERE rr.id = v.rent_request_id)
                             IS DISTINCT FROM v.rent_amount THEN
      v_problem := 'plan_changed';
    END IF;
    IF v_problem IS NULL THEN
      INSERT INTO public.partner_self_plan_claims (
        rent_request_id, partner_id, amount, status, idempotency_key, expires_at, confirmed_at
      ) VALUES (
        v.rent_request_id, v.lead_partner_id, v.rent_amount, 'confirmed', 'cosup-' || v.id::text, now(), now()
      )
      ON CONFLICT (rent_request_id) WHERE status IN ('held','confirmed') DO NOTHING;
      GET DIAGNOSTICS v_claimed = ROW_COUNT;
      IF v_claimed = 0 THEN
        v_problem := 'plan_held';
      END IF;
    END IF;
  END IF;

  IF v_problem IS NOT NULL THEN
    -- It went elsewhere (or its rent changed). Close the invite; no money moves.
    UPDATE public.co_support_invites
       SET status = 'plan_unavailable', invitee_id = NULL, accepted_at = NULL,
           close_reason = v_problem, updated_at = now()
     WHERE id = v.id;
    PERFORM public.psm_audit(v_uid, v.lead_partner_id, 'co_support_plan_unavailable',
      'co_support_invites', v.id, jsonb_build_object('reason', v_problem, 'invitee', v_uid));
    RETURN jsonb_build_object('ok', false, 'status', 'plan_unavailable', 'reason', v_problem,
      'message', CASE WHEN v_problem = 'plan_changed'
                      THEN 'The rent changed after this was shared. Nothing was taken from your wallet. Ask your partner to share it again.'
                      WHEN v_is_house
                      THEN 'This house was taken before you accepted. Nothing was taken from your wallet.'
                      ELSE 'This Rent Plan was taken before you accepted. Nothing was taken from your wallet.' END);
  END IF;

  IF v_is_house THEN
    v_lead := public._co_support_open_house_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_house_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');
  ELSE
    v_lead := public._co_support_open_half(v.id, v.lead_partner_id, v.lead_rent, v.lead_share, 'lead');
    v_mine := public._co_support_open_half(v.id, v_uid, v.invitee_rent, v.invitee_share, 'invitee');

    UPDATE public.partner_self_plan_claims
       SET commitment_id = (v_lead->>'commitment_id')::uuid, updated_at = now()
     WHERE idempotency_key = 'cosup-' || v.id::text
       AND partner_id = v.lead_partner_id
       AND rent_request_id = v.rent_request_id;

    UPDATE public.rent_requests
       SET self_funding_partner_id = v.lead_partner_id,
           self_funding_line_id = (v_lead->>'line_id')::uuid,
           updated_at = now()
     WHERE id = v.rent_request_id;
  END IF;

  UPDATE public.co_support_invites
     SET lead_commitment_id = (v_lead->>'commitment_id')::uuid,
         invitee_commitment_id = (v_mine->>'commitment_id')::uuid,
         lead_portfolio_id = (v_lead->>'portfolio_id')::uuid,
         invitee_portfolio_id = (v_mine->>'portfolio_id')::uuid,
         updated_at = now()
   WHERE id = v.id;

  -- Self-support merchant-direct (switch self_support_merchant_direct): empty houses are instant.
  -- Both halves are debited and active here, in one transaction, in a fixed order.
  IF v_is_house AND public._ssd_on() THEN
    PERFORM public._ssd_house_instant(LEAST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));
    PERFORM public._ssd_house_instant(GREATEST((v_lead->>'portfolio_id')::uuid, (v_mine->>'portfolio_id')::uuid));
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id, 'status', 'active'));
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'awaiting_partner_ops', false, 'house_active', true,
                              'earning_from', public._ssd_earning_date(), 'landlord_float_released', false,
                              'available_balance', public.funder_float_available(v_uid));
  END IF;

  IF v_is_house THEN
    -- Partner Ops approves the pair (approve_pending_portfolio); nothing is debited yet.
    BEGIN
      INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
      VALUES ('portfolio_topup', v_uid, 'co_support_invites', v.id,
              'Two partners co-supported a verified empty house: waiting for Partner Ops',
              jsonb_build_object('house_id', v.house_id, 'amount', v.gross_amount,
                                 'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                                 'lead_portfolio_id', v_lead->>'portfolio_id',
                                 'invitee_portfolio_id', v_mine->>'portfolio_id',
                                 'source', 'self_managed_house'));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
      jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                         'portfolio_id', v_mine->>'portfolio_id', 'house_id', v.house_id,
                         'status', 'pending_ops_approval'));
    RETURN public._co_support_invite_json(v.id, v_uid)
        || jsonb_build_object('ok', true, 'awaiting_partner_ops', true, 'landlord_float_released', false,
                              'available_balance', public.funder_float_available(v_uid));
  END IF;

  -- Rent Plan: direct release, as in Phase 1.
  PERFORM set_config('app.funder_direct_release', 'on', true);
  PERFORM public._approve_pending_portfolio_core((v_lead->>'portfolio_id')::uuid, v.lead_partner_id);
  PERFORM public._approve_pending_portfolio_core((v_mine->>'portfolio_id')::uuid, v_uid);

  IF NOT public._ssd_plan_queued(v.rent_request_id, v.rent_amount) AND NOT EXISTS (
    SELECT 1 FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id = v.rent_request_id
       AND a.source = 'partner_self_funding'
       AND a.status IN ('open', 'partially_paid')
       AND a.allocated_amount = v.rent_amount
  ) THEN
    RAISE EXCEPTION 'CO_SUPPORT_RELEASE_FAILED: The landlord float could not be released, so nothing was taken from either wallet. Please try again.'
      USING ERRCODE = 'check_violation';
  END IF;

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('rent_request_created', v_uid, 'co_support_invites', v.id,
            'Two partners co-supported a Rent Plan: rent moved to the agent landlord float',
            jsonb_build_object('rent_request_id', v.rent_request_id, 'rent_amount', v.rent_amount,
                               'lead_partner_id', v.lead_partner_id, 'invitee_id', v_uid,
                               'lead_portfolio_id', v_lead->>'portfolio_id',
                               'invitee_portfolio_id', v_mine->>'portfolio_id',
                               'direct_release', true));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  PERFORM public.psm_audit(v_uid, v_uid, 'co_support_accepted', 'co_support_invites', v.id,
    jsonb_build_object('lead_partner_id', v.lead_partner_id, 'share', v.invitee_share,
                       'portfolio_id', v_mine->>'portfolio_id'));

  RETURN public._co_support_invite_json(v.id, v_uid)
      || jsonb_build_object('ok', true, 'landlord_float_released', NOT public._ssd_plan_queued(v.rent_request_id),
                            'available_balance', public.funder_float_available(v_uid))
      || public._ssd_plan_result(v.rent_request_id);
END;
$function$;

-- partner_support_houses__3
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
  v_key text;
  v_total numeric := 0;  -- what the partner pays: rent + the agent facilitation fee
  v_rent numeric := 0;   -- the houses' monthly rent
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, public.self_support_gross(h.monthly_rent::numeric) AS principal,
         h.monthly_rent::numeric AS rent_amount,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0), COALESCE(SUM(rent_amount),0)
    INTO v_count, v_total, v_rent FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rent < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_rent)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Self-support merchant-direct (switch self_support_merchant_direct): empty houses are instant, no Partner Ops.
  IF public._ssd_on() THEN
    PERFORM public._ssd_house_instant(v_portfolio_id);
    RETURN jsonb_build_object(
      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
      'committed_amount', v_total, 'houses', v_count,
      'monthly_return', round(v_total * v_rate / 100),
      'roi_percentage', v_rate,
      'status', 'active', 'earning_from', public._ssd_earning_date(),
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$;

-- partner_support_houses__4
CREATE OR REPLACE FUNCTION public.partner_support_houses(p_house_ids uuid[], p_term_months integer DEFAULT 1, p_idempotency_key text DEFAULT NULL::text, p_commitment_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_partner uuid := auth.uid();
  v_term integer := public.psm_contract_term_months();
  v_rate numeric;
  v_stored numeric;
  v_key text;
  v_total numeric := 0;  -- what the partner pays: rent + the agent facilitation fee
  v_rent numeric := 0;   -- the houses' monthly rent
  v_count integer := 0;
  v_available numeric;
  v_commitment_id uuid;
  v_portfolio_id uuid;
  v_code text;
  v_agent uuid;
  v_existing public.partner_self_commitments%ROWTYPE;
  v_target public.partner_self_commitments%ROWTYPE;
  v_is_topup boolean := p_commitment_id IS NOT NULL;
  v_elig jsonb;
BEGIN
  IF v_partner IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF p_house_ids IS NULL OR array_length(p_house_ids,1) IS NULL THEN
    RAISE EXCEPTION 'NO_HOUSES_SELECTED';
  END IF;

  v_key := COALESCE(NULLIF(p_idempotency_key,''),
    'psh-' || v_partner::text || '-' || COALESCE(p_commitment_id::text,'new') || '-' || md5(array_to_string(p_house_ids,',')));

  IF NOT public.funder_has_signed_agreement(v_partner) THEN
    RAISE EXCEPTION 'AGREEMENT_REQUIRED'
      USING HINT = 'The partner must sign their partnership agreement before capital can be deployed.';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('psh-commit-' || v_partner::text));

  SELECT * INTO v_existing FROM public.partner_self_commitments WHERE idempotency_key = v_key;
  IF FOUND THEN
    RETURN jsonb_build_object('commitment_id', v_existing.id, 'idempotent_replay', true,
      'committed_amount', v_existing.committed_amount, 'houses', v_existing.lines_count,
      'status', v_existing.status);
  END IF;

  CREATE TEMP TABLE _psh_pick ON COMMIT DROP AS
  SELECT h.id AS house_id, public.self_support_gross(h.monthly_rent::numeric) AS principal,
         h.monthly_rent::numeric AS rent_amount,
         h.landlord_id, h.agent_id
  FROM public.house_listings h
  WHERE h.id = ANY(p_house_ids)
    AND h.verified = true
    AND h.status = 'available'
    AND h.tenant_id IS NULL
    AND COALESCE(h.is_hidden,false) = false
    AND COALESCE(h.monthly_rent,0) > 0
    AND NOT public.house_has_live_claim(h.id);

  SELECT COUNT(*), COALESCE(SUM(principal),0), COALESCE(SUM(rent_amount),0)
    INTO v_count, v_total, v_rent FROM _psh_pick;

  IF v_count = 0 OR v_count <> COALESCE(array_length(p_house_ids,1),0) THEN
    RAISE EXCEPTION 'HOUSES_UNAVAILABLE: some houses are no longer verified, empty or free. Refresh and reselect.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_rent < 50000 THEN
    RAISE EXCEPTION 'Minimum funding is UGX 50,000. The selection totals UGX %.', round(v_rent)
      USING ERRCODE = 'check_violation';
  END IF;

  v_available := public.funder_float_available(v_partner);
  IF v_total > v_available THEN
    RAISE EXCEPTION 'PARTNER_FUNDS_SHORT: houses total UGX %, partner has UGX % of operational float available.',
      round(v_total), round(GREATEST(v_available,0)) USING ERRCODE = 'check_violation';
  END IF;

  IF v_is_topup THEN
    SELECT * INTO v_target FROM public.partner_self_commitments
     WHERE id = p_commitment_id AND partner_id = v_partner FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'PORTFOLIO_NOT_FOUND' USING ERRCODE = 'no_data_found';
    END IF;

    -- A rent-plan portfolio can never absorb house capital: the flows differ.
    IF EXISTS (SELECT 1 FROM public.partner_self_funding_lines
                WHERE commitment_id = v_target.id AND status <> 'cancelled') THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio funds rent plans, so houses cannot be added to it.'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT h.portfolio_id INTO v_portfolio_id FROM public.partner_supported_houses h
     WHERE h.commitment_id = v_target.id AND h.status <> 'cancelled' AND h.portfolio_id IS NOT NULL
     ORDER BY h.portfolio_id LIMIT 1;
    IF v_portfolio_id IS NULL THEN
      RAISE EXCEPTION 'PORTFOLIO_KIND_MISMATCH: this portfolio does not hold houses.'
        USING ERRCODE = 'check_violation';
    END IF;

    v_elig := public.partner_self_topup_eligibility(v_target.id);
    IF NOT (v_elig->>'allow_topup')::boolean THEN
      RAISE EXCEPTION 'PSM_TOPUP_WINDOW_CLOSED: %', COALESCE(v_elig->>'block_reason','Top-up not allowed')
        USING ERRCODE = 'check_violation';
    END IF;

    v_commitment_id := v_target.id;
    SELECT MIN(metadata->>'portfolio_code') INTO v_code FROM public.partner_supported_houses
     WHERE commitment_id = v_target.id AND status <> 'cancelled';

    -- A top-up keeps the rate stored on the portfolio (existing partners keep their rate).
    SELECT ip.roi_percentage INTO v_rate FROM public.investor_portfolios ip WHERE ip.id = v_portfolio_id;
    v_rate := COALESCE(v_rate, v_target.monthly_rate);

    INSERT INTO public.partner_supported_houses (
      partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
      status, landlord_id, listing_agent_id, metadata
    )
    SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END,
           v_rate, COALESCE(v_target.term_months, v_term),
           'pending', p.landlord_id, p.agent_id,
           jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key, 'topup', true)
    FROM _psh_pick p;

    UPDATE public.partner_self_commitments
       SET lines_count = COALESCE(lines_count,0) + v_count, updated_at = now()
     WHERE id = v_commitment_id;

    INSERT INTO public.funder_pending_portfolios (
      portfolio_id, funder_id, amount, source, commitment_id, term_months
    ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house_topup', v_commitment_id,
              COALESCE(v_target.term_months, v_term));

    PERFORM public.psm_audit(v_partner, v_partner, 'house_support_topup_pending_ops_approval',
      'partner_self_commitments', v_commitment_id,
      jsonb_build_object('amount', v_total, 'houses', v_count, 'portfolio_id', v_portfolio_id,
                         'idempotency_key', v_key));

    RETURN jsonb_build_object(
      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
      'topup', true, 'committed_amount', v_total, 'houses', v_count,
      'monthly_return', round(v_total * v_rate / 100),
      'roi_percentage', v_rate,
      'status', 'pending_ops_approval',
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  v_rate := public.partner_rate_now(v_partner);

  INSERT INTO public.partner_self_commitments (
    partner_id, committed_amount, term_months, monthly_rate, lines_count, idempotency_key, status
  ) VALUES (v_partner, v_total, v_term, v_rate, v_count, v_key, 'pending_ops_approval')
  RETURNING id INTO v_commitment_id;

  SELECT agent_id INTO v_agent FROM public.investor_portfolios
   WHERE investor_id = v_partner ORDER BY created_at LIMIT 1;

  v_code := 'WSH-' || lpad((floor(random()*9000)+1000)::int::text, 4, '0');

  INSERT INTO public.investor_portfolios (
    investor_id, agent_id, portfolio_code, investment_amount, duration_months,
    roi_mode, status, portfolio_pin, activation_token, total_roi_earned
  ) VALUES (
    v_partner, COALESCE(v_agent, v_partner), v_code, v_total, v_term,
    'monthly_payout', 'pending_ops_approval',
    lpad((floor(random()*9000)+1000)::int::text, 4, '0'), gen_random_uuid(), 0
  ) RETURNING id, roi_percentage INTO v_portfolio_id, v_stored;

  IF v_stored IS DISTINCT FROM v_rate THEN
    PERFORM public._partner_commitment_follow_rate(v_commitment_id, v_stored);
    v_rate := v_stored;
  END IF;

  INSERT INTO public.funder_pending_portfolios (
    portfolio_id, funder_id, amount, source, commitment_id, term_months
  ) VALUES (v_portfolio_id, v_partner, v_total, 'self_managed_house', v_commitment_id, v_term);

  INSERT INTO public.partner_supported_houses (
    partner_id, house_id, commitment_id, portfolio_id, principal, rent_amount, proxy_fee, proxy_fee_status,
    monthly_rate, term_months,
    status, landlord_id, listing_agent_id, metadata
  )
  SELECT v_partner, p.house_id, v_commitment_id, v_portfolio_id, p.principal, p.rent_amount, p.principal - p.rent_amount,
           CASE WHEN p.principal > p.rent_amount THEN 'pending' END, v_rate, v_term,
         'pending', p.landlord_id, p.agent_id,
         jsonb_build_object('portfolio_code', v_code, 'idempotency_key', v_key)
  FROM _psh_pick p;

  PERFORM public.psm_audit(v_partner, v_partner, 'house_support_pending_ops_approval',
    'partner_self_commitments', v_commitment_id,
    jsonb_build_object('amount', v_total, 'houses', v_count, 'term_months', v_term,
                       'portfolio_id', v_portfolio_id, 'funding_tag','self_support_operational_house',
                       'idempotency_key', v_key));

  BEGIN
    INSERT INTO public.system_events(event_type, user_id, related_entity_type, related_entity_id, description, metadata)
    VALUES ('portfolio_topup', v_partner, 'investor_portfolios', v_portfolio_id,
            'Partner submitted a verified-house self-support portfolio',
            jsonb_build_object('commitment_id', v_commitment_id, 'amount', v_total,
                               'houses', v_count, 'source','self_managed_house'));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  -- Self-support merchant-direct (switch self_support_merchant_direct): empty houses are instant, no Partner Ops.
  IF public._ssd_on() THEN
    PERFORM public._ssd_house_instant(v_portfolio_id);
    RETURN jsonb_build_object(
      'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
      'committed_amount', v_total, 'houses', v_count,
      'monthly_return', round(v_total * v_rate / 100),
      'roi_percentage', v_rate,
      'status', 'active', 'earning_from', public._ssd_earning_date(),
      'available_balance', public.funder_float_available(v_partner)
    );
  END IF;

  RETURN jsonb_build_object(
    'commitment_id', v_commitment_id, 'portfolio_id', v_portfolio_id,
    'committed_amount', v_total, 'houses', v_count,
    'monthly_return', round(v_total * v_rate / 100),
    'roi_percentage', v_rate,
    'status', 'pending_ops_approval',
    'available_balance', public.funder_float_available(v_partner)
  );
END;
$function$;

-- funder_release_sms_dispatch
CREATE OR REPLACE FUNCTION public.funder_release_sms_dispatch()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.funder_release_sms
     WHERE status = 'pending' AND attempts < 4
  ) AND NOT EXISTS (
    -- merchant-direct self-support messages share this batch sender
    SELECT 1 FROM public.self_support_notices
     WHERE status = 'pending' AND channel = 'sms' AND attempts < 4
  ) THEN
    RETURN;
  END IF;

  SELECT decrypted_secret INTO v_key
    FROM vault.decrypted_secrets
   WHERE name = 'email_queue_service_role_key'
   LIMIT 1;

  IF v_key IS NULL OR btrim(v_key) = '' THEN
    RAISE WARNING 'funder release sms dispatch skipped: email_queue_service_role_key is not in vault';
    RETURN;
  END IF;

  PERFORM net.http_post(
    url := 'https://byrzshwlentqvktcksem.supabase.co/functions/v1/notify-funder-release-sms',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body := '{}'::jsonb
  );
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'funder release sms dispatch failed: %', SQLERRM;
END;
$function$;

