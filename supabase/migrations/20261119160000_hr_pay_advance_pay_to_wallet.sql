-- Salary advances: the release step pays the staff wallet (CFO approval 13 Nov 2026).
-- Until now "Record Disbursement" (ceo_approved -> approved) only stamped disbursed_by/at and moved no money, so two
-- advances were shown as disbursed but never paid (paid by hand 13 Nov, docs/finance/corrections/2026-11-13_...).
-- Now: hr_pay_advance_pay_to_wallet pays the advance to the staff wallet (CR L1 / DR A27, as a staff-loan payout) and
-- marks it disbursed in one transaction; the guard refuses ceo_approved -> approved from anywhere else.
-- Preflight pins production's guard of 13 Nov 2026. Rollback: supabase/rollbacks/20261119160000_hr_pay_advance_pay_to_wallet.rollback.sql

DO $pre$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = 'public.hr_pay_advance_guard()'::regprocedure)) <> '9df13bf7ddf908dba1768c13c4507a98' THEN
    RAISE EXCEPTION 'precondition failed: hr_pay_advance_guard is no longer production''s definition of 13 Nov 2026; re-derive this migration';
  END IF;
  IF to_regprocedure('public.hr_pay_advance_pay_to_wallet(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'precondition failed: already installed';
  END IF;
END $pre$;

CREATE OR REPLACE FUNCTION public.hr_pay_advance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    new.status                  := 'requested';
    new.hr_approved_by          := null;
    new.hr_approved_position_id := null;
    new.hr_approved_at          := null;
    new.approved_by             := null;
    new.approved_position_id    := null;
    new.approved_at             := null;
    new.disbursed_by            := null;
    new.disbursed_position_id   := null;
    new.disbursed_at            := null;
    new.requested_at            := coalesce(new.requested_at, now());
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.principal is distinct from old.principal
    or new.staff_id  is distinct from old.staff_id then
      raise exception 'Advance principal and staff cannot be changed. Cancel and raise a new one.';
    end if;

    if new.status is distinct from old.status then
      if old.status = 'requested' and new.status = 'hr_approved' then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may give HR approval to an advance.';
        end if;
        new.hr_approved_by := auth.uid();
        new.hr_approved_position_id := public.hr_pay_position_for('prepare');
        new.hr_approved_at := now();

      elsif old.status = 'hr_approved' and new.status = 'ceo_approved' then
        if not (public.hr_pay_is_approver() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding approve authority may approve an advance.';
        end if;
        new.approved_by := auth.uid();
        new.approved_position_id := public.hr_pay_position_for('approve');
        new.approved_at := now();

      elsif old.status = 'ceo_approved' and new.status = 'approved' then
        if not (public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding release authority may disburse an advance.';
        end if;
        -- CFO 13 Nov 2026: disbursing means paying. Only hr_pay_advance_pay_to_wallet, which credits the staff wallet in
        -- the same transaction, may mark an advance disbursed; a status change on its own is refused.
        if coalesce(current_setting('hr_pay.advance_wallet_payout', true), '') <> new.id::text then
          raise exception 'An advance is disbursed by paying it to the staff wallet (Pay to wallet), not by a status change.';
        end if;
        new.disbursed_by := auth.uid();
        new.disbursed_position_id := public.hr_pay_position_for('release');
        new.disbursed_at := now();

      elsif new.status = 'rejected'
        and old.status in ('requested','hr_approved','ceo_approved') then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_approver()
                or public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin()) then
          raise exception 'You do not hold authority to reject an advance.';
        end if;

      elsif new.status = 'cancelled'
        and old.status in ('requested','hr_approved','ceo_approved') then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may cancel an advance.';
        end if;

      elsif old.status = 'approved' and new.status = 'settled' then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may settle an advance.';
        end if;

      else
        raise exception 'Illegal advance status transition: % to %.', old.status, new.status;
      end if;
    end if;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hr_pay_advance_pay_to_wallet(p_advance_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- Pays a CEO-approved salary advance to the staff member's Welile wallet and marks it disbursed, in ONE transaction:
--   wallet   staff_loan_disbursement cash_in, withdrawable -> CR L1 (the staff wallet rises)
--   platform staff_loan_disbursement cash_out             -> DR A27 (Loans and Advances to Employees)
-- Release authority only; never one's own advance. One payout per advance: the ledger key is fixed to the advance,
-- so a retry returns the payout already made. Payroll recovers it as before.
DECLARE
  a public.hr_pay_advances%ROWTYPE;
  v_uid uuid;
  v_name text;
  v_key text;
  v_ref text;
  v_grp uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;
  IF NOT (public.hr_pay_is_releaser() OR public.hr_pay_is_rule_admin()) THEN
    RAISE EXCEPTION 'Only the position holding release authority may pay out an advance.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO a FROM public.hr_pay_advances WHERE id = p_advance_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ADVANCE_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  v_key := 'salary_advance:wallet_payout:' || a.id::text;
  v_ref := 'SALADV-' || upper(left(replace(a.id::text, '-', ''), 10));
  SELECT s.user_id, NULLIF(btrim(p.full_name), '') INTO v_uid, v_name
    FROM public.hr_staff s LEFT JOIN public.profiles p ON p.id = s.user_id
   WHERE s.id = a.staff_id;

  -- already paid (a retry, or a second click): return that payout
  SELECT transaction_group_id INTO v_grp FROM public.general_ledger WHERE idempotency_key = v_key LIMIT 1;
  IF v_grp IS NOT NULL THEN
    RETURN jsonb_build_object('advance_id', a.id, 'amount', a.principal, 'paid_to', v_name, 'reference', v_ref,
      'ledger_group_id', v_grp, 'status', a.status, 'replayed', true);
  END IF;

  IF a.status <> 'ceo_approved' THEN
    RAISE EXCEPTION 'ADVANCE_NOT_READY_FOR_PAYOUT' USING ERRCODE = '22023', DETAIL = a.status;
  END IF;
  IF v_uid IS NULL OR NOT EXISTS (SELECT 1 FROM public.hr_staff s WHERE s.id = a.staff_id AND s.active) THEN
    RAISE EXCEPTION 'STAFF_WALLET_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_uid = auth.uid() THEN
    RAISE EXCEPTION 'SELF_PAYOUT' USING ERRCODE = '42501', DETAIL = 'An advance cannot be paid out by the person receiving it';
  END IF;
  IF a.principal <> trunc(a.principal) THEN
    RAISE EXCEPTION 'ADVANCE_AMOUNT_INVALID' USING ERRCODE = '22023';
  END IF;

  v_grp := public.create_ledger_transaction(jsonb_build_array(
    jsonb_build_object('ledger_scope', 'wallet', 'direction', 'cash_in', 'amount', a.principal, 'category', 'staff_loan_disbursement',
      'user_id', v_uid, 'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
      'source_table', 'hr_pay_advances', 'source_id', a.id, 'reference_id', v_ref, 'currency', 'UGX',
      'description', format('Salary advance of UGX %s paid to your wallet (recovered from payroll)', a.principal)),
    jsonb_build_object('ledger_scope', 'platform', 'direction', 'cash_out', 'amount', a.principal, 'category', 'staff_loan_disbursement',
      'recipient_type', 'user', 'source_table', 'hr_pay_advances', 'source_id', a.id, 'reference_id', v_ref, 'currency', 'UGX',
      'description', format('Salary advance to %s (UGX %s) paid to the staff wallet; receivable from the employee (A27)',
                            COALESCE(v_name, 'staff member'), a.principal))),
    v_key, false);

  -- the guard records who disbursed and when; it accepts the change only from here
  PERFORM set_config('hr_pay.advance_wallet_payout', a.id::text, true);
  UPDATE public.hr_pay_advances SET status = 'approved' WHERE id = a.id;
  PERFORM set_config('hr_pay.advance_wallet_payout', '', true);

  RETURN jsonb_build_object('advance_id', a.id, 'amount', a.principal, 'paid_to', v_name, 'reference', v_ref,
    'ledger_group_id', v_grp, 'status', 'approved', 'wallet_available', public.get_user_available_balance__impl(v_uid),
    'replayed', false);
END $function$;

REVOKE ALL ON FUNCTION public.hr_pay_advance_pay_to_wallet(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.hr_pay_advance_pay_to_wallet(uuid) TO authenticated, service_role;
