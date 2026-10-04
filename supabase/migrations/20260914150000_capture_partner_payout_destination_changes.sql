-- Item 49 of tying every action to an IP address: partner payout
-- destination changes -- explicitly flagged in the original proposal's
-- category 3 ("changing the destination and then legitimately initiating
-- a withdrawal" is a common fraud pattern).
--
-- partner_agreements.bank_name / bank_account_number / bank_account_name /
-- payout_mode had ZERO change tracking of any kind -- no audit trigger, no
-- logging, nothing (checked: the only trigger on this table was a plain
-- updated_at bump). Unlike landlords (which already had
-- guard_landlord_agreement_backed_changes detecting and logging exactly
-- this class of change), partners had no equivalent at all.
--
-- Rather than find every current writer of this table first, this follows
-- the established pattern of instrumenting the table itself: a BEFORE
-- UPDATE trigger detects a change to any payout-destination field, and
-- writes directly into audit_logs (action_type
-- partner_payout_destination_changed) with old/new values, the real
-- browser IP (with the edge-runtime-spoofing guard built in from the
-- start), and which specific fields changed. Covers every current and
-- future writer without needing to touch any of them individually.

CREATE OR REPLACE FUNCTION public.log_partner_payout_destination_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_headers jsonb;
  v_ip text;
  v_ua text;
  v_changed text[] := ARRAY[]::text[];
BEGIN
  IF COALESCE(NEW.bank_name,'') IS DISTINCT FROM COALESCE(OLD.bank_name,'') THEN
    v_changed := v_changed || 'bank_name';
  END IF;
  IF COALESCE(NEW.bank_account_number,'') IS DISTINCT FROM COALESCE(OLD.bank_account_number,'') THEN
    v_changed := v_changed || 'bank_account_number';
  END IF;
  IF COALESCE(NEW.bank_account_name,'') IS DISTINCT FROM COALESCE(OLD.bank_account_name,'') THEN
    v_changed := v_changed || 'bank_account_name';
  END IF;
  IF COALESCE(NEW.payout_mode,'') IS DISTINCT FROM COALESCE(OLD.payout_mode,'') THEN
    v_changed := v_changed || 'payout_mode';
  END IF;

  IF array_length(v_changed, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    v_headers := coalesce(current_setting('request.headers', true), '{}')::jsonb;
    v_ua := v_headers ->> 'user-agent';
    IF v_ua IS NOT NULL AND v_ua ILIKE '%SupabaseEdgeRuntime%' THEN
      v_ip := NULL;
      v_ua := NULL;
    ELSE
      v_ip := nullif(split_part(coalesce(v_headers ->> 'x-forwarded-for', ''), ',', 1), '');
      IF v_ip IS NULL THEN
        v_ip := nullif(v_headers ->> 'cf-connecting-ip', '');
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ip := NULL;
    v_ua := NULL;
  END;

  BEGIN
    INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, ip_address, user_agent, old_values, new_values, metadata)
    VALUES (
      auth.uid(), 'partner_payout_destination_changed', 'partner_agreements', NEW.id,
      v_ip, v_ua,
      jsonb_build_object('bank_name', OLD.bank_name, 'bank_account_number', OLD.bank_account_number, 'bank_account_name', OLD.bank_account_name, 'payout_mode', OLD.payout_mode),
      jsonb_build_object('bank_name', NEW.bank_name, 'bank_account_number', NEW.bank_account_number, 'bank_account_name', NEW.bank_account_name, 'payout_mode', NEW.payout_mode),
      jsonb_build_object('fields', to_jsonb(v_changed))
    );
  EXCEPTION WHEN OTHERS THEN NULL;
  END;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_log_partner_payout_destination_change ON public.partner_agreements;
CREATE TRIGGER trg_log_partner_payout_destination_change
  BEFORE UPDATE ON public.partner_agreements
  FOR EACH ROW EXECUTE FUNCTION public.log_partner_payout_destination_change();
