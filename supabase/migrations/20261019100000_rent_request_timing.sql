-- Rent Plan application timing for the officer rent pipelines: how long a request has been at its CURRENT desk, how long it spent at the
-- immediately PRECEDING desk visit, and its total journey. NEW read-only functions only; nothing existing is altered, nothing is written,
-- no index is added (the lookups use idx_system_events_related, idx_audit_logs_table_record_created and idx_alfa_rent_request).
--
--   rent_request_timing(p_request_ids uuid[])        one jsonb answer for a bounded batch of requests (at most 200), ONE server as_of for the whole answer
--   rent_request_timing_history(p_request_id uuid)   the full visit-by-visit journey of ONE request, loaded on demand
--   _rt_compute(evidence jsonb, as_of timestamptz)   owner-only, pure: evidence in, timing out (so it can be tested at a fixed server time)
--   _rt_evidence(p_ids uuid[])                       owner-only: gathers the evidence of visible requests from the deployed history sources
--   _rt_can_see(p_id, ...)                           (inlined in _rt_evidence) the existing request visibility
--
-- WHAT THE DEPLOYED DATABASE CAN AND CANNOT SAY (verified against the live schema on 2026-10-19; supabase/migrations is not the reference)
--   confirmed history   rent_requests.created_at; the Service Centre verification and rejection (system_events 'rent_request.service_center_verified'
--                       / '.service_center_rejected', and rent_requests.service_center_reviewed_at); returns for correction
--                       ('rent_request.returned_for_correction' in system_events and 'rent_request_returned_for_correction' in audit_logs, which carry
--                       rejected_at_stage / previous_status); resubmissions ('rent_request.resubmitted_by_agent', metadata.returned_to_status);
--                       force approval ('rent_request_force_approved', metadata.moved_to); agent withdrawal ('rent_request.deleted_by_agent').
--   latest stamp only   an ordinary desk approval is recorded ONLY as the latest *_reviewed_at stamp on rent_requests (no per-approval event: the
--                       log_rent_request_event trigger writes only created / approved / funded / disbursed). A later re-approval overwrites the earlier
--                       stamp, so earlier visits of a request that went round again are not recoverable and are labelled as estimates.
--   not recorded        CFO returns to COO, recalls, reopens and skips have no event of their own. A CFO return stamps cfo_reviewed_at, so a stamp
--                       of a later desk on a request that now sits at an earlier desk is treated as a lower bound for the re-entry time (estimated).
--   not this table      service_center_request_events.request_id points at service_center_requests (qualification requests), not rent_requests;
--                       agent_ops_pipeline_stage_events is agent-profile history. Neither is used.
--   a proposal for a minimal append-only recorder is in docs/RENT_TIMING_RECORDER_PROPOSAL.md (NOT applied; it needs approval).
--
-- DEFINITIONS (also in supabase/AGENTS.md)
--   desks, in order      service_center, agent_ops, tenant_ops, landlord_ops, partner_ops, coo, cfo
--   status -> desk       service_center_review -> service_center; pending -> agent_ops; agent_ops_approved / agent_verified -> tenant_ops;
--                        tenant_ops_approved -> landlord_ops; landlord_ops_approved -> partner_ops; partner_ops_approved -> coo;
--                        coo_approved / approved -> cfo. funded / disbursed / repaying / fully_repaid / completed / defaulted = processed.
--                        rejected with returned_at set and no later resubmission = correction (waiting for the agent). Other rejected, cancelled,
--                        deleted_by_agent = ended.
--   current visit        the latest ACTUAL entry into the current desk: the previous desk's approval stamp (or the Service Centre verification), moved
--                        later by a resubmission, a force approval, or a stale stamp of a later desk (a return). Never updated_at.
--   previous visit       the immediately preceding actual visit (including correction waiting); repeated visits stay separate.
--   skipped desk         a desk with no stamp of its own while a later desk was reached: no visit, never a zero-length one.
--   total                from this request's own created_at (a renewal is a new row with a fresh clock) to as_of while it is still being reviewed,
--                        or frozen at the processing endpoint: funded_at for a funded route, rejected_at for a rejection, the withdrawal event for a
--                        withdrawal. Funding, the landlord receiving the money and repayment completion are different endpoints: the review clocks
--                        stop at funded_at; the later payout wait is reported separately under payout.
--   seconds              elapsed seconds, nights and weekends included. No working-day rule, no overdue threshold.
--   quality              confirmed (every timestamp used is an actual event or the stamp of the transition itself), estimated (a lower bound, a
--                        skipped-desk fallback, overwritten earlier visits, or a conflicting / future / inverted timestamp was set aside), unavailable
--                        (the entry time cannot be established: null, with missing_reason).
--
-- ACCESS: auth.uid() required (42501). A request is returned only if the caller can see it, exactly as the rent_requests SELECT policies say: agent_id /
-- tenant_id = the caller, a role granted every row (manager, cfo, coo, ceo, agent_ops, landlord_ops, super_admin, tenant_ops), an agent or manager looking at an
-- unverified pending request, or a supporter looking at their own or an open funding request. (Test: the timed set equals what row-level security gives, per role.) Requests the caller
-- cannot see are simply left out of the answer. More than 200 ids is 22023 TOO_MANY_IDS. SECURITY DEFINER, STABLE, search_path = public; EXECUTE for
-- authenticated only (the helpers: nobody but the owner). No ledger, wallet or payout table is read except agent_landlord_float_allocations
-- (one indexed lookup per request, for the approximate landlord payment time).
-- Rollback: supabase/rollbacks/20261019100000_rent_request_timing.rollback.sql

