-- Welile digital receipts for money handed in by partners (replaces the paper receipt books from go-live).
--
-- WHAT THIS IS: an evidence record, NOT a money movement. A receipt acknowledges money that already goes through the
-- system (deposit_requests). Issuing, voiding or correcting a receipt never touches wallets or general_ledger.
--
-- NUMBERING continues the paper series. Paper receipts ran to No. 4102 (3 Nov 2026), so the first digital receipt is 4103.
-- The number comes from a one-row counter updated inside the issuing transaction (a plain sequence would skip numbers on rollback).
--
-- IMMUTABLE: a receipt row can never be deleted, and its amount / payer / method / purpose can never be edited. Only status
-- (issued -> voided), cash confirmation and the supersede link can change, and only through the RPCs below.
-- CORRECTIONS: staff request a void or correction; the CFO (or a super admin) approves, and never the person who asked.
-- Approval voids the original, keeps it visible, and (for a correction) issues a new receipt that points back to it.
--
-- WHO: issue = financial_ops, cfo, super_admin (or financial-ops / cfo dashboard grant).
--      view  = the issuers plus Partner Ops (is_partner_ops).   approve corrections = cfo, super_admin.
-- Roll back with 20261105180000_partner_receipts.rollback.sql.

CREATE TABLE IF NOT EXISTS public.partner_receipt_counter (
  id      smallint PRIMARY KEY CHECK (id = 1),
  last_no integer NOT NULL
);
INSERT INTO public.partner_receipt_counter (id, last_no) VALUES (1, 4102) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.partner_receipt_counter ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.partner_receipt_counter TO service_role;

CREATE TABLE IF NOT EXISTS public.partner_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no          integer NOT NULL UNIQUE,
  receipt_code        text NOT NULL UNIQUE,
  received_from       text NOT NULL CHECK (length(btrim(received_from)) >= 3),
  payer_user_id       uuid,
  payer_phone         text,
  amount              numeric NOT NULL CHECK (amount > 0),
  payment_method      text NOT NULL CHECK (payment_method IN ('cash','cheque','bank_draft','bank_transfer','mobile_money')),
  instrument_no       text,
  drawn_on            text,
  branch              text NOT NULL DEFAULT 'Entebbe',
  purpose             text NOT NULL CHECK (length(btrim(purpose)) >= 3),
  received_on         date NOT NULL,
  deposit_request_id  uuid REFERENCES public.deposit_requests(id),
  note                text,
  status              text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued','voided')),
  issued_by           uuid NOT NULL,
  issued_at           timestamptz NOT NULL DEFAULT now(),
  cash_confirmed_by   uuid,
  cash_confirmed_at   timestamptz,
  voided_at           timestamptz,
  voided_by           uuid,
  void_reason         text,
  supersedes_id       uuid REFERENCES public.partner_receipts(id),
  superseded_by_id    uuid REFERENCES public.partner_receipts(id),
  delivered_via       text,
  delivered_at        timestamptz,
  verify_token        text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(9), 'hex')
);
CREATE INDEX IF NOT EXISTS partner_receipts_received_on_idx ON public.partner_receipts (received_on DESC);
CREATE INDEX IF NOT EXISTS partner_receipts_payer_idx ON public.partner_receipts (lower(received_from));
-- One live receipt per deposit: the same money cannot be receipted twice.
CREATE UNIQUE INDEX IF NOT EXISTS partner_receipts_one_live_per_deposit
  ON public.partner_receipts (deposit_request_id) WHERE deposit_request_id IS NOT NULL AND status = 'issued';
