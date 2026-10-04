
-- ============================================================
-- Deposit Bridge — Reliable Financial Event Delivery
-- ============================================================

-- 1) EVENTS TABLE (durable queue / outbox)
CREATE TABLE IF NOT EXISTS public.deposit_bridge_events (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('deposit_request','gmail_transaction')),
  source_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  transaction_id TEXT,
  user_id UUID,
  amount NUMERIC(20,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','PROCESSING','DELIVERED','FAILED','RETRYING','DEAD_LETTER')),
  attempt INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  worker_id TEXT,
  correlation_id UUID NOT NULL DEFAULT gen_random_uuid(),
  wallet_transaction_group_id UUID,
  ledger_verified_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  dead_lettered_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dbe_status_next ON public.deposit_bridge_events(status, next_attempt_at) WHERE status IN ('PENDING','RETRYING');
CREATE INDEX IF NOT EXISTS idx_dbe_status ON public.deposit_bridge_events(status);
CREATE INDEX IF NOT EXISTS idx_dbe_user ON public.deposit_bridge_events(user_id);
CREATE INDEX IF NOT EXISTS idx_dbe_source ON public.deposit_bridge_events(source, source_id);
CREATE INDEX IF NOT EXISTS idx_dbe_created ON public.deposit_bridge_events(created_at DESC);

GRANT SELECT ON public.deposit_bridge_events TO authenticated;
GRANT ALL ON public.deposit_bridge_events TO service_role;
ALTER TABLE public.deposit_bridge_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view bridge events"
  ON public.deposit_bridge_events FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'cto') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'financial_ops') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'ceo')
  );

-- 2) EVENT LOG (audit trail)
CREATE TABLE IF NOT EXISTS public.deposit_bridge_event_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  event_id UUID NOT NULL REFERENCES public.deposit_bridge_events(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  attempt INT,
  worker_id TEXT,
  message TEXT,
  error TEXT,
  latency_ms INT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dbel_event ON public.deposit_bridge_event_log(event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dbel_created ON public.deposit_bridge_event_log(created_at DESC);

GRANT SELECT ON public.deposit_bridge_event_log TO authenticated;
GRANT ALL ON public.deposit_bridge_event_log TO service_role;
ALTER TABLE public.deposit_bridge_event_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view bridge event log"
  ON public.deposit_bridge_event_log FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'cto') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'financial_ops') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'ceo')
  );

-- 3) GAP ALERTS
CREATE TABLE IF NOT EXISTS public.deposit_bridge_gap_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL,
  source_id UUID NOT NULL,
  transaction_id TEXT,
  user_id UUID,
  amount NUMERIC(20,2),
  approved_at TIMESTAMPTZ,
  alert_reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high' CHECK (severity IN ('low','medium','high','critical')),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_notes TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_dbga_unresolved ON public.deposit_bridge_gap_alerts(detected_at DESC) WHERE resolved_at IS NULL;

GRANT SELECT, UPDATE ON public.deposit_bridge_gap_alerts TO authenticated;
GRANT ALL ON public.deposit_bridge_gap_alerts TO service_role;
ALTER TABLE public.deposit_bridge_gap_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff can view gap alerts"
  ON public.deposit_bridge_gap_alerts FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'cto') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'financial_ops') OR
    public.has_role(auth.uid(), 'coo') OR
    public.has_role(auth.uid(), 'ceo')
  );

CREATE POLICY "Staff can resolve gap alerts"
  ON public.deposit_bridge_gap_alerts FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'cfo') OR
    public.has_role(auth.uid(), 'cto') OR
    public.has_role(auth.uid(), 'super_admin') OR
    public.has_role(auth.uid(), 'financial_ops')
  );

-- 4) updated_at trigger
CREATE OR REPLACE FUNCTION public.touch_deposit_bridge_events()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_touch_dbe ON public.deposit_bridge_events;
CREATE TRIGGER trg_touch_dbe BEFORE UPDATE ON public.deposit_bridge_events
  FOR EACH ROW EXECUTE FUNCTION public.touch_deposit_bridge_events();