-- ---------- helpers ----------

-- a timestamp text -> timestamptz, NULL when empty or unparseable
CREATE OR REPLACE FUNCTION public._rt_ts(p text)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE SET search_path = public
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN NULL; END IF;
  RETURN p::timestamptz;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public._rt_desk_of_status(p_status text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT CASE p_status
    WHEN 'service_center_review' THEN 'service_center'
    WHEN 'pending' THEN 'agent_ops'
    WHEN 'agent_ops_approved' THEN 'tenant_ops'
    WHEN 'agent_verified' THEN 'tenant_ops'
    WHEN 'tenant_ops_approved' THEN 'landlord_ops'
    WHEN 'landlord_ops_approved' THEN 'partner_ops'
    WHEN 'partner_ops_approved' THEN 'coo'
    WHEN 'coo_approved' THEN 'cfo'
    WHEN 'approved' THEN 'cfo'
  END;
$$;

CREATE OR REPLACE FUNCTION public._rt_rank(p_desk text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT CASE p_desk WHEN 'service_center' THEN 0 WHEN 'agent_ops' THEN 1 WHEN 'tenant_ops' THEN 2 WHEN 'landlord_ops' THEN 3
                     WHEN 'partner_ops' THEN 4 WHEN 'coo' THEN 5 WHEN 'cfo' THEN 6 END;
$$;

CREATE OR REPLACE FUNCTION public._rt_desk_name(p_rank integer)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public
AS $$
  SELECT (ARRAY['service_center', 'agent_ops', 'tenant_ops', 'landlord_ops', 'partner_ops', 'coo', 'cfo'])[p_rank + 1];
$$;

-- ---------- the pure computation ----------
-- evidence = {
--   created_at, status, sc_managed, registration_type, rejected_at_stage, returned_at, last_resubmitted_at, rejected_at, funded_at, landlord_paid_at,
--   stamps: { service_center, agent_ops, tenant_ops, landlord_ops, partner_ops, coo, cfo },
--   events: [ { kind: service_center_verified | returned | resubmitted | force_approved | deleted, t, stage?, to?, source } ]
-- }
CREATE OR REPLACE FUNCTION public._rt_compute(e jsonb, p_as_of timestamptz, p_with_visits boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_flags text[] := ARRAY[]::text[];
  v_evidence text[] := ARRAY[]::text[];
  v_skipped text[] := ARRAY[]::text[];
  v_status text := e->>'status';
  v_created timestamptz := public._rt_ts(e->>'created_at');
  v_sc_managed boolean := COALESCE((e->>'sc_managed')::boolean, false);
  st timestamptz[] := ARRAY[NULL, NULL, NULL, NULL, NULL, NULL, NULL]::timestamptz[];   -- index 1..7 = stamp of desk rank 0..6
  v_names text[] := ARRAY['service_center', 'agent_ops', 'tenant_ops', 'landlord_ops', 'partner_ops', 'coo', 'cfo'];
  v_t timestamptz;
  v_i int; v_r int;
  v_state text;
  v_cr int;                       -- rank of the desk the request is at (or last reached)
  v_returned_at timestamptz := public._rt_ts(e->>'returned_at');
  v_resub_col timestamptz := public._rt_ts(e->>'last_resubmitted_at');
  v_rejected_at timestamptz := public._rt_ts(e->>'rejected_at');
  v_funded_at timestamptz := public._rt_ts(e->>'funded_at');
  v_paid_at timestamptz := public._rt_ts(e->>'landlord_paid_at');
  v_ev_sc timestamptz; v_ev_return timestamptz; v_ev_resub timestamptz; v_ev_force timestamptz; v_ev_deleted timestamptz;
  v_ev_resub_to text; v_ev_force_to text; v_ev_return_stage text;
  v_resub timestamptz; v_force timestamptz; v_returns int := 0;
  entry timestamptz[] := ARRAY[NULL, NULL, NULL, NULL, NULL, NULL, NULL]::timestamptz[];   -- entry time per desk rank (index = rank + 1)
  entry_q text[] := ARRAY[NULL, NULL, NULL, NULL, NULL, NULL, NULL]::text[];
  v_stale timestamptz;
  v_marks jsonb := '[]'::jsonb;
  v_vis jsonb;
  v_cur jsonb; v_prev jsonb;
  v_current_entry timestamptz; v_current_q text; v_current_src text;
  v_end timestamptz; v_end_q text;
  v_total numeric; v_quality text; v_missing text;
  v_ret_stage_desk text;
  v_rec record;
  v_payout jsonb;
  v_n int;
  v_vd text[]; v_vs timestamptz[]; v_vsrc text[]; v_vq text[];
BEGIN
  IF v_created IS NULL OR v_created > p_as_of THEN
    RETURN jsonb_build_object('state', 'unavailable', 'quality', 'unavailable', 'missing_reason', 'created_at_missing_or_in_the_future',
                              'as_of', p_as_of, 'evidence', to_jsonb(v_evidence), 'flags', to_jsonb(ARRAY['created_at_missing_or_in_the_future']));
  END IF;
  v_evidence := v_evidence || 'created_at'::text;

  -- stamps: set aside future and inverted (before creation) values
  FOR v_i IN 0..6 LOOP
    v_t := public._rt_ts(e->'stamps'->>v_names[v_i + 1]);
    IF v_t IS NULL THEN CONTINUE; END IF;
    IF v_t > p_as_of THEN v_flags := v_flags || ('future_stamp:' || v_names[v_i + 1])::text; CONTINUE; END IF;
    IF v_t < v_created THEN v_flags := v_flags || ('inverted_stamp:' || v_names[v_i + 1])::text; CONTINUE; END IF;
    st[v_i + 1] := v_t;
  END LOOP;
  IF v_funded_at IS NOT NULL AND (v_funded_at > p_as_of OR v_funded_at < v_created) THEN
    v_flags := v_flags || 'bad_funded_at'::text; v_funded_at := NULL;
  END IF;
  IF v_returned_at IS NOT NULL AND (v_returned_at > p_as_of OR v_returned_at < v_created) THEN v_flags := v_flags || 'bad_returned_at'::text; v_returned_at := NULL; END IF;
  IF v_resub_col IS NOT NULL AND (v_resub_col > p_as_of OR v_resub_col < v_created) THEN v_flags := v_flags || 'bad_resubmitted_at'::text; v_resub_col := NULL; END IF;
  IF v_rejected_at IS NOT NULL AND (v_rejected_at > p_as_of OR v_rejected_at < v_created) THEN v_flags := v_flags || 'bad_rejected_at'::text; v_rejected_at := NULL; END IF;
  IF v_paid_at IS NOT NULL AND (v_paid_at > p_as_of OR v_paid_at < v_created) THEN v_flags := v_flags || 'bad_landlord_paid_at'::text; v_paid_at := NULL; END IF;

  -- events (already de-duplicated by the gatherer; a repeat of the same kind within 2 seconds is dropped again here)
  FOR v_rec IN
    SELECT x.kind, x.t, x.stage, x.to_status
      FROM (SELECT j->>'kind' AS kind, public._rt_ts(j->>'t') AS t, j->>'stage' AS stage, j->>'to' AS to_status
              FROM jsonb_array_elements(COALESCE(e->'events', '[]'::jsonb)) j) x
     WHERE x.t IS NOT NULL
     ORDER BY x.t
  LOOP
    IF v_rec.t > p_as_of THEN v_flags := v_flags || ('future_event:' || v_rec.kind)::text; CONTINUE; END IF;
    IF v_rec.t < v_created THEN v_flags := v_flags || ('inverted_event:' || v_rec.kind)::text; CONTINUE; END IF;
    IF v_rec.kind = 'service_center_verified' THEN v_ev_sc := GREATEST(COALESCE(v_ev_sc, v_rec.t), v_rec.t);
    ELSIF v_rec.kind = 'returned' THEN
      IF v_ev_return IS NOT NULL AND v_rec.t - v_ev_return < interval '2 seconds' THEN CONTINUE; END IF;
      v_ev_return := v_rec.t; v_ev_return_stage := v_rec.stage; v_returns := v_returns + 1;
      v_marks := v_marks || jsonb_build_object('t', v_rec.t, 'desk', 'correction', 'src', 'returned_for_correction_event', 'q', 'confirmed', 'from_stage', v_rec.stage);
    ELSIF v_rec.kind = 'resubmitted' THEN
      IF v_ev_resub IS NOT NULL AND v_rec.t - v_ev_resub < interval '2 seconds' THEN CONTINUE; END IF;
      v_ev_resub := v_rec.t; v_ev_resub_to := v_rec.to_status;
      v_marks := v_marks || jsonb_build_object('t', v_rec.t, 'desk', COALESCE(public._rt_desk_of_status(v_rec.to_status), '?'), 'src', 'resubmitted_event', 'q', 'confirmed', 'resubmit', true);
    ELSIF v_rec.kind = 'force_approved' THEN
      IF v_ev_force IS NOT NULL AND v_rec.t - v_ev_force < interval '2 seconds' THEN CONTINUE; END IF;
      v_ev_force := v_rec.t; v_ev_force_to := v_rec.to_status;
      v_marks := v_marks || jsonb_build_object('t', v_rec.t, 'desk', COALESCE(public._rt_desk_of_status(v_rec.to_status), '?'), 'src', 'force_approved_event', 'q', 'confirmed');
    ELSIF v_rec.kind = 'deleted' THEN v_ev_deleted := v_rec.t;
    END IF;
  END LOOP;
  IF v_ev_sc IS NOT NULL THEN v_evidence := v_evidence || 'service_center_verified_event'::text; END IF;
  IF v_ev_return IS NOT NULL THEN v_evidence := v_evidence || 'returned_for_correction_event'::text; END IF;
  IF v_ev_resub IS NOT NULL THEN v_evidence := v_evidence || 'resubmitted_event'::text; END IF;
  IF v_ev_force IS NOT NULL THEN v_evidence := v_evidence || 'force_approved_event'::text; END IF;
  -- columns stand in for a missing event (the latest return / resubmission only)
  IF v_ev_return IS NULL AND v_returned_at IS NOT NULL THEN
    v_ev_return := v_returned_at; v_returns := v_returns + 1; v_evidence := v_evidence || 'returned_at_column'::text;
    v_marks := v_marks || jsonb_build_object('t', v_returned_at, 'desk', 'correction', 'src', 'returned_at_column', 'q', 'confirmed');
  END IF;
  IF v_ev_resub IS NULL AND v_resub_col IS NOT NULL THEN
    v_ev_resub := v_resub_col; v_evidence := v_evidence || 'last_resubmitted_at_column'::text;
    v_marks := v_marks || jsonb_build_object('t', v_resub_col, 'desk', COALESCE(public._rt_desk_of_status(v_status), '?'), 'src', 'last_resubmitted_at_column', 'q', 'estimated', 'resubmit', true);
  END IF;
  v_resub := v_ev_resub; v_force := v_ev_force;
  IF v_ev_sc IS NULL AND st[1] IS NOT NULL THEN v_ev_sc := st[1]; v_evidence := v_evidence || 'service_center_reviewed_at'::text; END IF;

  -- chronology of the approval stamps: a stamp older than the one of an earlier desk conflicts
  FOR v_i IN 2..7 LOOP
    IF st[v_i] IS NOT NULL THEN
      v_r := v_i - 1;
      WHILE v_r >= 1 LOOP
        IF st[v_r] IS NOT NULL THEN
          IF st[v_i] < st[v_r] THEN v_flags := v_flags || ('conflicting_order:' || v_names[v_i] || '_before_' || v_names[v_r])::text; END IF;
          EXIT;
        END IF;
        v_r := v_r - 1;
      END LOOP;
    END IF;
  END LOOP;

  -- ---- where is the request? ----
  IF v_status IN ('funded', 'disbursed', 'repaying', 'fully_repaid', 'completed', 'defaulted') THEN
    v_state := 'processed'; v_cr := 6;
  ELSIF v_status = 'rejected' AND v_returned_at IS NOT NULL AND (v_resub_col IS NULL OR v_returned_at >= v_resub_col) AND (v_ev_resub IS NULL OR v_ev_return IS NULL OR v_ev_return >= v_ev_resub) THEN
    v_state := 'correction';
    v_ret_stage_desk := COALESCE(public._rt_desk_of_status(COALESCE(v_ev_return_stage, e->>'rejected_at_stage')), 'agent_ops');
    v_cr := public._rt_rank(v_ret_stage_desk);
  ELSIF public._rt_desk_of_status(v_status) IS NOT NULL THEN
    v_state := 'at_desk'; v_cr := public._rt_rank(public._rt_desk_of_status(v_status));
  ELSE
    v_state := 'ended';
    -- the furthest desk with evidence of having been reached
    v_cr := CASE WHEN v_sc_managed THEN 0 ELSE 1 END;
    FOR v_i IN 1..5 LOOP IF st[v_i + 1] IS NOT NULL THEN v_cr := GREATEST(v_cr, LEAST(v_i + 1, 6)); END IF; END LOOP;
    IF st[1] IS NOT NULL OR v_ev_sc IS NOT NULL THEN v_cr := GREATEST(v_cr, 1); END IF;
  END IF;

  -- ---- entry time per desk, forwards from creation ----
  IF v_sc_managed THEN
    entry[1] := v_created; entry_q[1] := 'confirmed';
    IF v_ev_sc IS NOT NULL THEN entry[2] := v_ev_sc; entry_q[2] := 'confirmed'; END IF;
  ELSE
    entry[2] := v_created; entry_q[2] := 'confirmed';
  END IF;
  FOR v_r IN 2..LEAST(v_cr, 6) LOOP
    IF st[v_r] IS NOT NULL THEN       -- st[v_r] = stamp of desk rank v_r - 1 = the approval that moved the request into rank v_r
      entry[v_r + 1] := st[v_r]; entry_q[v_r + 1] := 'confirmed';
    ELSIF entry[v_r] IS NOT NULL THEN  -- the earlier desk left no stamp: it was skipped; this desk begins when the last known desk was left
      entry[v_r + 1] := entry[v_r]; entry_q[v_r + 1] := 'estimated';
      v_skipped := v_skipped || v_names[v_r];
    END IF;
  END LOOP;
  -- a desk whose entry equals the next desk's entry was passed through without a visit
  v_skipped := (SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::text[]) FROM unnest(v_skipped) x);

  -- ---- the current visit ----
  v_current_entry := NULL; v_current_q := NULL; v_current_src := NULL;
  IF v_state = 'at_desk' THEN
    v_stale := NULL;
    FOR v_i IN (v_cr + 1)..7 LOOP        -- stamps of the current desk and later desks: a stale approval means a return happened after it
      IF st[v_i] IS NOT NULL AND (v_stale IS NULL OR st[v_i] > v_stale) THEN v_stale := st[v_i]; END IF;
    END LOOP;
    v_current_entry := entry[v_cr + 1]; v_current_q := COALESCE(entry_q[v_cr + 1], 'unavailable'); v_current_src := 'previous_desk_approval_stamp';
    IF v_cr = 1 AND NOT v_sc_managed THEN v_current_src := 'created_at'; END IF;
    IF v_cr = 1 AND v_sc_managed THEN v_current_src := CASE WHEN v_ev_sc IS NOT NULL THEN 'service_center_verification' ELSE 'unavailable' END; END IF;
    IF v_resub IS NOT NULL AND (v_current_entry IS NULL OR v_resub > v_current_entry) AND (v_ev_resub_to IS NULL OR public._rt_desk_of_status(v_ev_resub_to) IS NOT DISTINCT FROM v_names[v_cr + 1] OR true) THEN
      v_current_entry := v_resub; v_current_q := 'confirmed'; v_current_src := 'resubmission';
    END IF;
    IF v_force IS NOT NULL AND (v_current_entry IS NULL OR v_force > v_current_entry) AND public._rt_desk_of_status(v_ev_force_to) IS NOT DISTINCT FROM v_names[v_cr + 1] THEN
      v_current_entry := v_force; v_current_q := 'confirmed'; v_current_src := 'force_approval';
    END IF;
    IF v_stale IS NOT NULL AND (v_current_entry IS NULL OR v_stale > v_current_entry) THEN
      -- the request was at a later desk and came back: the return time is not recorded, a stale stamp is the earliest it can have been
      v_current_entry := v_stale; v_current_q := 'estimated'; v_current_src := 'later_desk_stamp_lower_bound';
      v_flags := v_flags || 'returned_from_later_desk_time_not_recorded'::text;
    END IF;
    IF v_current_entry IS NOT NULL AND v_current_entry > p_as_of THEN v_current_entry := NULL; END IF;
  ELSIF v_state = 'correction' THEN
    v_current_entry := COALESCE(v_ev_return, v_returned_at); v_current_q := CASE WHEN v_current_entry IS NULL THEN 'unavailable' ELSE 'confirmed' END; v_current_src := 'returned_for_correction';
  END IF;

  -- ---- visits: the marks in time order, each ending where the next begins ----
  v_marks := v_marks || jsonb_build_object('t', v_created, 'desk', CASE WHEN v_sc_managed THEN 'service_center' ELSE 'agent_ops' END, 'src', 'created_at', 'q', 'confirmed');
  IF v_sc_managed AND entry[2] IS NOT NULL AND v_ev_sc IS NOT NULL THEN
    v_marks := v_marks || jsonb_build_object('t', v_ev_sc, 'desk', 'agent_ops', 'src', CASE WHEN st[1] IS NOT NULL AND st[1] = v_ev_sc THEN 'service_center_reviewed_at' ELSE 'service_center_verified_event' END, 'q', 'confirmed');
  END IF;
  FOR v_r IN 2..LEAST(v_cr, 6) LOOP
    IF entry[v_r + 1] IS NOT NULL AND entry[v_r + 1] > v_created THEN
      v_marks := v_marks || jsonb_build_object('t', entry[v_r + 1], 'desk', v_names[v_r + 1], 'src', CASE WHEN entry_q[v_r + 1] = 'confirmed' THEN 'approval_stamp:' || v_names[v_r] ELSE 'skipped_desk_fallback' END, 'q', entry_q[v_r + 1]);
    END IF;
  END LOOP;
  IF v_state = 'at_desk' AND v_current_entry IS NOT NULL AND v_current_src IN ('later_desk_stamp_lower_bound') THEN
    v_marks := v_marks || jsonb_build_object('t', v_current_entry, 'desk', v_names[v_cr + 1], 'src', v_current_src, 'q', 'estimated');
  END IF;
  IF v_state = 'processed' AND v_funded_at IS NOT NULL THEN
    v_marks := v_marks || jsonb_build_object('t', v_funded_at, 'desk', 'processed', 'src', 'funded_at', 'q', 'confirmed', 'endpoint', true);
  END IF;

  -- end of the review clock
  IF v_state IN ('at_desk', 'correction') THEN v_end := p_as_of; v_end_q := 'confirmed';
  ELSIF v_state = 'processed' THEN
    IF v_funded_at IS NOT NULL THEN v_end := v_funded_at; v_end_q := 'confirmed';
    ELSIF st[7] IS NOT NULL THEN v_end := st[7]; v_end_q := 'estimated'; v_flags := v_flags || 'funded_at_missing_cfo_stamp_used'::text;
    END IF;
  ELSIF v_status = 'deleted_by_agent' THEN
    v_end := v_ev_deleted; v_end_q := CASE WHEN v_ev_deleted IS NULL THEN NULL ELSE 'confirmed' END;
  ELSIF v_status = 'rejected' THEN v_end := v_rejected_at; v_end_q := CASE WHEN v_rejected_at IS NULL THEN NULL ELSE 'confirmed' END;
  END IF;

  -- the sorted marks -> visits (a mark at the same instant as the previous one means that visit was passed through: a skip, not a visit;
  -- consecutive marks of the same desk merge unless one is a resubmission)
  v_vd := ARRAY[]::text[]; v_vs := ARRAY[]::timestamptz[]; v_vsrc := ARRAY[]::text[]; v_vq := ARRAY[]::text[];
  FOR v_rec IN
    SELECT (m->>'t')::timestamptz AS t, m->>'desk' AS desk, m->>'src' AS src, m->>'q' AS q, (m->>'resubmit') IS NOT NULL AS resub, (m->>'endpoint') IS NOT NULL AS endp
      FROM jsonb_array_elements(v_marks) WITH ORDINALITY AS t(m, ord) ORDER BY (m->>'t')::timestamptz, ord
  LOOP
    IF v_rec.endp THEN CONTINUE; END IF;
    v_n := COALESCE(cardinality(v_vd), 0);
    IF v_n > 0 THEN
      IF v_vd[v_n] = v_rec.desk AND NOT v_rec.resub THEN CONTINUE; END IF;
      IF v_vs[v_n] = v_rec.t THEN
        v_vd := v_vd[1:v_n - 1]; v_vs := v_vs[1:v_n - 1]; v_vsrc := v_vsrc[1:v_n - 1]; v_vq := v_vq[1:v_n - 1];
      END IF;
    END IF;
    v_vd := v_vd || v_rec.desk; v_vs := v_vs || v_rec.t; v_vsrc := v_vsrc || v_rec.src; v_vq := v_vq || v_rec.q;
  END LOOP;
  v_n := COALESCE(cardinality(v_vd), 0);
  v_vis := '[]'::jsonb;
  FOR v_i IN 1..v_n LOOP
    v_t := CASE WHEN v_i < v_n THEN v_vs[v_i + 1] ELSE v_end END;
    v_vis := v_vis || jsonb_build_object('desk', v_vd[v_i], 'start', v_vs[v_i], 'end', v_t,
               'seconds', CASE WHEN v_t IS NULL OR v_t < v_vs[v_i] THEN NULL ELSE round(extract(epoch FROM (v_t - v_vs[v_i]))::numeric, 0) END,
               'source', v_vsrc[v_i], 'quality', v_vq[v_i]);
  END LOOP;

  -- ---- current and previous, taken from the visits ----
  v_n := jsonb_array_length(v_vis);
  v_cur := NULL; v_prev := NULL;
  IF v_state IN ('at_desk', 'correction') AND v_n > 0 THEN
    IF v_current_entry IS NOT NULL THEN
      v_cur := jsonb_build_object('desk', CASE WHEN v_state = 'correction' THEN 'correction' ELSE v_names[v_cr + 1] END, 'entry', v_current_entry,
                                  'seconds', round(extract(epoch FROM (p_as_of - v_current_entry))::numeric, 0), 'quality', v_current_q, 'source', v_current_src);
      -- the previous visit is the one right before the visit that starts at the current entry
      v_prev := NULL;
      FOR v_i IN REVERSE v_n..1 LOOP
        IF v_vs[v_i] < v_current_entry THEN v_prev := v_vis->(v_i - 1); EXIT; END IF;
      END LOOP;
      IF v_prev IS NOT NULL THEN
        v_prev := jsonb_build_object('desk', v_prev->>'desk', 'start', v_prev->'start', 'end', to_jsonb(v_current_entry),
                    'seconds', round(extract(epoch FROM (v_current_entry - (v_prev->>'start')::timestamptz))::numeric, 0),
                    'quality', CASE WHEN v_current_q = 'confirmed' AND (v_prev->>'quality') = 'confirmed' AND (v_returns = 0 OR (v_prev->>'desk') = 'correction') THEN 'confirmed' ELSE 'estimated' END,
                    'source', v_prev->>'source');
      END IF;
    END IF;
  ELSIF v_state IN ('processed', 'ended') AND v_n > 0 THEN
    v_prev := v_vis->(v_n - 1);
    IF v_prev IS NOT NULL AND (v_prev->>'seconds') IS NOT NULL THEN
      v_prev := jsonb_build_object('desk', v_prev->>'desk', 'start', v_prev->'start', 'end', v_prev->'end', 'seconds', v_prev->'seconds',
                  'quality', CASE WHEN (v_prev->>'quality') = 'confirmed' AND v_returns = 0 THEN 'confirmed' ELSE 'estimated' END, 'source', v_prev->>'source');
    ELSE v_prev := NULL; END IF;
  END IF;

  -- ---- total ----
  IF v_end IS NULL THEN
    v_total := NULL; v_missing := 'processing_endpoint_not_recorded';
  ELSE
    v_total := round(extract(epoch FROM (v_end - v_created))::numeric, 0);
  END IF;
  IF v_state IN ('at_desk', 'correction') AND v_current_entry IS NULL THEN
    v_missing := CASE WHEN v_cr = 1 AND v_sc_managed THEN 'service_center_verification_time_not_recorded' ELSE 'approval_stamp_missing_for_the_current_desk' END;
  END IF;

  v_quality := CASE
    WHEN v_state IN ('at_desk', 'correction') AND v_current_entry IS NULL THEN 'unavailable'
    WHEN v_total IS NULL THEN 'unavailable'
    WHEN v_current_q = 'estimated' OR cardinality(v_flags) > 0 OR v_end_q = 'estimated' THEN 'estimated'
    ELSE 'confirmed' END;

  -- later payout waiting is separate from the review clock
  v_payout := NULL;
  IF v_state = 'processed' THEN
    v_payout := jsonb_build_object(
      'funded_at', v_funded_at,
      'landlord_paid_at', v_paid_at,
      'landlord_paid_quality', CASE WHEN v_paid_at IS NULL THEN 'unavailable' ELSE 'estimated' END,
      'waiting_seconds', CASE WHEN v_funded_at IS NULL THEN NULL
                              WHEN v_paid_at IS NULL THEN round(extract(epoch FROM (p_as_of - v_funded_at))::numeric, 0)
                              WHEN v_paid_at >= v_funded_at THEN round(extract(epoch FROM (v_paid_at - v_funded_at))::numeric, 0) END,
      'still_waiting', v_funded_at IS NOT NULL AND v_paid_at IS NULL,
      'repayment_completed_at', NULL,
      'note', 'The landlord payment time is approximate (the earliest update of the landlord allocation). Repayment completion has no recorded time.');
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'state', v_state,
    'desk', CASE WHEN v_state = 'at_desk' THEN v_names[v_cr + 1] WHEN v_state = 'correction' THEN 'agent' END,
    'current', v_cur,
    'previous', v_prev,
    'request_start', v_created,
    'processing_end', v_end,
    'total_seconds', v_total,
    'quality', v_quality,
    'evidence', to_jsonb(v_evidence || ARRAY[COALESCE(v_current_src, 'none')]),
    'missing_reason', v_missing,
    'skipped_desks', to_jsonb(v_skipped),
    'flags', to_jsonb(v_flags),
    'review_returns_recorded', v_returns,
    'payout', v_payout,
    'visits', CASE WHEN p_with_visits THEN v_vis END
  )) || jsonb_build_object('as_of', p_as_of);
