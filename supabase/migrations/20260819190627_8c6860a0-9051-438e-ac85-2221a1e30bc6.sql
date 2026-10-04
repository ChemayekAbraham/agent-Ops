-- 1. Attachment table: which ready-to-fund rent plans a promissory note earmarks.
CREATE TABLE public.promissory_note_plan_intents (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  note_id uuid NOT NULL REFERENCES public.promissory_notes(id) ON DELETE CASCADE,
  rent_request_id uuid NOT NULL REFERENCES public.rent_requests(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'reserved',
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT promissory_note_plan_intents_status_check
    CHECK (status IN ('reserved','released','funded')),
  CONSTRAINT promissory_note_plan_intents_unique UNIQUE (note_id, rent_request_id)
);

CREATE INDEX idx_pnpi_note ON public.promissory_note_plan_intents(note_id);
CREATE INDEX idx_pnpi_agent ON public.promissory_note_plan_intents(agent_id);
-- One live reservation per rent plan across all notes.
CREATE UNIQUE INDEX idx_pnpi_live_plan
  ON public.promissory_note_plan_intents(rent_request_id)
  WHERE status = 'reserved';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.promissory_note_plan_intents TO authenticated;
GRANT ALL ON public.promissory_note_plan_intents TO service_role;

ALTER TABLE public.promissory_note_plan_intents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own note plan intents"
  ON public.promissory_note_plan_intents FOR SELECT TO authenticated
  USING (agent_id = (SELECT auth.uid()));

CREATE POLICY "Agents release own note plan intents"
  ON public.promissory_note_plan_intents FOR UPDATE TO authenticated
  USING (agent_id = (SELECT auth.uid()) AND status = 'reserved')
  WITH CHECK (agent_id = (SELECT auth.uid()));

CREATE POLICY "Ops view all note plan intents"
  ON public.promissory_note_plan_intents FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = ANY (ARRAY['operations','cfo','coo','super_admin','manager','partner_ops']::app_role[])
    )
  );

CREATE POLICY "Ops manage all note plan intents"
  ON public.promissory_note_plan_intents FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
      WHERE ur.user_id = (SELECT auth.uid())
        AND ur.role = ANY (ARRAY['operations','cfo','coo','super_admin','manager','partner_ops']::app_role[])
    )
  );

CREATE TRIGGER trg_pnpi_updated_at
  BEFORE UPDATE ON public.promissory_note_plan_intents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Agent-facing reader: ready-to-fund plans, single round trip.
CREATE OR REPLACE FUNCTION public.agent_list_promissory_fundable_plans(
  p_limit integer DEFAULT 30,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL,
  p_max_amount numeric DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rows jsonb;
  v_total integer;
  v_pool numeric;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised to browse fundable plans' USING ERRCODE = '42501';
  END IF;

  WITH available AS (
    SELECT p.rent_request_id,
           p.funding_amount,
           p.daily_repayment,
           p.duration_days,
           p.house_category,
           p.request_city,
           p.tenant_full_name,
           p.tenant_location,
           p.landlord_name,
           p.approved_at,
           p.posted_at
    FROM public.v_partner_self_fundable_plans p
    WHERE p.held_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_plan_intents i
        WHERE i.rent_request_id = p.rent_request_id AND i.status = 'reserved'
      )
      AND (p_max_amount IS NULL OR p.funding_amount <= p_max_amount)
      AND (
        p_search IS NULL OR btrim(p_search) = ''
        OR p.tenant_full_name ILIKE '%' || btrim(p_search) || '%'
        OR COALESCE(p.request_city,'') ILIKE '%' || btrim(p_search) || '%'
        OR COALESCE(p.tenant_location,'') ILIKE '%' || btrim(p_search) || '%'
        OR COALESCE(p.landlord_name,'') ILIKE '%' || btrim(p_search) || '%'
      )
  ), counted AS (
    SELECT a.*, COUNT(*) OVER () AS total_count
    FROM available a
    ORDER BY a.funding_amount DESC, COALESCE(a.approved_at, a.posted_at) DESC NULLS LAST
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 30), 100))
    OFFSET GREATEST(0, COALESCE(p_offset, 0))
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(c) - 'total_count'), '[]'::jsonb),
         COALESCE(MAX(c.total_count), 0)
  INTO v_rows, v_total
  FROM counted c;

  SELECT COALESCE(SUM(a.funding_amount), 0) INTO v_pool
  FROM (
    SELECT p.funding_amount
    FROM public.v_partner_self_fundable_plans p
    WHERE p.held_by IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.promissory_note_plan_intents i
        WHERE i.rent_request_id = p.rent_request_id AND i.status = 'reserved'
      )
  ) a;

  RETURN jsonb_build_object(
    'plans', v_rows,
    'total', v_total,
    'available_pool', v_pool
  );