-- 5) STATE-TRANSITION LOG TRIGGER (auto-audit)
CREATE OR REPLACE FUNCTION public.log_deposit_bridge_transition()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.deposit_bridge_event_log(event_id, from_status, to_status, attempt, worker_id, message)
    VALUES (NEW.id, NULL, NEW.status, NEW.attempt, NEW.worker_id, 'Event created');
  ELSIF TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO public.deposit_bridge_event_log(event_id, from_status, to_status, attempt, worker_id, message, error)
    VALUES (NEW.id, OLD.status, NEW.status, NEW.attempt, NEW.worker_id,
            'State transition',
            CASE WHEN NEW.status IN ('FAILED','RETRYING','DEAD_LETTER') THEN NEW.last_error ELSE NULL END);
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_log_dbe ON public.deposit_bridge_events;
CREATE TRIGGER trg_log_dbe AFTER INSERT OR UPDATE ON public.deposit_bridge_events
  FOR EACH ROW EXECUTE FUNCTION public.log_deposit_bridge_transition();

-- 6) ENQUEUE RPC (idempotent)
CREATE OR REPLACE FUNCTION public.enqueue_deposit_bridge_event(
  p_source TEXT,
  p_source_id UUID,
  p_transaction_id TEXT,
  p_user_id UUID,
  p_amount NUMERIC,
  p_metadata JSONB DEFAULT '{}'::jsonb
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_key TEXT;
  v_id UUID;
BEGIN
  IF p_source_id IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN
    RETURN NULL;
  END IF;
  v_key := p_source || ':' || p_source_id::text;

  INSERT INTO public.deposit_bridge_events(
    source, source_id, idempotency_key, transaction_id,
    user_id, amount, metadata
  ) VALUES (
    p_source, p_source_id, v_key, p_transaction_id,
    p_user_id, p_amount, COALESCE(p_metadata,'{}'::jsonb)
  )
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;
END; $$;

-- 7) DEPOSIT_REQUESTS TRIGGER
CREATE OR REPLACE FUNCTION public.trg_enqueue_on_deposit_approved()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.status = 'approved')
     OR (TG_OP = 'INSERT' AND NEW.status = 'approved') THEN
    PERFORM public.enqueue_deposit_bridge_event(
      'deposit_request',
      NEW.id,
      NEW.transaction_id,
      NEW.user_id,
      NEW.amount,
      jsonb_build_object(
        'provider', NEW.provider,
        'deposit_purpose', NEW.deposit_purpose,
        'auto_approved', NEW.auto_approved
      )
    );
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_dr_bridge_enqueue ON public.deposit_requests;
CREATE TRIGGER trg_dr_bridge_enqueue AFTER INSERT OR UPDATE ON public.deposit_requests
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_on_deposit_approved();

-- 8) GMAIL_TRANSACTIONS TRIGGER (auto-match path)
CREATE OR REPLACE FUNCTION public.trg_enqueue_on_gmail_match()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_user UUID;
BEGIN
  IF NEW.linked_deposit_request_id IS NOT NULL AND
     (TG_OP = 'INSERT' OR OLD.linked_deposit_request_id IS DISTINCT FROM NEW.linked_deposit_request_id) THEN
    SELECT user_id INTO v_user FROM public.deposit_requests WHERE id = NEW.linked_deposit_request_id;
    PERFORM public.enqueue_deposit_bridge_event(
      'gmail_transaction',
      NEW.id,
      NEW.transaction_id,
      v_user,
      NEW.amount,
      jsonb_build_object(
        'gmail_message_id', NEW.gmail_message_id,
        'linked_deposit_request_id', NEW.linked_deposit_request_id
      )
    );
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_gt_bridge_enqueue ON public.gmail_transactions;
CREATE TRIGGER trg_gt_bridge_enqueue AFTER INSERT OR UPDATE ON public.gmail_transactions
  FOR EACH ROW EXECUTE FUNCTION public.trg_enqueue_on_gmail_match();

