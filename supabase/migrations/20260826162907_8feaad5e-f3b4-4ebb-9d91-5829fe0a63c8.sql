-- Reverse Verification (Landlord Ops): additive-only.
-- Lets an OPS user undo a landlord / LC1 verification that was granted or paid
-- by mistake. Existing verification, rejection, bonus and ledger logic is left
-- untouched: this only ADDS a record table, a preview reader and one writer RPC
-- that (a) claws back the verification bonuses through the ledger and
-- (b) hands the status change to the existing set_landlord_verification /
--     set_lc1_verification path so the normal rejection workflow runs.

CREATE TABLE IF NOT EXISTS public.verification_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type IN ('landlord','lc1')),
  entity_id uuid NOT NULL,
  entity_name text,
  agent_id uuid,
  previous_status text NOT NULL,
  previous_verified_at timestamptz,
  reason text NOT NULL,
  actor_id uuid NOT NULL,
  recovery_status text NOT NULL CHECK (recovery_status IN ('nothing_to_recover','fully_recovered','partially_recovered','not_recovered')),
  reversible_amount numeric NOT NULL DEFAULT 0,
  reversed_amount numeric NOT NULL DEFAULT 0,
  unrecovered_amount numeric NOT NULL DEFAULT 0,
  legs jsonb NOT NULL DEFAULT '[]'::jsonb,
  transaction_group_ids uuid[] NOT NULL DEFAULT '{}',
  rejection_charge_amount numeric NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.verification_reversals TO authenticated;
GRANT ALL ON public.verification_reversals TO service_role;

ALTER TABLE public.verification_reversals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Ops and finance can read verification reversals" ON public.verification_reversals;
CREATE POLICY "Ops and finance can read verification reversals"
ON public.verification_reversals FOR SELECT TO authenticated
USING (
  public.is_ops_role(auth.uid())
  OR public.has_role(auth.uid(), 'cfo')
  OR public.has_role(auth.uid(), 'super_admin')
);

-- One reversal per verification episode (entity + the verified_at it was granted at).
CREATE UNIQUE INDEX IF NOT EXISTS verification_reversals_episode_uidx
  ON public.verification_reversals (entity_type, entity_id, COALESCE(previous_verified_at, '-infinity'::timestamptz));

CREATE INDEX IF NOT EXISTS verification_reversals_entity_idx
  ON public.verification_reversals (entity_type, entity_id, created_at DESC);