END;
$$;

REVOKE ALL ON FUNCTION public.agent_list_promissory_fundable_plans(integer, integer, text, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_list_promissory_fundable_plans(integer, integer, text, numeric) TO authenticated;

-- 3. Atomic note creation, optional plan attachments.
CREATE OR REPLACE FUNCTION public.agent_create_promissory_note(
  p_payload jsonb,
  p_rent_request_ids uuid[] DEFAULT '{}'::uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ids uuid[] := COALESCE(p_rent_request_ids, '{}'::uuid[]);
  v_amount numeric := COALESCE((p_payload->>'amount')::numeric, 0);
  v_name text := btrim(COALESCE(p_payload->>'partner_name', ''));
  v_whatsapp text := btrim(COALESCE(p_payload->>'whatsapp_number', ''));
  v_type text := COALESCE(NULLIF(btrim(p_payload->>'contribution_type'), ''), 'once_off');
  v_note public.promissory_notes;
  v_valid integer;
  v_sum numeric := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT (
    public.has_role(v_uid, 'agent') OR public.has_role(v_uid, 'senior_agent')
    OR public.has_role(v_uid, 'sub_agent') OR public.is_ops_role(v_uid)
  ) THEN
    RAISE EXCEPTION 'Not authorised to create promissory notes' USING ERRCODE = '42501';
  END IF;

  IF length(v_name) < 3 THEN
    RAISE EXCEPTION 'Partner name is required' USING ERRCODE = '22023';
  END IF;
  IF length(regexp_replace(v_whatsapp, '\D', '', 'g')) < 9 THEN
    RAISE EXCEPTION 'A valid WhatsApp number is required' USING ERRCODE = '22023';
  END IF;
  IF v_amount <= 0 THEN
    RAISE EXCEPTION 'Promised amount must be greater than zero' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.promissory_notes (
    agent_id, partner_name, whatsapp_number, phone_number, email,
    amount, contribution_type, deduction_day, next_deduction_date
  ) VALUES (
    v_uid, v_name, v_whatsapp,
    NULLIF(btrim(COALESCE(p_payload->>'phone_number','')), ''),
    NULLIF(btrim(COALESCE(p_payload->>'email','')), ''),
    v_amount,
    CASE WHEN v_type = 'monthly' THEN 'monthly' ELSE 'once_off' END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'deduction_day','')::integer END,
    CASE WHEN v_type = 'monthly' THEN NULLIF(p_payload->>'next_deduction_date','')::date END
  )
  RETURNING * INTO v_note;

  IF array_length(v_ids, 1) IS NULL OR array_length(v_ids, 1) = 0 THEN
    RETURN jsonb_build_object('note', to_jsonb(v_note), 'attached_count', 0, 'attached_amount', 0);
  END IF;

  -- Set-based validate + insert: every id must be genuinely fundable and unreserved.
  INSERT INTO public.promissory_note_plan_intents (note_id, rent_request_id, agent_id, amount)
  SELECT v_note.id, p.rent_request_id, v_uid, p.funding_amount
  FROM public.v_partner_self_fundable_plans p
  WHERE p.rent_request_id = ANY (v_ids)
    AND p.held_by IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.promissory_note_plan_intents i
      WHERE i.rent_request_id = p.rent_request_id AND i.status = 'reserved'
    );

  SELECT COUNT(*), COALESCE(SUM(amount), 0) INTO v_valid, v_sum
  FROM public.promissory_note_plan_intents
  WHERE note_id = v_note.id AND status = 'reserved';

  IF v_valid <> array_length(v_ids, 1) THEN
    RAISE EXCEPTION 'PLANS_UNAVAILABLE: some selected rent plans are no longer ready to fund. Refresh and try again, or create the note without attached plans.'
      USING ERRCODE = '23514';
  END IF;

  IF v_sum > v_amount THEN
    RAISE EXCEPTION 'PLANS_EXCEED_AMOUNT: attached plans total more than the promised amount.'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object('note', to_jsonb(v_note), 'attached_count', v_valid, 'attached_amount', v_sum);
END;
$$;

REVOKE ALL ON FUNCTION public.agent_create_promissory_note(jsonb, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.agent_create_promissory_note(jsonb, uuid[]) TO authenticated;