-- 9) CLAIM RPC (worker uses SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.claim_deposit_bridge_events(
  p_worker_id TEXT,
  p_batch_size INT DEFAULT 25
) RETURNS SETOF public.deposit_bridge_events
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT id FROM public.deposit_bridge_events
    WHERE status IN ('PENDING','RETRYING')
      AND next_attempt_at <= now()
    ORDER BY next_attempt_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.deposit_bridge_events e
  SET status = 'PROCESSING',
      worker_id = p_worker_id,
      attempt = e.attempt + 1
  FROM claimed
  WHERE e.id = claimed.id
  RETURNING e.*;
END; $$;

-- 10) VERIFY: does the ledger already carry this credit?
CREATE OR REPLACE FUNCTION public.deposit_bridge_ledger_present(
  p_source TEXT,
  p_source_id UUID,
  p_transaction_id TEXT,
  p_user_id UUID,
  p_amount NUMERIC
) RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_group UUID;
BEGIN
  -- Prefer explicit source_table/source_id linkage on wallet-scope credit
  SELECT transaction_group_id INTO v_group
  FROM public.general_ledger
  WHERE source_table = 'deposit_requests'
    AND source_id = CASE WHEN p_source='deposit_request' THEN p_source_id ELSE NULL END
    AND ledger_scope = 'wallet'
    AND direction = 'cash_in'
  LIMIT 1;
  IF v_group IS NOT NULL THEN RETURN v_group; END IF;

  -- Fallback: reconciled TID list
  IF p_transaction_id IS NOT NULL THEN
    PERFORM 1 FROM public.ledger_reconciled_tids
    WHERE tid_normalized = regexp_replace(coalesce(p_transaction_id,''), '\\s','','g');
    IF FOUND THEN RETURN gen_random_uuid(); END IF;
  END IF;

  -- Fallback: user + amount + wallet cash_in within 24h of the source row
  IF p_user_id IS NOT NULL THEN
    SELECT transaction_group_id INTO v_group
    FROM public.general_ledger
    WHERE user_id = p_user_id
      AND ledger_scope = 'wallet'
      AND direction = 'cash_in'
      AND amount = p_amount
      AND created_at >= now() - interval '48 hours'
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  RETURN v_group;
END; $$;

