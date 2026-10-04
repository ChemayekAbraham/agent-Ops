-- Locked withdrawal bank account, and applying to change it.
--
-- Today a user can withdraw to any bank account they type in; the mobile money number is locked (user_identity_bindings) but a
-- bank account is not. This locks a user's bank account the moment they save it, so it can only move when Financial
-- Ops approves a change request, after comparing the account name with the user's National ID and reading their reason.
--
-- Enforced in the database so the web and the mobile app are held to the same rule:
--   * locked_bank_accounts          one locked account per user
--   * bank_account_change_requests  the application to change it (one pending at a time)
--   * trigger on withdrawal_requests: a user's own bank withdrawal must use their locked account; a first one locks it
--   * save_/request_/cancel_ functions for the user, finops_ functions for Financial Ops
--
-- Existing users: only an account that has already received a completed withdrawal is locked (the most recent one per
-- user). Anyone else is locked the first time they save or withdraw to an account.
-- Not touched: landlord payouts, system inserts, and withdrawals started by someone else on a user's behalf.

-- 1. Tables ---------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.locked_bank_accounts (
  user_id        uuid PRIMARY KEY,
  bank_name      text NOT NULL,
  account_number text NOT NULL,
  account_name   text NOT NULL,
  account_key    text NOT NULL,
  source         text NOT NULL DEFAULT 'saved' CHECK (source IN ('saved', 'backfill', 'change_approved')),
  locked_at      timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS locked_bank_accounts_key_idx ON public.locked_bank_accounts (account_key);
ALTER TABLE public.locked_bank_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read their own locked bank account" ON public.locked_bank_accounts;
CREATE POLICY "Users read their own locked bank account" ON public.locked_bank_accounts
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Finance staff read locked bank accounts" ON public.locked_bank_accounts;
CREATE POLICY "Finance staff read locked bank accounts" ON public.locked_bank_accounts
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager'));

CREATE TABLE IF NOT EXISTS public.bank_account_change_requests (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL,
  current_bank_name         text,
  current_account_number    text,
  current_account_name      text,
  requested_bank_name       text NOT NULL,
  requested_account_number  text NOT NULL,
  requested_account_name    text NOT NULL,
  request_reason            text NOT NULL,
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  national_id_name          text,
  name_match_score          numeric,
  decided_by                uuid,
  decided_at                timestamptz,
  decision_reason           text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bank_account_change_one_pending ON public.bank_account_change_requests (user_id) WHERE status = 'pending';
ALTER TABLE public.bank_account_change_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read their own bank change requests" ON public.bank_account_change_requests;
CREATE POLICY "Users read their own bank change requests" ON public.bank_account_change_requests
  FOR SELECT TO authenticated USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Finance staff read bank change requests" ON public.bank_account_change_requests;
CREATE POLICY "Finance staff read bank change requests" ON public.bank_account_change_requests
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'cfo')
      OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager'));

-- 2. The user's view of their lock and latest request ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_bank_account_lock()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_lock public.locked_bank_accounts;
  v_req public.bank_account_change_requests;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('locked', false);
  END IF;
  SELECT * INTO v_lock FROM public.locked_bank_accounts WHERE user_id = v_uid;
  SELECT * INTO v_req FROM public.bank_account_change_requests WHERE user_id = v_uid ORDER BY created_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'locked', v_lock.user_id IS NOT NULL,
    'bank_name', v_lock.bank_name,
    'account_number', v_lock.account_number,
    'account_name', v_lock.account_name,
    'locked_at', v_lock.locked_at,
    'request', CASE WHEN v_req.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_req.id, 'status', v_req.status,
      'bank_name', v_req.requested_bank_name, 'account_number', v_req.requested_account_number,
      'account_name', v_req.requested_account_name, 'reason', v_req.request_reason,
      'decision_reason', v_req.decision_reason, 'created_at', v_req.created_at, 'decided_at', v_req.decided_at) END
  );
END;
$function$;