END;
$$;

-- ---------- the evidence gatherer (visible requests only) ----------

CREATE OR REPLACE FUNCTION public._rt_evidence(p_ids uuid[])
RETURNS TABLE (request_id uuid, evidence jsonb)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_all boolean;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  -- the roles the rent_requests SELECT policies grant for every row
  v_all := public.has_role(v_uid, 'manager'::app_role) OR public.has_role(v_uid, 'cfo'::app_role) OR public.has_role(v_uid, 'coo'::app_role)
        OR public.has_role(v_uid, 'ceo'::app_role) OR public.has_role(v_uid, 'agent_ops'::app_role) OR public.has_role(v_uid, 'landlord_ops'::app_role)
        OR public.has_role(v_uid, 'super_admin'::app_role) OR public.has_role(v_uid, 'tenant_ops'::app_role);

  RETURN QUERY
  WITH vis AS MATERIALIZED (
    SELECT r.* FROM public.rent_requests r
     WHERE r.id = ANY (p_ids)
       AND (v_all OR r.agent_id = v_uid OR r.tenant_id = v_uid
            -- the other two SELECT policies of rent_requests: unverified pending requests for agents and managers, open funding requests for supporters
            OR (r.agent_verified = false AND r.status IN ('pending', 'approved') AND (public.has_role(v_uid, 'agent'::app_role) OR public.has_role(v_uid, 'manager'::app_role)))
            OR (public.is_supporter() AND (r.supporter_id = v_uid OR (r.status = 'approved' AND r.funded_at IS NULL))))
  ),
  raw AS (
    SELECT s.related_entity_id AS rid, s.created_at AS t, 1 AS pri,
           CASE s.event_type::text
             WHEN 'rent_request.service_center_verified' THEN 'service_center_verified'
             WHEN 'rent_request.returned_for_correction' THEN 'returned'
             WHEN 'rent_request.resubmitted_by_agent' THEN 'resubmitted'
             WHEN 'rent_request_force_approved' THEN 'force_approved'
             WHEN 'rent_request.deleted_by_agent' THEN 'deleted' END AS kind,
           s.metadata->>'rejected_at_stage' AS stage,
           COALESCE(s.metadata->>'returned_to_status', s.metadata->>'moved_to') AS to_status,
           'system_events' AS src
      FROM public.system_events s
     WHERE s.related_entity_type = 'rent_request' AND s.related_entity_id IN (SELECT id FROM vis)
       AND s.event_type::text IN ('rent_request.service_center_verified', 'rent_request.returned_for_correction', 'rent_request.resubmitted_by_agent',
                                  'rent_request_force_approved', 'rent_request.deleted_by_agent')
    UNION ALL
    SELECT a.record_id::uuid, a.created_at, 2,
           CASE a.action_type
             WHEN 'rent_request_returned_for_correction' THEN 'returned'
             WHEN 'rent_request_resubmitted_by_agent' THEN 'resubmitted'
             WHEN 'rent_request_force_approved' THEN 'force_approved'
             WHEN 'rent_request_deleted_by_agent' THEN 'deleted' END,
           a.metadata->>'rejected_at_stage',
           COALESCE(a.metadata->>'returned_to_status', a.metadata->>'moved_to', a.new_values->>'status'),
           'audit_logs'
      FROM public.audit_logs a
     WHERE a.table_name = 'rent_requests' AND a.record_id IN (SELECT id::text FROM vis)
       AND a.action_type IN ('rent_request_returned_for_correction', 'rent_request_resubmitted_by_agent', 'rent_request_force_approved', 'rent_request_deleted_by_agent')
  ),
  ev AS (   -- one system event + one audit row of the same transition are ONE transition: keep the system event, then the audit row
    SELECT DISTINCT ON (rid, kind, floor(extract(epoch FROM t) / 2)) rid, kind, t, stage, to_status, src
      FROM raw WHERE kind IS NOT NULL
     ORDER BY rid, kind, floor(extract(epoch FROM t) / 2), pri
  ),
  evj AS (
    SELECT rid, jsonb_agg(jsonb_build_object('kind', kind, 't', t, 'stage', stage, 'to', to_status, 'source', src) ORDER BY t) AS events FROM ev GROUP BY rid
  ),
  alf AS (
    SELECT a.rent_request_id AS rid, min(a.updated_at) AS paid_at
      FROM public.agent_landlord_float_allocations a
     WHERE a.rent_request_id IN (SELECT id FROM vis) AND a.status <> 'cancelled' AND COALESCE(a.paid_out_amount, 0) > 0
     GROUP BY a.rent_request_id
  )
  SELECT v.id, jsonb_build_object(
    'created_at', v.created_at,
    'status', v.status,
    'sc_managed', v.service_center_manager_id IS NOT NULL,
    'registration_type', v.registration_type,
    'rejected_at_stage', v.rejected_at_stage,
    'returned_at', v.returned_at,
    'last_resubmitted_at', COALESCE(v.last_resubmitted_at, v.resubmitted_at),
    'rejected_at', v.rejected_at,
    'funded_at', v.funded_at,
    'landlord_paid_at', alf.paid_at,
    'stamps', jsonb_build_object(
      'service_center', v.service_center_reviewed_at,
      'agent_ops', COALESCE(v.agent_ops_reviewed_at, v.agent_verified_at),
      'tenant_ops', v.tenant_ops_reviewed_at,
      'landlord_ops', v.landlord_ops_reviewed_at,
      'partner_ops', v.partner_ops_reviewed_at,
      'coo', v.coo_reviewed_at,
      'cfo', v.cfo_reviewed_at),
    'events', COALESCE(evj.events, '[]'::jsonb))
    FROM vis v LEFT JOIN evj ON evj.rid = v.id LEFT JOIN alf ON alf.rid = v.id;