-- 11) MARK DELIVERED
CREATE OR REPLACE FUNCTION public.mark_deposit_bridge_delivered(
  p_event_id UUID,
  p_group_id UUID,
  p_latency_ms INT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.deposit_bridge_events
  SET status = 'DELIVERED',
      wallet_transaction_group_id = COALESCE(p_group_id, wallet_transaction_group_id),
      ledger_verified_at = now(),
      delivered_at = now(),
      last_error = NULL
  WHERE id = p_event_id AND status <> 'DELIVERED';

  INSERT INTO public.deposit_bridge_event_log(event_id, to_status, message, latency_ms)
  VALUES (p_event_id, 'DELIVERED', 'Ledger credit verified', p_latency_ms);
END; $$;

-- 12) MARK FAILED with exponential backoff
CREATE OR REPLACE FUNCTION public.mark_deposit_bridge_failed(
  p_event_id UUID,
  p_error TEXT
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_attempt INT;
  v_max INT;
  v_delay INTERVAL;
BEGIN
  SELECT attempt, max_attempts INTO v_attempt, v_max
  FROM public.deposit_bridge_events WHERE id = p_event_id;

  v_delay := CASE v_attempt
    WHEN 1 THEN interval '10 seconds'
    WHEN 2 THEN interval '30 seconds'
    WHEN 3 THEN interval '2 minutes'
    WHEN 4 THEN interval '5 minutes'
    ELSE interval '15 minutes'
  END;

  IF v_attempt >= v_max THEN
    UPDATE public.deposit_bridge_events
    SET status = 'DEAD_LETTER',
        dead_lettered_at = now(),
        last_error = p_error
    WHERE id = p_event_id;
  ELSE
    UPDATE public.deposit_bridge_events
    SET status = 'RETRYING',
        next_attempt_at = now() + v_delay,
        last_error = p_error
    WHERE id = p_event_id;
  END IF;
END; $$;

-- 13) REPLAY (admin, from DLQ)
CREATE OR REPLACE FUNCTION public.replay_deposit_bridge_event(p_event_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (public.has_role(auth.uid(),'cfo') OR public.has_role(auth.uid(),'cto')
          OR public.has_role(auth.uid(),'super_admin') OR public.has_role(auth.uid(),'financial_ops')) THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE public.deposit_bridge_events
  SET status = 'PENDING',
      attempt = 0,
      next_attempt_at = now(),
      last_error = NULL,
      worker_id = NULL,
      dead_lettered_at = NULL
  WHERE id = p_event_id;

  INSERT INTO public.deposit_bridge_event_log(event_id, to_status, message)
  VALUES (p_event_id, 'PENDING', 'Manual replay by ' || coalesce(auth.uid()::text,'system'));
END; $$;

-- 14) HEALTH RPC
CREATE OR REPLACE FUNCTION public.get_deposit_bridge_health()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pending INT; v_processing INT; v_retrying INT; v_delivered_24h INT;
  v_failed_24h INT; v_dlq INT; v_oldest_pending TIMESTAMPTZ; v_last_delivered TIMESTAMPTZ;
  v_success_rate NUMERIC; v_avg_latency NUMERIC; v_gap_open INT;
  v_status TEXT;
BEGIN
  SELECT count(*) FILTER (WHERE status='PENDING'),
         count(*) FILTER (WHERE status='PROCESSING'),
         count(*) FILTER (WHERE status='RETRYING'),
         count(*) FILTER (WHERE status='DEAD_LETTER'),
         min(created_at) FILTER (WHERE status IN ('PENDING','RETRYING'))
  INTO v_pending, v_processing, v_retrying, v_dlq, v_oldest_pending
  FROM public.deposit_bridge_events;

  SELECT count(*) FILTER (WHERE status='DELIVERED' AND delivered_at > now()-interval '24 hours'),
         count(*) FILTER (WHERE status IN ('FAILED','DEAD_LETTER') AND updated_at > now()-interval '24 hours'),
         max(delivered_at)
  INTO v_delivered_24h, v_failed_24h, v_last_delivered
  FROM public.deposit_bridge_events;

  v_success_rate := CASE WHEN (v_delivered_24h + v_failed_24h) = 0 THEN 100
                         ELSE round(100.0 * v_delivered_24h / NULLIF(v_delivered_24h + v_failed_24h,0), 2) END;

  SELECT round(avg(EXTRACT(EPOCH FROM (delivered_at - created_at))*1000)::numeric, 0)
  INTO v_avg_latency
  FROM public.deposit_bridge_events
  WHERE status='DELIVERED' AND delivered_at > now() - interval '24 hours';

  SELECT count(*) INTO v_gap_open FROM public.deposit_bridge_gap_alerts WHERE resolved_at IS NULL;

  v_status := CASE
    WHEN v_dlq > 0 OR v_gap_open > 0 THEN 'unhealthy'
    WHEN v_success_rate < 99.9 OR (v_oldest_pending IS NOT NULL AND v_oldest_pending < now() - interval '10 minutes') THEN 'degraded'
    ELSE 'healthy'
  END;

  RETURN jsonb_build_object(
    'status', v_status,
    'pending', v_pending,
    'processing', v_processing,
    'retrying', v_retrying,
    'dead_letter', v_dlq,
    'delivered_24h', v_delivered_24h,
    'failed_24h', v_failed_24h,
    'success_rate', v_success_rate,
    'average_latency_ms', COALESCE(v_avg_latency,0),
    'oldest_pending_at', v_oldest_pending,
    'last_delivered_at', v_last_delivered,
    'open_gap_alerts', v_gap_open,
    'checked_at', now()
  );