-- 3. Save the bank account: this is what locks it ----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_withdrawal_bank_account(p_bank_name text, p_account_number text, p_account_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_bank text := btrim(coalesce(p_bank_name, ''));
  v_num text := btrim(coalesce(p_account_number, ''));
  v_name text := btrim(regexp_replace(coalesce(p_account_name, ''), '\s+', ' ', 'g'));
  v_digits text := regexp_replace(btrim(coalesce(p_account_number, '')), '\D', '', 'g');
  v_key text;
  v_existing public.locked_bank_accounts;
  v_dest record;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized', 'message', 'Sign in first.');
  END IF;
  IF v_bank = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'missing_bank', 'message', 'Choose your bank.');
  END IF;
  IF length(v_digits) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_account_number', 'message', 'Enter a valid account number.');
  END IF;
  IF array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_name', 'message', 'Enter the account holder''s full name exactly as the bank has it.');
  END IF;

  v_key := public.payout_destination_key('bank_transfer', NULL, v_bank, v_num);
  SELECT * INTO v_existing FROM public.locked_bank_accounts WHERE user_id = v_uid;

  IF v_existing.user_id IS NOT NULL THEN
    IF v_existing.account_key = v_key AND upper(v_existing.account_name) = upper(v_name) THEN
      RETURN jsonb_build_object('success', true, 'code', 'already_locked');
    END IF;
    RETURN jsonb_build_object('success', false, 'code', 'locked',
      'message', 'Your withdrawal bank account is locked. To change it, apply for a change and Financial Ops will confirm the new account is yours.');
  END IF;

  IF EXISTS (SELECT 1 FROM public.locked_bank_accounts WHERE account_key = v_key AND user_id <> v_uid) THEN
    RETURN jsonb_build_object('success', false, 'code', 'account_taken',
      'message', 'That bank account is already registered to another user.');
  END IF;

  INSERT INTO public.locked_bank_accounts (user_id, bank_name, account_number, account_name, account_key, source)
  VALUES (v_uid, v_bank, v_num, v_name, v_key, 'saved');

  -- Put it in front of Financial Ops, which compares the account name with the National ID.
  SELECT * INTO v_dest FROM public.ensure_payout_destination(v_uid, 'bank_transfer', NULL, NULL, NULL, v_bank, v_num, v_name);

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, new_values)
  VALUES (v_uid, 'BANK_ACCOUNT_LOCKED', 'locked_bank_accounts', v_uid::text,
          jsonb_build_object('bank', v_bank, 'last4', right(v_digits, 4)));

  RETURN jsonb_build_object('success', true, 'code', 'locked', 'destination_status', v_dest.status);
END;
$function$;

