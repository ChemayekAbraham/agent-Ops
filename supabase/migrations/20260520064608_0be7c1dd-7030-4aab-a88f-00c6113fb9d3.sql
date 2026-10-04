CREATE OR REPLACE FUNCTION public.deactivate_stale_proxy_assignments()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  stale RECORD;
  v_actor uuid;
  v_beneficiary_name text;
  v_new_agent_name text;
BEGIN
  IF NEW.is_active = true AND NEW.approval_status = 'approved' THEN
    BEGIN
      v_actor := auth.uid();
    EXCEPTION WHEN OTHERS THEN
      v_actor := NULL;
    END;
    v_actor := COALESCE(v_actor, NEW.assigned_by, NEW.approved_by);

    SELECT full_name INTO v_beneficiary_name
      FROM public.profiles WHERE id = NEW.beneficiary_id;
    SELECT full_name INTO v_new_agent_name
      FROM public.profiles WHERE id = NEW.agent_id;

    FOR stale IN
      SELECT id, agent_id, beneficiary_id, beneficiary_role,
             approval_status, is_managed_account, created_at, updated_at
        FROM public.proxy_agent_assignments
       WHERE beneficiary_id = NEW.beneficiary_id
         AND id <> NEW.id
         AND is_active = true
    LOOP
      UPDATE public.proxy_agent_assignments
         SET is_active = false,
             updated_at = now()
       WHERE id = stale.id;

      INSERT INTO public.audit_logs (
        user_id, action_type, table_name, record_id, metadata
      ) VALUES (
        v_actor,
        'proxy_agent_reassigned',
        'proxy_agent_assignments',
        stale.id::text,
        jsonb_build_object(
          'reason',                  'Auto-deactivated stale proxy assignment on reassignment',
          'beneficiary_id',          NEW.beneficiary_id,
          'beneficiary_role',        stale.beneficiary_role,
          'previous_agent_id',       stale.agent_id,
          'previous_assignment_id',  stale.id,
          'previous_created_at',     stale.created_at,
          'previous_is_managed',     stale.is_managed_account,
          'new_agent_id',            NEW.agent_id,
          'new_assignment_id',       NEW.id,
          'new_approval_status',     NEW.approval_status,
          'reassigned_at',           now(),
          'reassigned_by',           v_actor,
          'source',                  'trg_deactivate_stale_proxy_assignments'
        )
      );

      -- Notify the previous proxy agent so they understand the funder is gone.
      IF stale.agent_id IS NOT NULL AND stale.agent_id <> NEW.agent_id THEN
        INSERT INTO public.notifications (
          user_id, title, message, type, metadata
        ) VALUES (
          stale.agent_id,
          'Funder reassigned to another agent',
          COALESCE(v_beneficiary_name, 'A funder')
            || ' has been reassigned'
            || CASE WHEN v_new_agent_name IS NOT NULL
                    THEN ' to ' || v_new_agent_name
                    ELSE '' END
            || '. They will no longer appear in your funders list.',
          'system',
          jsonb_build_object(
            'event',                  'proxy_agent_reassigned',
            'beneficiary_id',         NEW.beneficiary_id,
            'beneficiary_name',       v_beneficiary_name,
            'previous_assignment_id', stale.id,
            'previous_agent_id',      stale.agent_id,
            'new_agent_id',           NEW.agent_id,
            'new_agent_name',         v_new_agent_name,
            'reassigned_by',          v_actor,
            'reassigned_at',          now()
          )
        );
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;