END;
$$;

-- ---------- the public batch contract ----------

CREATE OR REPLACE FUNCTION public.rent_request_timing(p_request_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_of timestamptz := now();
  v_ids uuid[];
  v_out jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x), ARRAY[]::uuid[]) INTO v_ids FROM unnest(COALESCE(p_request_ids, ARRAY[]::uuid[])) x WHERE x IS NOT NULL;
  IF cardinality(v_ids) > 200 THEN RAISE EXCEPTION 'TOO_MANY_IDS: at most 200 request ids per call' USING ERRCODE = '22023'; END IF;

  SELECT jsonb_build_object(
           'as_of', v_as_of,
           'requested', cardinality(v_ids),
           'returned', count(*),
           'rows', COALESCE(jsonb_agg(public._rt_compute(g.evidence, v_as_of) || jsonb_build_object('request_id', g.request_id) ORDER BY g.request_id), '[]'::jsonb))
    INTO v_out
    FROM public._rt_evidence(v_ids) g;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.rent_request_timing_history(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_as_of timestamptz := now();
  v_ev jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501'; END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'REQUEST_REQUIRED: p_request_id is required' USING ERRCODE = '22023'; END IF;
  SELECT g.evidence INTO v_ev FROM public._rt_evidence(ARRAY[p_request_id]) g LIMIT 1;
  IF v_ev IS NULL THEN RETURN NULL; END IF;
  RETURN public._rt_compute(v_ev, v_as_of, true) || jsonb_build_object('request_id', p_request_id, 'events', v_ev->'events');
END;
$$;

COMMENT ON FUNCTION public.rent_request_timing(uuid[]) IS 'Rent Plan application timing (current desk, previous visit, total) for a bounded batch of visible requests, one server as_of. Read-only.';
COMMENT ON FUNCTION public.rent_request_timing_history(uuid) IS 'The visit-by-visit journey of one visible rent request, on demand. Read-only.';

REVOKE ALL ON FUNCTION public._rt_ts(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rt_desk_of_status(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rt_rank(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rt_desk_name(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rt_compute(jsonb, timestamptz, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._rt_evidence(uuid[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rent_request_timing(uuid[]) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.rent_request_timing_history(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.rent_request_timing(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rent_request_timing_history(uuid) TO authenticated;