-- 4. Apply to change a locked account -----------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.request_bank_account_change(p_bank_name text, p_account_number text, p_account_name text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_bank text := btrim(coalesce(p_bank_name, ''));
  v_num text := btrim(coalesce(p_account_number, ''));
  v_name text := btrim(regexp_replace(coalesce(p_account_name, ''), '\s+', ' ', 'g'));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_digits text := regexp_replace(btrim(coalesce(p_account_number, '')), '\D', '', 'g');
  v_key text;
  v_lock public.locked_bank_accounts;
  v_id_name text;
  v_report jsonb;
  v_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'unauthorized', 'message', 'Sign in first.');
  END IF;
  IF v_bank = '' THEN
    RETURN jsonb_build_object('success', false, 'code', 'missing_bank', 'message', 'Choose the bank.');
  END IF;
  IF length(v_digits) < 5 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_account_number', 'message', 'Enter a valid account number.');
  END IF;
  IF array_length(regexp_split_to_array(v_name, '\s+'), 1) < 2 THEN
    RETURN jsonb_build_object('success', false, 'code', 'invalid_name', 'message', 'Enter the account holder''s full name exactly as the bank has it.');
  END IF;
  IF length(v_reason) < 10 THEN
    RETURN jsonb_build_object('success', false, 'code', 'reason_too_short', 'message', 'Explain in at least 10 characters why the account must change.');
  END IF;

  SELECT * INTO v_lock FROM public.locked_bank_accounts WHERE user_id = v_uid;
  IF v_lock.user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'code', 'not_locked', 'message', 'You have no locked bank account yet. Save one instead.');
  END IF;

  v_key := public.payout_destination_key('bank_transfer', NULL, v_bank, v_num);
  IF v_key = v_lock.account_key AND upper(v_name) = upper(v_lock.account_name) THEN
    RETURN jsonb_build_object('success', false, 'code', 'nothing_to_change', 'message', 'These are already your saved bank details.');
  END IF;
  IF v_key <> v_lock.account_key AND EXISTS (SELECT 1 FROM public.locked_bank_accounts WHERE account_key = v_key AND user_id <> v_uid) THEN
    RETURN jsonb_build_object('success', false, 'code', 'account_taken', 'message', 'That bank account is already registered to another user.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.bank_account_change_requests WHERE user_id = v_uid AND status = 'pending') THEN
    RETURN jsonb_build_object('success', false, 'code', 'already_pending', 'message', 'You already have a change waiting for Financial Ops.');
  END IF;

  SELECT coalesce(p.national_id_name, p.full_name) INTO v_id_name FROM public.profiles p WHERE p.id = v_uid;
  v_report := public.payout_name_match_report(v_id_name, v_name);

  INSERT INTO public.bank_account_change_requests (
    user_id, current_bank_name, current_account_number, current_account_name,
    requested_bank_name, requested_account_number, requested_account_name,
    request_reason, national_id_name, name_match_score
  ) VALUES (
    v_uid, v_lock.bank_name, v_lock.account_number, v_lock.account_name,
    v_bank, v_num, v_name, v_reason, v_id_name, (v_report->>'score')::numeric
  )
  RETURNING id INTO v_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, new_values)
  VALUES (v_uid, 'BANK_ACCOUNT_CHANGE_REQUESTED', 'bank_account_change_requests', v_id::text, v_reason,
          jsonb_build_object('from_last4', right(regexp_replace(v_lock.account_number, '\D', '', 'g'), 4),
                             'to_last4', right(v_digits, 4), 'bank', v_bank));

  RETURN jsonb_build_object('success', true, 'code', 'submitted', 'request_id', v_id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.cancel_bank_account_change(p_request_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  UPDATE public.bank_account_change_requests
     SET status = 'cancelled', updated_at = now()
   WHERE id = p_request_id AND user_id = auth.uid() AND status = 'pending';
END;
$function$;

-- 5. Financial Ops: the queue and the decision -----------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finops_bank_account_change_requests(p_status text DEFAULT 'pending')
 RETURNS TABLE(id uuid, user_id uuid, full_name text, phone text, national_id text, national_id_name text,
               current_bank_name text, current_account_number text, current_account_name text,
               requested_bank_name text, requested_account_number text, requested_account_name text,
               request_reason text, status text, name_match_score numeric, decision_reason text,
               decided_by_name text, decided_at timestamptz, created_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'financial_ops') OR public.has_role(auth.uid(), 'cfo')
          OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'manager')) THEN
    RAISE EXCEPTION 'Not allowed.';
  END IF;

  RETURN QUERY
  SELECT r.id, r.user_id, p.full_name, p.phone,
         coalesce(p.national_id, p.linked_national_id), r.national_id_name,
         r.current_bank_name, r.current_account_number, r.current_account_name,
         r.requested_bank_name, r.requested_account_number, r.requested_account_name,
         r.request_reason, r.status, r.name_match_score, r.decision_reason,
         d.full_name, r.decided_at, r.created_at
  FROM public.bank_account_change_requests r
  LEFT JOIN public.profiles p ON p.id = r.user_id
  LEFT JOIN public.profiles d ON d.id = r.decided_by
  WHERE (p_status IS NULL OR p_status = 'all' OR r.status = p_status)
  ORDER BY r.created_at DESC
  LIMIT 200;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finops_decide_bank_account_change(p_request_id uuid, p_decision text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_decision text := lower(btrim(coalesce(p_decision, '')));
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.bank_account_change_requests;
  v_key text;
  v_dest record;
BEGIN
  IF NOT (public.has_role(v_uid, 'financial_ops') OR public.has_role(v_uid, 'cfo')
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'manager')) THEN
    RAISE EXCEPTION 'Only Financial Ops can decide a bank account change.';
  END IF;
  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Decision must be approved or rejected.';
  END IF;
  IF length(v_reason) < 10 THEN
    RAISE EXCEPTION 'Write at least 10 characters explaining the decision.';
  END IF;

  SELECT * INTO v_row FROM public.bank_account_change_requests WHERE id = p_request_id FOR UPDATE;
  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'Request not found.';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'This request was already decided.';
  END IF;
  IF v_row.user_id = v_uid THEN
    RAISE EXCEPTION 'You cannot decide your own bank account change.';
  END IF;

  IF v_decision = 'approved' THEN
    v_key := public.payout_destination_key('bank_transfer', NULL, v_row.requested_bank_name, v_row.requested_account_number);
    IF v_key IS NULL THEN
      RAISE EXCEPTION 'The requested account details are not valid.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.locked_bank_accounts WHERE account_key = v_key AND user_id <> v_row.user_id) THEN
      RAISE EXCEPTION 'That bank account is already registered to another user. Reject this request with that reason.';
    END IF;

    INSERT INTO public.locked_bank_accounts (user_id, bank_name, account_number, account_name, account_key, source)
    VALUES (v_row.user_id, v_row.requested_bank_name, v_row.requested_account_number, v_row.requested_account_name, v_key, 'change_approved')
    ON CONFLICT (user_id) DO UPDATE
      SET bank_name = EXCLUDED.bank_name, account_number = EXCLUDED.account_number,
          account_name = EXCLUDED.account_name, account_key = EXCLUDED.account_key,
          source = 'change_approved', updated_at = now();

    -- Approving is the confirmation that the account is genuinely theirs, so it is verified for withdrawals.
    SELECT * INTO v_dest FROM public.ensure_payout_destination(
      v_row.user_id, 'bank_transfer', NULL, NULL, NULL,
      v_row.requested_bank_name, v_row.requested_account_number, v_row.requested_account_name);

    UPDATE public.payout_destination_verifications
       SET status = 'verified',
           decision_reason = 'Bank account change approved by Financial Ops: ' || v_reason,
           decided_by = v_uid,
           decided_at = now()
     WHERE id = v_dest.id;
  END IF;

  UPDATE public.bank_account_change_requests
     SET status = v_decision, decision_reason = v_reason, decided_by = v_uid, decided_at = now(), updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid,
          CASE WHEN v_decision = 'approved' THEN 'BANK_ACCOUNT_CHANGE_APPROVED' ELSE 'BANK_ACCOUNT_CHANGE_REJECTED' END,
          'bank_account_change_requests', p_request_id::text, v_reason,
          jsonb_build_object('locked_last4', right(regexp_replace(coalesce(v_row.current_account_number, ''), '\D', '', 'g'), 4)),
          jsonb_build_object('owner', v_row.user_id,
                             'new_last4', right(regexp_replace(v_row.requested_account_number, '\D', '', 'g'), 4),
                             'bank', v_row.requested_bank_name));

  RETURN jsonb_build_object('success', true, 'status', v_decision);