ALTER TABLE public.partner_receipts ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.partner_receipt_corrections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id       uuid NOT NULL REFERENCES public.partner_receipts(id),
  kind             text NOT NULL CHECK (kind IN ('void','correct')),
  reason           text NOT NULL CHECK (length(btrim(reason)) >= 5),
  proposed         jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by     uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by       uuid,
  decided_at       timestamptz,
  decision_note    text,
  new_receipt_id   uuid REFERENCES public.partner_receipts(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS partner_receipt_one_pending_correction
  ON public.partner_receipt_corrections (receipt_id) WHERE status = 'pending';
ALTER TABLE public.partner_receipt_corrections ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.partner_receipt_events (
  id          bigserial PRIMARY KEY,
  receipt_id  uuid NOT NULL REFERENCES public.partner_receipts(id),
  event       text NOT NULL,
  actor       uuid,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS partner_receipt_events_receipt_idx ON public.partner_receipt_events (receipt_id, at);
ALTER TABLE public.partner_receipt_events ENABLE ROW LEVEL SECURITY;

-- ---------- access helpers ----------
CREATE OR REPLACE FUNCTION public.can_issue_partner_receipt(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role::text IN ('financial_ops','cfo','super_admin'))
      OR EXISTS (SELECT 1 FROM public.staff_permissions WHERE user_id = _uid AND permitted_dashboard IN ('financial-ops','cfo') AND revoked_at IS NULL);
$$;
CREATE OR REPLACE FUNCTION public.can_view_partner_receipts(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.can_issue_partner_receipt(_uid) OR public.is_partner_ops(_uid);
$$;
CREATE OR REPLACE FUNCTION public.can_approve_partner_receipt_correction(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role::text IN ('cfo','super_admin'));
$$;
REVOKE ALL ON FUNCTION public.can_issue_partner_receipt(uuid), public.can_view_partner_receipts(uuid), public.can_approve_partner_receipt_correction(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_issue_partner_receipt(uuid), public.can_view_partner_receipts(uuid), public.can_approve_partner_receipt_correction(uuid) TO authenticated;

-- ---------- RLS: read only for the browser; every write goes through the RPCs ----------
-- Request-level calls are wrapped in (select ...) so Postgres evaluates them once per query, not once per row.
CREATE POLICY partner_receipts_read ON public.partner_receipts FOR SELECT TO authenticated
  USING ((select public.can_view_partner_receipts((select auth.uid()))));
CREATE POLICY partner_receipt_corrections_read ON public.partner_receipt_corrections FOR SELECT TO authenticated
  USING ((select public.can_view_partner_receipts((select auth.uid()))));
CREATE POLICY partner_receipt_events_read ON public.partner_receipt_events FOR SELECT TO authenticated
  USING ((select public.can_view_partner_receipts((select auth.uid()))));
-- Staff MFA (doc 249): a no-op until staff_mfa_config.mode is 'admin' or 'all', but without it a password-only staff session stays able to read these.
CREATE POLICY mfa_required_for_staff ON public.partner_receipts AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.partner_receipt_corrections AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.partner_receipt_events AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
CREATE POLICY mfa_required_for_staff ON public.partner_receipt_counter AS RESTRICTIVE FOR ALL TO authenticated
  USING ((select public.staff_mfa_ok())) WITH CHECK ((select public.staff_mfa_ok()));
GRANT SELECT ON public.partner_receipts, public.partner_receipt_corrections, public.partner_receipt_events TO authenticated;
GRANT ALL ON public.partner_receipts, public.partner_receipt_corrections, public.partner_receipt_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.partner_receipt_events_id_seq TO service_role;

-- ---------- immutability ----------
CREATE OR REPLACE FUNCTION public.partner_receipts_protect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Receipts cannot be deleted. Request a void or correction instead.' USING ERRCODE = '42501';
  END IF;
  IF (NEW.id, NEW.receipt_no, NEW.receipt_code, NEW.received_from, NEW.payer_user_id, NEW.payer_phone, NEW.amount,
      NEW.payment_method, NEW.instrument_no, NEW.drawn_on, NEW.branch, NEW.purpose, NEW.received_on,
      NEW.deposit_request_id, NEW.issued_by, NEW.issued_at, NEW.supersedes_id, NEW.verify_token)
     IS DISTINCT FROM
     (OLD.id, OLD.receipt_no, OLD.receipt_code, OLD.received_from, OLD.payer_user_id, OLD.payer_phone, OLD.amount,
      OLD.payment_method, OLD.instrument_no, OLD.drawn_on, OLD.branch, OLD.purpose, OLD.received_on,
      OLD.deposit_request_id, OLD.issued_by, OLD.issued_at, OLD.supersedes_id, OLD.verify_token) THEN
    RAISE EXCEPTION 'A receipt''s amount, payer, method and purpose cannot be edited. Request a correction instead.' USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'voided' AND NEW.status <> 'voided' THEN
    RAISE EXCEPTION 'A voided receipt cannot be reopened.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS partner_receipts_protect_trg ON public.partner_receipts;
CREATE TRIGGER partner_receipts_protect_trg BEFORE UPDATE OR DELETE ON public.partner_receipts
  FOR EACH ROW EXECUTE FUNCTION public.partner_receipts_protect();

CREATE OR REPLACE FUNCTION public.partner_receipt_events_protect()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'The receipt history is append-only.' USING ERRCODE = '42501'; END $$;
DROP TRIGGER IF EXISTS partner_receipt_events_protect_trg ON public.partner_receipt_events;
CREATE TRIGGER partner_receipt_events_protect_trg BEFORE UPDATE OR DELETE ON public.partner_receipt_events
  FOR EACH ROW EXECUTE FUNCTION public.partner_receipt_events_protect();

-- ---------- internal insert (shared by issue and correction approval) ----------
CREATE OR REPLACE FUNCTION public._partner_receipt_insert(
  p_actor uuid, p_received_from text, p_amount numeric, p_method text, p_purpose text, p_received_on date,
  p_payer_user_id uuid, p_payer_phone text, p_instrument_no text, p_drawn_on text, p_branch text,
  p_deposit_request_id uuid, p_note text, p_supersedes uuid
) RETURNS public.partner_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_no integer;
  v_row public.partner_receipts;
  v_dep record;
BEGIN
  IF p_received_on > (now() AT TIME ZONE 'Africa/Kampala')::date THEN
    RAISE EXCEPTION 'The receipt date cannot be in the future.';
  END IF;
  -- A correction keeps the original's date, so the 7-day limit applies to fresh receipts only.
  IF p_supersedes IS NULL AND p_received_on < (now() AT TIME ZONE 'Africa/Kampala')::date - 7 THEN
    RAISE EXCEPTION 'Receipts can be dated at most 7 days back.';
  END IF;
  IF p_method IN ('cheque','bank_draft') AND coalesce(btrim(p_instrument_no), '') = '' THEN
    RAISE EXCEPTION 'Enter the cheque or draft number.';
  END IF;
  IF p_deposit_request_id IS NOT NULL THEN
    SELECT amount, status, user_id INTO v_dep FROM public.deposit_requests WHERE id = p_deposit_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'That deposit record does not exist.'; END IF;
    IF v_dep.status = 'rejected' THEN RAISE EXCEPTION 'That deposit was rejected, so it cannot be receipted.'; END IF;
    IF v_dep.amount <> p_amount THEN
      RAISE EXCEPTION 'The receipt amount (UGX %) does not match the deposit (UGX %).', p_amount, v_dep.amount;
    END IF;
    IF p_payer_user_id IS NOT NULL AND v_dep.user_id <> p_payer_user_id THEN
      RAISE EXCEPTION 'The deposit belongs to a different person than the payer chosen.';
    END IF;
  END IF;

  UPDATE public.partner_receipt_counter SET last_no = last_no + 1 WHERE id = 1 RETURNING last_no INTO v_no;

  INSERT INTO public.partner_receipts (
    receipt_no, receipt_code, received_from, payer_user_id, payer_phone, amount, payment_method, instrument_no,
    drawn_on, branch, purpose, received_on, deposit_request_id, note, issued_by, supersedes_id
  ) VALUES (
    v_no, 'WEL-RCP-' || to_char(now() AT TIME ZONE 'Africa/Kampala', 'YYYY') || '-' || lpad(v_no::text, 6, '0'),
    btrim(p_received_from), p_payer_user_id, nullif(btrim(p_payer_phone), ''), p_amount, p_method,
    nullif(btrim(p_instrument_no), ''), nullif(btrim(p_drawn_on), ''), coalesce(nullif(btrim(p_branch), ''), 'Entebbe'),
    btrim(p_purpose), p_received_on, p_deposit_request_id, nullif(btrim(p_note), ''), p_actor, p_supersedes
  ) RETURNING * INTO v_row;

  INSERT INTO public.partner_receipt_events (receipt_id, event, actor, detail)
  VALUES (v_row.id, CASE WHEN p_supersedes IS NULL THEN 'issued' ELSE 'issued_as_correction' END, p_actor,
          jsonb_build_object('amount', p_amount, 'method', p_method, 'deposit_request_id', p_deposit_request_id, 'supersedes', p_supersedes));
  RETURN v_row;
END $$;
REVOKE ALL ON FUNCTION public._partner_receipt_insert(uuid,text,numeric,text,text,date,uuid,text,text,text,text,uuid,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public._partner_receipt_insert(uuid,text,numeric,text,text,date,uuid,text,text,text,text,uuid,text,uuid) TO service_role;

-- ---------- issue ----------
CREATE OR REPLACE FUNCTION public.issue_partner_receipt(
  p_received_from text, p_amount numeric, p_method text, p_purpose text, p_received_on date,
  p_payer_user_id uuid DEFAULT NULL, p_payer_phone text DEFAULT NULL, p_instrument_no text DEFAULT NULL,
  p_drawn_on text DEFAULT NULL, p_branch text DEFAULT 'Entebbe', p_deposit_request_id uuid DEFAULT NULL, p_note text DEFAULT NULL
) RETURNS public.partner_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_issue_partner_receipt(auth.uid()) THEN
    RAISE EXCEPTION 'Only Financial Ops and the CFO can issue receipts.' USING ERRCODE = '42501';
  END IF;
  RETURN public._partner_receipt_insert(auth.uid(), p_received_from, p_amount, p_method, p_purpose, p_received_on,
    p_payer_user_id, p_payer_phone, p_instrument_no, p_drawn_on, p_branch, p_deposit_request_id, p_note, NULL);
END $$;

-- ---------- second-person cash confirmation ----------
CREATE OR REPLACE FUNCTION public.confirm_partner_receipt_cash(p_receipt_id uuid)
RETURNS public.partner_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.partner_receipts;
BEGIN
  IF NOT public.can_issue_partner_receipt(auth.uid()) THEN
    RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v FROM public.partner_receipts WHERE id = p_receipt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found.'; END IF;
  IF v.payment_method <> 'cash' THEN RAISE EXCEPTION 'Only cash receipts need a cash confirmation.'; END IF;
  IF v.status <> 'issued' THEN RAISE EXCEPTION 'This receipt is voided.'; END IF;
  IF v.cash_confirmed_by IS NOT NULL THEN RAISE EXCEPTION 'The cash is already confirmed.'; END IF;
  IF v.issued_by = auth.uid() THEN RAISE EXCEPTION 'A different person must count and confirm the cash.'; END IF;
  UPDATE public.partner_receipts SET cash_confirmed_by = auth.uid(), cash_confirmed_at = now() WHERE id = p_receipt_id RETURNING * INTO v;
  INSERT INTO public.partner_receipt_events (receipt_id, event, actor) VALUES (p_receipt_id, 'cash_confirmed', auth.uid());
  RETURN v;
END $$;

-- ---------- record that the partner got their copy ----------
CREATE OR REPLACE FUNCTION public.mark_partner_receipt_delivered(p_receipt_id uuid, p_via text)
RETURNS public.partner_receipts
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v public.partner_receipts;
BEGIN
  IF NOT public.can_issue_partner_receipt(auth.uid()) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_via NOT IN ('whatsapp','sms','email','printed','download') THEN RAISE EXCEPTION 'Unknown delivery channel.'; END IF;
  UPDATE public.partner_receipts SET delivered_via = p_via, delivered_at = now() WHERE id = p_receipt_id RETURNING * INTO v;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found.'; END IF;
  INSERT INTO public.partner_receipt_events (receipt_id, event, actor, detail) VALUES (p_receipt_id, 'delivered', auth.uid(), jsonb_build_object('via', p_via));
  RETURN v;
END $$;

-- ---------- corrections ----------
CREATE OR REPLACE FUNCTION public.request_partner_receipt_correction(
  p_receipt_id uuid, p_kind text, p_reason text, p_proposed jsonb DEFAULT '{}'::jsonb
) RETURNS public.partner_receipt_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r public.partner_receipts; v_c public.partner_receipt_corrections;
BEGIN
  IF NOT public.can_issue_partner_receipt(auth.uid()) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  IF p_kind NOT IN ('void','correct') THEN RAISE EXCEPTION 'Kind must be void or correct.'; END IF;
  IF p_kind = 'correct' AND coalesce(p_proposed, '{}'::jsonb) = '{}'::jsonb THEN
    RAISE EXCEPTION 'Say what should change (amount, name, method or purpose).';
  END IF;
  SELECT * INTO v_r FROM public.partner_receipts WHERE id = p_receipt_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Receipt not found.'; END IF;
  IF v_r.status <> 'issued' THEN RAISE EXCEPTION 'This receipt is already voided.'; END IF;
  INSERT INTO public.partner_receipt_corrections (receipt_id, kind, reason, proposed, requested_by)
  VALUES (p_receipt_id, p_kind, btrim(p_reason), coalesce(p_proposed, '{}'::jsonb), auth.uid()) RETURNING * INTO v_c;
  INSERT INTO public.partner_receipt_events (receipt_id, event, actor, detail)
  VALUES (p_receipt_id, 'correction_requested', auth.uid(), jsonb_build_object('kind', p_kind, 'reason', p_reason, 'proposed', p_proposed));
  RETURN v_c;
END $$;

CREATE OR REPLACE FUNCTION public.decide_partner_receipt_correction(p_correction_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS public.partner_receipt_corrections
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_c public.partner_receipt_corrections; v_r public.partner_receipts; v_new public.partner_receipts; p jsonb;
BEGIN
  IF NOT public.can_approve_partner_receipt_correction(auth.uid()) THEN
    RAISE EXCEPTION 'Only the CFO can approve receipt corrections.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO v_c FROM public.partner_receipt_corrections WHERE id = p_correction_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Correction request not found.'; END IF;
  IF v_c.status <> 'pending' THEN RAISE EXCEPTION 'This request was already decided.'; END IF;
  IF v_c.requested_by = auth.uid() THEN RAISE EXCEPTION 'You cannot approve your own request. Another approver must decide it.'; END IF;
  SELECT * INTO v_r FROM public.partner_receipts WHERE id = v_c.receipt_id FOR UPDATE;

  IF NOT p_approve THEN
    UPDATE public.partner_receipt_corrections SET status='rejected', decided_by=auth.uid(), decided_at=now(), decision_note=p_note
      WHERE id = p_correction_id RETURNING * INTO v_c;
    INSERT INTO public.partner_receipt_events (receipt_id, event, actor, detail)
      VALUES (v_r.id, 'correction_rejected', auth.uid(), jsonb_build_object('note', p_note));
    RETURN v_c;
  END IF;

  IF v_r.status <> 'issued' THEN RAISE EXCEPTION 'The receipt is no longer live.'; END IF;
  -- Void first so the deposit link is free for the replacement receipt.
  UPDATE public.partner_receipts SET status='voided', voided_at=now(), voided_by=auth.uid(), void_reason=v_c.reason WHERE id = v_r.id;
  IF v_c.kind = 'correct' THEN
    p := v_c.proposed;
    -- The replacement keeps the original issuer (who handled the money); the approver is on the original's 'voided' event.
    v_new := public._partner_receipt_insert(
      v_r.issued_by,
      coalesce(p->>'received_from', v_r.received_from),
      coalesce((p->>'amount')::numeric, v_r.amount),
      coalesce(p->>'payment_method', v_r.payment_method),
      coalesce(p->>'purpose', v_r.purpose),
      v_r.received_on, v_r.payer_user_id, v_r.payer_phone,
      coalesce(p->>'instrument_no', v_r.instrument_no), coalesce(p->>'drawn_on', v_r.drawn_on), v_r.branch,
      CASE WHEN p ? 'amount' AND (p->>'amount')::numeric <> v_r.amount THEN NULL ELSE v_r.deposit_request_id END,
      v_r.note, v_r.id);
    UPDATE public.partner_receipts SET superseded_by_id = v_new.id WHERE id = v_r.id;
  END IF;
  UPDATE public.partner_receipt_corrections
     SET status='approved', decided_by=auth.uid(), decided_at=now(), decision_note=p_note, new_receipt_id=v_new.id
   WHERE id = p_correction_id RETURNING * INTO v_c;
  INSERT INTO public.partner_receipt_events (receipt_id, event, actor, detail)
    VALUES (v_r.id, 'voided', auth.uid(), jsonb_build_object('kind', v_c.kind, 'reason', v_c.reason, 'new_receipt_id', v_new.id));
  RETURN v_c;
END $$;

-- ---------- archive search ----------
CREATE OR REPLACE FUNCTION public.search_partner_receipts(
  p_search text DEFAULT NULL, p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_method text DEFAULT NULL, p_status text DEFAULT NULL, p_limit integer DEFAULT 100, p_offset integer DEFAULT 0
) RETURNS TABLE (
  id uuid, receipt_no integer, receipt_code text, received_from text, payer_phone text, amount numeric, payment_method text,
  instrument_no text, drawn_on text, branch text, purpose text, received_on date, deposit_request_id uuid, note text,
  status text, issued_by uuid, issued_by_name text, issued_at timestamptz, cash_confirmed_at timestamptz,
  cash_confirmed_by_name text, voided_at timestamptz, void_reason text, supersedes_id uuid, superseded_by_id uuid,
  delivered_via text, delivered_at timestamptz, verify_token text, pending_correction_id uuid, total_count bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_view_partner_receipts(auth.uid()) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN QUERY
  WITH f AS (
    SELECT r.* FROM public.partner_receipts r
     WHERE (p_from IS NULL OR r.received_on >= p_from) AND (p_to IS NULL OR r.received_on <= p_to)
       AND (p_method IS NULL OR r.payment_method = p_method) AND (p_status IS NULL OR r.status = p_status)
       AND (p_search IS NULL OR btrim(p_search) = '' OR r.received_from ILIKE '%' || btrim(p_search) || '%'
            OR r.receipt_code ILIKE '%' || btrim(p_search) || '%' OR r.receipt_no::text = btrim(p_search)
            OR r.amount::text = regexp_replace(p_search, '[^0-9]', '', 'g')
            OR coalesce(r.payer_phone, '') LIKE '%' || btrim(p_search) || '%')
  )
  SELECT f.id, f.receipt_no, f.receipt_code, f.received_from, f.payer_phone, f.amount, f.payment_method, f.instrument_no,
         f.drawn_on, f.branch, f.purpose, f.received_on, f.deposit_request_id, f.note, f.status, f.issued_by, ip.full_name,
         f.issued_at, f.cash_confirmed_at, cp.full_name, f.voided_at, f.void_reason, f.supersedes_id, f.superseded_by_id,
         f.delivered_via, f.delivered_at, f.verify_token,
         (SELECT c.id FROM public.partner_receipt_corrections c WHERE c.receipt_id = f.id AND c.status = 'pending'),
         (SELECT count(*) FROM f)
    FROM f
    LEFT JOIN public.profiles ip ON ip.id = f.issued_by
    LEFT JOIN public.profiles cp ON cp.id = f.cash_confirmed_by
   ORDER BY f.receipt_no DESC
   LIMIT least(greatest(p_limit, 1), 500) OFFSET greatest(p_offset, 0);
END $$;

CREATE OR REPLACE FUNCTION public.get_partner_receipt_history(p_receipt_id uuid)
RETURNS TABLE (event text, actor_name text, detail jsonb, at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.can_view_partner_receipts(auth.uid()) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN QUERY SELECT e.event, p.full_name, e.detail, e.at
    FROM public.partner_receipt_events e LEFT JOIN public.profiles p ON p.id = e.actor
   WHERE e.receipt_id = p_receipt_id ORDER BY e.at, e.id;
END $$;

-- ---------- daily closing ----------
CREATE OR REPLACE FUNCTION public.partner_receipts_daily_closing(p_day date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE d date := coalesce(p_day, (now() AT TIME ZONE 'Africa/Kampala')::date);
BEGIN
  IF NOT public.can_view_partner_receipts(auth.uid()) THEN RAISE EXCEPTION 'Not authorized' USING ERRCODE = '42501'; END IF;
  RETURN jsonb_build_object(
    'day', d,
    'issued_count',   (SELECT count(*) FROM public.partner_receipts WHERE received_on = d AND status = 'issued'),
    'issued_total',   (SELECT coalesce(sum(amount), 0) FROM public.partner_receipts WHERE received_on = d AND status = 'issued'),
    'by_method',      (SELECT coalesce(jsonb_object_agg(payment_method, jsonb_build_object('count', c, 'total', t)), '{}'::jsonb)
                         FROM (SELECT payment_method, count(*) c, sum(amount) t FROM public.partner_receipts
                                WHERE received_on = d AND status = 'issued' GROUP BY 1) m),
    'voided_count',   (SELECT count(*) FROM public.partner_receipts WHERE received_on = d AND status = 'voided'),
    'unlinked_count', (SELECT count(*) FROM public.partner_receipts WHERE received_on = d AND status = 'issued' AND deposit_request_id IS NULL),
    'cash_unconfirmed_count', (SELECT count(*) FROM public.partner_receipts WHERE received_on = d AND status = 'issued' AND payment_method = 'cash' AND cash_confirmed_by IS NULL),
    'cash_unconfirmed_total', (SELECT coalesce(sum(amount), 0) FROM public.partner_receipts WHERE received_on = d AND status = 'issued' AND payment_method = 'cash' AND cash_confirmed_by IS NULL),
    'undelivered_count', (SELECT count(*) FROM public.partner_receipts WHERE received_on = d AND status = 'issued' AND delivered_at IS NULL),
    'pending_corrections', (SELECT count(*) FROM public.partner_receipt_corrections WHERE status = 'pending')
  );
END $$;

REVOKE ALL ON FUNCTION
  public.issue_partner_receipt(text,numeric,text,text,date,uuid,text,text,text,text,uuid,text),
  public.confirm_partner_receipt_cash(uuid), public.mark_partner_receipt_delivered(uuid,text),
  public.request_partner_receipt_correction(uuid,text,text,jsonb), public.decide_partner_receipt_correction(uuid,boolean,text),
  public.search_partner_receipts(text,date,date,text,text,integer,integer), public.get_partner_receipt_history(uuid),
  public.partner_receipts_daily_closing(date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.issue_partner_receipt(text,numeric,text,text,date,uuid,text,text,text,text,uuid,text),
  public.confirm_partner_receipt_cash(uuid), public.mark_partner_receipt_delivered(uuid,text),
  public.request_partner_receipt_correction(uuid,text,text,jsonb), public.decide_partner_receipt_correction(uuid,boolean,text),
  public.search_partner_receipts(text,date,date,text,text,integer,integer), public.get_partner_receipt_history(uuid),
  public.partner_receipts_daily_closing(date)
  TO authenticated;
