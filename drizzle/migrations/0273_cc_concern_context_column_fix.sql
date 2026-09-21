-- Align cc_concern_context with the live columns: profiles has no address,
-- cc_feedback_categories uses label, cc_cycle_rows has no updated_at.
CREATE OR REPLACE FUNCTION public.cc_concern_context(p_concern_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_c record;
  v_person jsonb := '{}'::jsonb;
  v_call jsonb := '{}'::jsonb;
  v_person_id uuid;
BEGIN
  IF v_uid IS NULL OR NOT public.cc_can_view_concern(p_concern_id, v_uid) THEN
    RETURN NULL;
  END IF;

  SELECT * INTO v_c FROM public.cc_forwarded_concerns WHERE id = p_concern_id;
  IF v_c.id IS NULL THEN
    RETURN NULL;
  END IF;

  v_person_id := v_c.caller_user_id;

  IF v_c.received_call_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'kind', 'received_call',
             'called_at', r.called_at,
             'recorded_by_name', r.recorded_by_name,
             'caller_name_recorded', r.caller_name,
             'caller_phone_recorded', r.caller_phone,
             'linked_kind', r.linked_kind,
             'is_registered', (r.linked_user_id IS NOT NULL),
             'concern', r.concern,
             'notes', r.notes,
             'call_status', r.status,
             'follow_up_at', r.follow_up_at,
             'follow_up_note', r.follow_up_note
           ),
           coalesce(v_person_id, r.linked_user_id)
      INTO v_call, v_person_id
      FROM public.cc_received_calls r
     WHERE r.id = v_c.received_call_id;
  ELSIF v_c.cycle_row_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'kind', 'outbound_call',
             'called_at', coalesce(a.recorded_at, row_.created_at),
             'recorded_by_name', (SELECT coalesce(nullif(btrim(p.full_name), ''), 'Officer') FROM public.profiles p WHERE p.id = a.caller_id),
             'is_registered', true,
             'attempt_outcome', a.outcome::text,
             'channel', a.channel::text,
             'row_state', row_.state::text,
             'attempt_no', a.attempt_no,
             'feedback_note', (SELECT f.note FROM public.cc_feedback f WHERE f.attempt_id = a.id ORDER BY f.created_at DESC LIMIT 1),
             'feedback_severity', (SELECT f.severity::text FROM public.cc_feedback f WHERE f.attempt_id = a.id ORDER BY f.created_at DESC LIMIT 1),
             'feedback_category', (
               SELECT cat.label FROM public.cc_feedback f
                 JOIN public.cc_feedback_categories cat ON cat.id = f.category_id
                WHERE f.attempt_id = a.id ORDER BY f.created_at DESC LIMIT 1
             )
           ),
           coalesce(v_person_id, row_.subject_id)
      INTO v_call, v_person_id
      FROM public.cc_cycle_rows row_
      LEFT JOIN public.cc_call_attempts a ON a.cycle_row_id = row_.id
     WHERE row_.id = v_c.cycle_row_id
     ORDER BY a.recorded_at DESC NULLS LAST
     LIMIT 1;
  END IF;

  IF v_call = '{}'::jsonb THEN
    v_call := jsonb_build_object(
      'kind', CASE WHEN v_c.source_kind = 'received_call' THEN 'received_call' ELSE 'outbound_call' END,
      'called_at', v_c.created_at,
      'is_registered', (v_person_id IS NOT NULL)
    );
  END IF;

  IF v_person_id IS NOT NULL THEN
    SELECT jsonb_build_object(
             'user_id', p.id,
             'full_name', p.full_name,
             'phone', p.phone,
             'email', p.email,
             'district', p.district,
             'national_id', p.national_id,
             'created_at', p.created_at,
             'roles', (SELECT array_agg(DISTINCT ur.role::text) FROM public.user_roles ur WHERE ur.user_id = p.id),
             'agent_name', (
               SELECT nullif(btrim(ap.full_name), '') FROM public.rent_requests rr
                 JOIN public.profiles ap ON ap.id = rr.agent_id
                WHERE rr.tenant_id = p.id AND rr.agent_id IS NOT NULL
                ORDER BY rr.created_at DESC LIMIT 1
             ),
             'agent_phone', (
               SELECT ap.phone FROM public.rent_requests rr
                 JOIN public.profiles ap ON ap.id = rr.agent_id
                WHERE rr.tenant_id = p.id AND rr.agent_id IS NOT NULL
                ORDER BY rr.created_at DESC LIMIT 1
             ),
             'active_plan', (
               SELECT jsonb_build_object(
                        'id', rr.id, 'status', rr.status, 'rent_amount', rr.rent_amount,
                        'total_repayment', rr.total_repayment, 'amount_repaid', rr.amount_repaid,
                        'daily_repayment', rr.daily_repayment, 'created_at', rr.created_at
                      )
                 FROM public.rent_requests rr
                WHERE rr.tenant_id = p.id
                ORDER BY (rr.status IN ('repaying','funded','disbursed')) DESC, rr.created_at DESC
                LIMIT 1
             )
           ) INTO v_person
      FROM public.profiles p
     WHERE p.id = v_person_id;
  END IF;

  RETURN jsonb_build_object(
    'concern_id', v_c.id,
    'source_kind', v_c.source_kind,
    'subject_type', v_c.subject_type,
    'caller_name', v_c.caller_name,
    'person_id', v_person_id,
    'person', coalesce(v_person, '{}'::jsonb),
    'call', v_call
  );
END $$;