DROP TRIGGER IF EXISTS update_verification_reversals_updated_at ON public.verification_reversals;
CREATE TRIGGER update_verification_reversals_updated_at
BEFORE UPDATE ON public.verification_reversals
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Preview: what exactly would be reversed (read-only) ────────────────────
CREATE OR REPLACE FUNCTION public.get_verification_reversal_preview(
  p_entity_type text,
  p_entity_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_table text;
  v_name text;
  v_status text;
  v_verified_at timestamptz;
  v_agent uuid;
  v_agent_name text;
  v_legs jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_available numeric := 0;
  v_already jsonb;
BEGIN
  IF NOT public.is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_entity_type NOT IN ('landlord','lc1') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;

  v_table := CASE p_entity_type WHEN 'landlord' THEN 'landlords' ELSE 'lc1_chairpersons' END;

  IF p_entity_type = 'landlord' THEN
    SELECT l.name, COALESCE(l.verification_status, CASE WHEN l.verified THEN 'verified' ELSE 'pending' END),
           l.verified_at, l.registered_by
    INTO v_name, v_status, v_verified_at, v_agent
    FROM public.landlords l WHERE l.id = p_entity_id;
  ELSE
    SELECT c.name, COALESCE(c.verification_status, CASE WHEN c.verified THEN 'verified' ELSE 'pending' END),
           c.verified_at, c.registered_by
    INTO v_name, v_status, v_verified_at, v_agent
    FROM public.lc1_chairpersons c WHERE c.id = p_entity_id;
  END IF;

  IF v_name IS NULL AND v_status IS NULL THEN RAISE EXCEPTION 'Record not found'; END IF;

  SELECT p.full_name INTO v_agent_name FROM public.profiles p WHERE p.id = v_agent;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'ledger_id', gl.id,
           'amount', gl.amount,
           'category', gl.category,
           'description', gl.description,
           'paid_at', gl.created_at,
           'user_id', gl.user_id
         ) ORDER BY gl.created_at), '[]'::jsonb),
         COALESCE(SUM(gl.amount), 0)
  INTO v_legs, v_total
  FROM public.general_ledger gl
  WHERE gl.source_table = v_table
    AND gl.source_id = p_entity_id
    AND gl.ledger_scope = 'wallet'
    AND gl.direction = 'cash_in'
    AND gl.category IN ('agent_commission','recruiter_override')
    AND (gl.classification IS NULL OR gl.classification = 'production')
    AND gl.user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.general_ledger r
      WHERE r.idempotency_key = 'verification_reversal:' || gl.id::text
    );

  IF v_agent IS NOT NULL THEN
    v_available := COALESCE(public.get_user_available_balance(v_agent), 0);
  END IF;

  SELECT to_jsonb(vr) INTO v_already
  FROM public.verification_reversals vr
  WHERE vr.entity_type = p_entity_type AND vr.entity_id = p_entity_id
  ORDER BY vr.created_at DESC LIMIT 1;

  RETURN jsonb_build_object(
    'entity_type', p_entity_type,
    'entity_id', p_entity_id,
    'entity_name', v_name,
    'status', v_status,
    'verified_at', v_verified_at,
    'agent_id', v_agent,
    'agent_name', v_agent_name,
    'agent_available_balance', v_available,
    'reversible_legs', v_legs,
    'reversible_amount', v_total,
    'recoverable_now', LEAST(v_total, v_available),
    'can_reverse', (v_status = 'verified'),
    'already_reversed_for_this_episode', EXISTS (
      SELECT 1 FROM public.verification_reversals vr2
      WHERE vr2.entity_type = p_entity_type AND vr2.entity_id = p_entity_id
        AND COALESCE(vr2.previous_verified_at, '-infinity'::timestamptz) = COALESCE(v_verified_at, '-infinity'::timestamptz)
    ),
    'last_reversal', v_already,
    'rejection_charge_on_reject', 2000
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_verification_reversal_preview(text, uuid) TO authenticated;

-- ── Writer: reverse a verification ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reverse_verification(
  p_entity_type text,
  p_entity_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := btrim(p_reason);
  v_table text;
  v_name text;
  v_status text;
  v_verified_at timestamptz;
  v_agent uuid;
  v_leg RECORD;
  v_group uuid;
  v_groups uuid[] := '{}';
  v_legs jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_reversed numeric := 0;
  v_recovery text;
  v_set jsonb;
  v_row_id uuid;
BEGIN
  IF NOT public.is_ops_role(v_actor) THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_entity_type NOT IN ('landlord','lc1') THEN RAISE EXCEPTION 'Invalid entity_type'; END IF;
  IF v_reason IS NULL OR length(v_reason) < 10 THEN
    RAISE EXCEPTION 'A reason of at least 10 characters is required';
  END IF;

  v_table := CASE p_entity_type WHEN 'landlord' THEN 'landlords' ELSE 'lc1_chairpersons' END;

  IF p_entity_type = 'landlord' THEN
    SELECT l.name, COALESCE(l.verification_status, CASE WHEN l.verified THEN 'verified' ELSE 'pending' END),
           l.verified_at, l.registered_by
    INTO v_name, v_status, v_verified_at, v_agent
    FROM public.landlords l WHERE l.id = p_entity_id FOR UPDATE;
  ELSE
    SELECT c.name, COALESCE(c.verification_status, CASE WHEN c.verified THEN 'verified' ELSE 'pending' END),
           c.verified_at, c.registered_by
    INTO v_name, v_status, v_verified_at, v_agent
    FROM public.lc1_chairpersons c WHERE c.id = p_entity_id FOR UPDATE;
  END IF;

  IF v_status IS NULL THEN RAISE EXCEPTION 'Record not found'; END IF;
  IF v_status <> 'verified' THEN
    RAISE EXCEPTION 'Only a verified record can be reversed (current status: %)', v_status;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.verification_reversals vr
    WHERE vr.entity_type = p_entity_type AND vr.entity_id = p_entity_id
      AND COALESCE(vr.previous_verified_at, '-infinity'::timestamptz) = COALESCE(v_verified_at, '-infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'This verification was already reversed';
  END IF;

  -- 1. Claw back every verification bonus paid out of this record, one balanced
  --    pair per original payment. A payment whose money is no longer in the
  --    agent's withdrawable wallet fails its own debit (the existing ledger
  --    balance guard) and is recorded as unrecovered instead of blocking Ops.
  FOR v_leg IN
    SELECT gl.id, gl.user_id, gl.amount, gl.category, gl.description, gl.created_at
    FROM public.general_ledger gl
    WHERE gl.source_table = v_table
      AND gl.source_id = p_entity_id
      AND gl.ledger_scope = 'wallet'
      AND gl.direction = 'cash_in'
      AND gl.category IN ('agent_commission','recruiter_override')
      AND (gl.classification IS NULL OR gl.classification = 'production')
      AND gl.user_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger r
        WHERE r.idempotency_key = 'verification_reversal:' || gl.id::text
      )
    ORDER BY gl.created_at
  LOOP
    v_total := v_total + v_leg.amount;
    BEGIN
      v_group := public.create_ledger_transaction(
        jsonb_build_array(
          jsonb_build_object(
            'user_id', v_leg.user_id, 'amount', v_leg.amount, 'direction', 'cash_out',
            'category', 'listing_rejection_penalty', 'ledger_scope', 'wallet',
            'wallet_bucket', 'withdrawable', 'recipient_type', 'user',
            'source_table', v_table, 'source_id', p_entity_id::text,
            'reference_id', 'verification-reversal-' || v_leg.id::text,
            'linked_party', COALESCE(v_name, p_entity_type),
            'description', 'Verification reversed by Ops — recovered: ' || COALESCE(v_leg.description, 'verification bonus'),
            'currency', 'UGX'
          ),
          jsonb_build_object(
            'amount', v_leg.amount, 'direction', 'cash_in',
            'category', 'listing_rejection_recovery', 'ledger_scope', 'platform',
            'source_table', v_table, 'source_id', p_entity_id::text,
            'reference_id', 'verification-reversal-' || v_leg.id::text,
            'linked_party', COALESCE(v_name, p_entity_type),
            'description', 'Recovery: verification reversed by Ops — ' || COALESCE(v_name, p_entity_type),
            'currency', 'UGX'
          )
        ),
        'verification_reversal:' || v_leg.id::text
      );
      v_reversed := v_reversed + v_leg.amount;
      v_groups := v_groups || v_group;
      v_legs := v_legs || jsonb_build_object(
        'ledger_id', v_leg.id, 'amount', v_leg.amount, 'category', v_leg.category,
        'description', v_leg.description, 'paid_at', v_leg.created_at,
        'user_id', v_leg.user_id, 'outcome', 'recovered', 'transaction_group_id', v_group
      );
    EXCEPTION WHEN OTHERS THEN
      v_legs := v_legs || jsonb_build_object(
        'ledger_id', v_leg.id, 'amount', v_leg.amount, 'category', v_leg.category,
        'description', v_leg.description, 'paid_at', v_leg.created_at,
        'user_id', v_leg.user_id, 'outcome', 'not_recovered', 'error', SQLERRM
      );
    END;
  END LOOP;

  v_recovery := CASE
    WHEN v_total = 0 THEN 'nothing_to_recover'
    WHEN v_reversed = 0 THEN 'not_recovered'
    WHEN v_reversed < v_total THEN 'partially_recovered'
    ELSE 'fully_recovered'
  END;

  -- 2. Status change goes through the existing, unchanged rejection path so the
  --    normal workflow (status + derived flag + request row + audit log +
  --    transition event + agent/tenant notifications + standard rejection
  --    charge) happens exactly as it does for any other rejection.
  IF p_entity_type = 'landlord' THEN
    v_set := public.set_landlord_verification(p_entity_id, 'rejected', v_reason, 'ops_reversal');
  ELSE
    v_set := public.set_lc1_verification(p_entity_id, 'rejected', v_reason);
  END IF;

  INSERT INTO public.verification_reversals (
    entity_type, entity_id, entity_name, agent_id, previous_status, previous_verified_at,
    reason, actor_id, recovery_status, reversible_amount, reversed_amount, unrecovered_amount,
    legs, transaction_group_ids, rejection_charge_amount
  ) VALUES (
    p_entity_type, p_entity_id, v_name, v_agent, 'verified', v_verified_at,
    v_reason, v_actor, v_recovery, v_total, v_reversed, v_total - v_reversed,
    v_legs, v_groups, COALESCE((v_set->>'charge_amount')::numeric, 0)
  ) RETURNING id INTO v_row_id;

  INSERT INTO public.audit_logs(user_id, action_type, table_name, record_id, metadata)
  VALUES (v_actor, 'verification_reversed', v_table, p_entity_id,
    jsonb_build_object(
      'entity_type', p_entity_type, 'entity_name', v_name, 'reason', v_reason,
      'previous_status', 'verified', 'previous_verified_at', v_verified_at,
      'new_status', 'rejected', 'agent_id', v_agent,
      'reversible_amount', v_total, 'reversed_amount', v_reversed,
      'unrecovered_amount', v_total - v_reversed, 'recovery_status', v_recovery,
      'rejection_charge_amount', COALESCE((v_set->>'charge_amount')::numeric, 0),
      'legs', v_legs, 'reversal_id', v_row_id
    ));

  RETURN jsonb_build_object(
    'ok', true, 'reversal_id', v_row_id,
    'entity_type', p_entity_type, 'entity_id', p_entity_id, 'entity_name', v_name,
    'status', 'rejected', 'agent_id', v_agent,
    'recovery_status', v_recovery,
    'reversible_amount', v_total, 'reversed_amount', v_reversed,
    'unrecovered_amount', v_total - v_reversed,
    'legs', v_legs,
    'rejection_charge_amount', COALESCE((v_set->>'charge_amount')::numeric, 0),
    'rejection_charge_applied', COALESCE((v_set->>'agent_charged')::boolean, false)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.reverse_verification(text, uuid, text) TO authenticated;