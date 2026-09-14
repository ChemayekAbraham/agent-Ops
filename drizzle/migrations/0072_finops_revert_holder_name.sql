CREATE OR REPLACE FUNCTION public.finops_revert_holder_name(p_audit_id uuid, p_reason text DEFAULT NULL::text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_audit public.audit_logs;
  v_old_name text;
  v_current_name text;
  v_target uuid;
  v_dest uuid;
  v_reason text := btrim(coalesce(p_reason, 'Admin rollback of a holder name adopted in error during payout verification.'));
BEGIN
  IF v_uid IS NULL OR NOT (
    public.has_role(v_uid, 'cfo') OR public.has_role(v_uid, 'super_admin')
  ) THEN
    RAISE EXCEPTION 'Only an administrator can roll back a verified holder name.';
  END IF;

  SELECT * INTO v_audit FROM public.audit_logs WHERE id = p_audit_id;
  IF v_audit.id IS NULL
     OR v_audit.table_name <> 'profiles'
     OR v_audit.action_type NOT IN ('payout_holder_name_from_national_id', 'payout_holder_name_manual_override') THEN
    RAISE EXCEPTION 'That name change cannot be rolled back.';
  END IF;

  v_target := nullif(v_audit.record_id, '')::uuid;
  v_old_name := btrim(coalesce(v_audit.old_values->>'full_name', ''));
  IF length(v_old_name) < 3 THEN
    RAISE EXCEPTION 'The previous name was not recorded, so it cannot be restored.';
  END IF;

  SELECT full_name INTO v_current_name FROM public.profiles WHERE id = v_target;
  IF v_current_name IS NULL THEN
    RAISE EXCEPTION 'Account not found.';
  END IF;

  UPDATE public.profiles SET full_name = v_old_name, updated_at = now() WHERE id = v_target;

  v_dest := nullif(v_audit.new_values->>'destination_id', '')::uuid;
  IF v_dest IS NOT NULL THEN
    UPDATE public.payout_destination_verifications
       SET final_name_override = NULL,
           final_name_override_by = NULL,
           final_name_override_at = NULL
     WHERE id = v_dest;
  ELSE
    UPDATE public.payout_destination_verifications
       SET final_name_override = NULL,
           final_name_override_by = NULL,
           final_name_override_at = NULL
     WHERE user_id = v_target
       AND final_name_override IS NOT NULL;
  END IF;

  IF length(v_reason) < 10 THEN
    v_reason := 'Admin rollback of a holder name adopted in error during payout verification.';
  END IF;

  INSERT INTO public.audit_logs (user_id, action_type, table_name, record_id, reason, old_values, new_values)
  VALUES (v_uid, 'payout_holder_name_reverted', 'profiles', v_target::text, v_reason,
          jsonb_build_object('full_name', v_current_name),
          jsonb_build_object('full_name', v_old_name, 'source', 'admin_rollback', 'reverted_audit_id', p_audit_id));

  RETURN jsonb_build_object('success', true, 'full_name', v_old_name, 'user_id', v_target);
END;
$function$;

DROP FUNCTION IF EXISTS public.finops_holder_name_history(uuid);

CREATE FUNCTION public.finops_holder_name_history(p_user_id uuid)
RETURNS TABLE(id uuid, changed_at timestamp with time zone, changed_by uuid, changed_by_name text, old_name text, new_name text, source text, reason text, can_revert boolean)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT a.id,
         a.created_at AS changed_at,
         a.user_id AS changed_by,
         p.full_name AS changed_by_name,
         a.old_values->>'full_name' AS old_name,
         a.new_values->>'full_name' AS new_name,
         coalesce(a.new_values->>'source', 'national_id_ocr') AS source,
         a.reason,
         (
           a.action_type IN ('payout_holder_name_from_national_id', 'payout_holder_name_manual_override')
           AND length(btrim(coalesce(a.old_values->>'full_name', ''))) >= 3
           AND NOT EXISTS (
             SELECT 1 FROM public.audit_logs r
             WHERE r.action_type = 'payout_holder_name_reverted'
               AND r.new_values->>'reverted_audit_id' = a.id::text
           )
         ) AS can_revert
  FROM public.audit_logs a
  LEFT JOIN public.profiles p ON p.id = a.user_id
  WHERE a.table_name = 'profiles'
    AND a.record_id = p_user_id::text
    AND a.action_type IN ('payout_holder_name_from_national_id', 'payout_holder_name_manual_override', 'payout_holder_name_reverted')
    AND (
      auth.uid() IS NOT NULL AND (
        public.has_role(auth.uid(), 'financial_ops')
        OR public.has_role(auth.uid(), 'cfo')
        OR public.has_role(auth.uid(), 'super_admin')
      )
    )
  ORDER BY a.created_at DESC
  LIMIT 50;
$function$;