END;
$function$;

-- 6. The rule on withdrawals ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_withdrawal_bank_account_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_key text;
  v_lock public.locked_bank_accounts;
BEGIN
  IF NEW.payout_method IS DISTINCT FROM 'bank_transfer' THEN
    RETURN NEW;
  END IF;
  -- Not the user's own request: landlord payouts, system inserts, and staff or proxy requests on their behalf.
  IF NEW.landlord_payout_id IS NOT NULL OR auth.uid() IS NULL OR auth.uid() <> NEW.user_id THEN
    RETURN NEW;
  END IF;

  v_key := public.payout_destination_key('bank_transfer', NULL, NEW.bank_name, NEW.bank_account_number);
  IF v_key IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_lock FROM public.locked_bank_accounts WHERE user_id = NEW.user_id;

  IF v_lock.user_id IS NOT NULL THEN
    IF v_lock.account_key <> v_key THEN
      RAISE EXCEPTION 'Your withdrawal bank account is locked (% ending %). To use a different account, apply for a change in Settings and Financial Ops will confirm it is yours.',
        v_lock.bank_name, right(regexp_replace(v_lock.account_number, '\D', '', 'g'), 4)
        USING ERRCODE = '28000';
    END IF;
    RETURN NEW;
  END IF;

  -- First bank account this user has used: it is locked as it is saved.
  IF EXISTS (SELECT 1 FROM public.locked_bank_accounts WHERE account_key = v_key AND user_id <> NEW.user_id) THEN
    RAISE EXCEPTION 'That bank account is already registered to another user.' USING ERRCODE = '28000';
  END IF;
  INSERT INTO public.locked_bank_accounts (user_id, bank_name, account_number, account_name, account_key, source)
  VALUES (NEW.user_id, btrim(NEW.bank_name), btrim(NEW.bank_account_number),
          btrim(coalesce(NEW.bank_account_name, '')), v_key, 'saved')
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_enforce_withdrawal_bank_account_lock ON public.withdrawal_requests;
CREATE TRIGGER trg_enforce_withdrawal_bank_account_lock
  BEFORE INSERT ON public.withdrawal_requests
  FOR EACH ROW
  WHEN (NEW.payout_method = 'bank_transfer')
  EXECUTE FUNCTION public.enforce_withdrawal_bank_account_lock();

-- 7. Existing users: lock the account their most recent completed bank withdrawal went to --------------------------------------
INSERT INTO public.locked_bank_accounts (user_id, bank_name, account_number, account_name, account_key, source, locked_at)
SELECT DISTINCT ON (w.user_id)
       w.user_id, btrim(w.bank_name), btrim(w.bank_account_number), btrim(coalesce(w.bank_account_name, '')),
       public.payout_destination_key('bank_transfer', NULL, w.bank_name, w.bank_account_number),
       'backfill', coalesce(w.processed_at, w.created_at)
FROM public.withdrawal_requests w
WHERE w.payout_method = 'bank_transfer' AND w.status = 'completed' AND w.landlord_payout_id IS NULL
  AND coalesce(btrim(w.bank_account_number), '') <> '' AND coalesce(btrim(w.bank_name), '') <> ''
ORDER BY w.user_id, coalesce(w.processed_at, w.created_at) DESC
ON CONFLICT (user_id) DO NOTHING;