END; $$;

-- 15) METRICS (Prometheus-style counters as JSON)
CREATE OR REPLACE FUNCTION public.get_deposit_bridge_metrics()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v JSONB;
BEGIN
  SELECT jsonb_build_object(
    'bridge_events_total', (SELECT count(*) FROM public.deposit_bridge_events),
    'bridge_retries_total', (SELECT coalesce(sum(attempt),0) FROM public.deposit_bridge_events WHERE attempt > 1),
    'bridge_failures_total', (SELECT count(*) FROM public.deposit_bridge_events WHERE status IN ('FAILED','DEAD_LETTER')),
    'bridge_queue_depth', (SELECT count(*) FROM public.deposit_bridge_events WHERE status IN ('PENDING','RETRYING','PROCESSING')),
    'bridge_dead_letter_total', (SELECT count(*) FROM public.deposit_bridge_events WHERE status='DEAD_LETTER'),
    'bridge_gap_detected_total', (SELECT count(*) FROM public.deposit_bridge_gap_alerts),
    'bridge_gap_open', (SELECT count(*) FROM public.deposit_bridge_gap_alerts WHERE resolved_at IS NULL),
    'bridge_delivered_24h', (SELECT count(*) FROM public.deposit_bridge_events WHERE status='DELIVERED' AND delivered_at > now()-interval '24 hours'),
    'bridge_latency_ms_p50', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at-created_at))*1000)::numeric,0) FROM public.deposit_bridge_events WHERE status='DELIVERED' AND delivered_at > now()-interval '24 hours'),
    'bridge_latency_ms_p95', (SELECT round(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at-created_at))*1000)::numeric,0) FROM public.deposit_bridge_events WHERE status='DELIVERED' AND delivered_at > now()-interval '24 hours')
  ) INTO v;
  RETURN v;
END; $$;

-- 16) GAP DETECTOR
CREATE OR REPLACE FUNCTION public.detect_deposit_bridge_gaps()
RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_inserted INT := 0;
BEGIN
  WITH candidates AS (
    SELECT dr.id, dr.transaction_id, dr.user_id, dr.amount, dr.approved_at
    FROM public.deposit_requests dr
    WHERE dr.status = 'approved'
      AND dr.approved_at IS NOT NULL
      AND dr.approved_at BETWEEN now() - interval '7 days' AND now() - interval '3 minutes'
      AND NOT EXISTS (
        SELECT 1 FROM public.general_ledger gl
        WHERE gl.source_table = 'deposit_requests' AND gl.source_id = dr.id
          AND gl.ledger_scope = 'wallet' AND gl.direction = 'cash_in'
      )
  )
  INSERT INTO public.deposit_bridge_gap_alerts(
    source, source_id, transaction_id, user_id, amount, approved_at, alert_reason, severity
  )
  SELECT 'deposit_request', c.id, c.transaction_id, c.user_id, c.amount, c.approved_at,
         'Approved deposit missing wallet ledger credit',
         CASE WHEN c.amount >= 100000 THEN 'critical' ELSE 'high' END
  FROM candidates c
  ON CONFLICT (source, source_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  -- Also alert on stale DLQ events
  INSERT INTO public.deposit_bridge_gap_alerts(source, source_id, transaction_id, user_id, amount, alert_reason, severity)
  SELECT source, source_id, transaction_id, user_id, amount, 'Bridge event in DEAD_LETTER', 'critical'
  FROM public.deposit_bridge_events
  WHERE status = 'DEAD_LETTER'
  ON CONFLICT (source, source_id) DO NOTHING;

  RETURN v_inserted;
END; $$;

GRANT EXECUTE ON FUNCTION public.get_deposit_bridge_health() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_deposit_bridge_metrics() TO authenticated;
GRANT EXECUTE ON FUNCTION public.replay_deposit_bridge_event(UUID) TO authenticated;
