CREATE OR REPLACE FUNCTION public.enforce_partner_return_rate_policy()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pol    public.partner_return_policy%ROWTYPE;
  v_on     boolean;
  v_rate   numeric;
  v_basis  text;
  v_ex     boolean;
  v_parent record;
  v_ctx    text := COALESCE(current_setting('app.partner_rate_context', true), '');
  v_lt     text := current_setting('lock_timeout');
BEGIN
  SELECT * INTO v_pol FROM public.partner_return_policy p WHERE p.id;
  v_on := COALESCE(v_pol.enabled, false);

  IF TG_OP = 'UPDATE' THEN
    -- An invite portfolio receives its investor: decide the rate for that person now. Invites opened
    -- while the switch was on (new-partner rate), and invites opened while it was off AFTER the
    -- cut-off (an offer made after the cut-off is not honoured, D14), are decided for the claimant.
    -- Switch on: the claimant's rate; a rate typed while off waits for the CFO like any typed rate.
    -- Switch off: the legacy rate (an on-invite never keeps the new-partner rate, which would put an
    -- existing partner below their own rate with nothing flagged) or the rate typed while off; the
    -- existing flag is stamped either way. Invites opened before the cut-off keep their rate.
    IF OLD.investor_id IS NULL AND NEW.investor_id IS NOT NULL
       AND NEW.roi_percentage IS NOT DISTINCT FROM OLD.roi_percentage
       AND OLD.roi_percentage IS NOT DISTINCT FROM OLD.entitled_rate
       AND (OLD.rate_basis = 'new_no_investor'
            OR (OLD.rate_basis IN ('switch_off', 'typed_switch_off')
                AND v_pol.cutoff_at IS NOT NULL
                AND OLD.rate_decided_at >= v_pol.cutoff_at)) THEN
      v_ex := NULL;
      IF v_on OR v_pol.cutoff_at IS NOT NULL THEN
        -- Bounded wait (G1): at most 3 s, never longer than the caller's own lock_timeout.
        IF v_lt::interval = interval '0' OR v_lt::interval > interval '3 seconds' THEN
          PERFORM set_config('lock_timeout', '3s', true);
        END IF;
        BEGIN
          PERFORM public.partner_rate_lock(ARRAY[NEW.investor_id]);
        EXCEPTION WHEN lock_not_available THEN
          RAISE EXCEPTION 'The portfolio was not saved: this partner''s Returns rate is being updated by another change right now. Nothing was changed; try again in a minute.'
            USING ERRCODE = '55P03',
                  HINT = 'A bulk note link or contact backfill holds the rate lock; it is released when that change finishes.';
        END;
        PERFORM set_config('lock_timeout', v_lt, true);
        SELECT r.rate, r.basis, r.existing INTO v_rate, v_basis, v_ex
          FROM public.partner_rates_for(ARRAY[NEW.investor_id], true) r;
      END IF;
      IF v_on THEN
        -- A rate typed while off on an invite opened after the cut-off: the claimant's rate applies and
        -- the typed rate waits for the CFO (no pending request exists: the off path never queues one).
        IF OLD.rate_basis = 'typed_switch_off' AND OLD.roi_percentage IS DISTINCT FROM v_rate THEN
          INSERT INTO public.portfolio_rate_approvals
            (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
          VALUES (NEW.id, OLD.roi_percentage, v_rate, v_rate, 'new_portfolio', auth.uid());
        END IF;
      ELSIF OLD.rate_basis = 'new_no_investor' THEN
        v_rate  := trim_scale(COALESCE(v_pol.legacy_rate, 15));
        v_basis := 'switch_off';
      ELSE
        v_rate  := OLD.roi_percentage;                -- opened while off, claimed while off: rate kept
        v_basis := OLD.rate_basis;
      END IF;
      NEW.roi_percentage  := v_rate;
      NEW.entitled_rate   := v_rate;
      NEW.rate_basis      := v_basis;
      NEW.rate_decided_at := clock_timestamp();
      NEW.rate_existing_at_decision := v_ex;
      -- A rate typed on the invite waits for the CFO against the new-partner rate. Measure it against
      -- the claimant's rate now, so the CFO sees a lowering of an existing partner as a lowering.
      UPDATE public.portfolio_rate_approvals
         SET standard_rate = v_rate, rate_in_force = v_rate
       WHERE portfolio_id = NEW.id AND status = 'pending' AND source = 'new_portfolio';
      RETURN NEW;
    END IF;

    NEW.entitled_rate   := OLD.entitled_rate;
    NEW.rate_basis      := OLD.rate_basis;
    NEW.rate_decided_at := OLD.rate_decided_at;
    NEW.rate_existing_at_decision := OLD.rate_existing_at_decision;

    IF NEW.roi_percentage IS NOT DISTINCT FROM OLD.roi_percentage THEN
      RETURN NEW;
    END IF;

    IF NOT v_on THEN
      IF v_pol.cutoff_at IS NOT NULL THEN
        INSERT INTO public.portfolio_rate_approvals
          (portfolio_id, requested_rate, rate_in_force, standard_rate, source, status, requested_by,
           decided_by, decided_at, decision_note, applied_at, applied_xact)
        VALUES (NEW.id, NEW.roi_percentage, OLD.roi_percentage, OLD.roi_percentage, 'rate_change', 'approved',
                auth.uid(), auth.uid(), now(), 'Applied directly while Partner Returns was switched off',
                now(), txid_current());
      END IF;
      RETURN NEW;                                   -- switch off: today's behaviour
    END IF;

    -- The next-cycle job applying an approved rate in this same transaction.
    IF EXISTS (SELECT 1 FROM public.portfolio_rate_approvals a
                WHERE a.portfolio_id = NEW.id
                  AND a.status = 'approved'
                  AND a.applied_xact = txid_current()
                  AND a.requested_rate = NEW.roi_percentage) THEN
      RETURN NEW;
    END IF;

    -- Under a Returns hold: leave the change for trg_zz_portfolio_return_hold to refuse.
    IF public.is_portfolio_on_hold(NEW.id) THEN
      RETURN NEW;
    END IF;

    -- Any other change: a newer request replaces an older open or scheduled one. The open requests are
    -- locked in id order first, as the CFO decision locks them, so one rate change and a CFO decision
    -- cannot deadlock (one transaction changing several portfolios locks them portfolio by portfolio
    -- and can: change Returns rates one portfolio per transaction). A request that another
    -- transaction opened for this portfolio and committed while this one waited (a late-linked note's
    -- catch-up, or a second staff change) is replaced the same way on a second try, as if it had come
    -- first, instead of failing the change. No sub-transaction: a bulk edit stays cheap.
    FOR v_try IN 1..2 LOOP
      PERFORM 1 FROM public.portfolio_rate_approvals a
       WHERE a.portfolio_id = NEW.id
         AND (a.status = 'pending' OR (a.status = 'approved' AND a.applied_at IS NULL))
       ORDER BY a.id FOR UPDATE;
      UPDATE public.portfolio_rate_approvals
         SET status = 'superseded', decided_at = COALESCE(decided_at, now()),
             decision_note = concat_ws(' · ', decision_note, 'Superseded: replaced by a newer rate request')
       WHERE portfolio_id = NEW.id
         AND (status = 'pending' OR (status = 'approved' AND applied_at IS NULL));
      INSERT INTO public.portfolio_rate_approvals
        (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
      VALUES (NEW.id, NEW.roi_percentage, OLD.roi_percentage, OLD.roi_percentage, 'rate_change', auth.uid())
      ON CONFLICT (portfolio_id) WHERE status = 'pending' DO NOTHING;
      EXIT WHEN FOUND;
      IF v_try = 2 THEN
        RAISE EXCEPTION 'Another Returns rate request for this portfolio was opened at the same moment; try again'
          USING ERRCODE = '23505', CONSTRAINT = 'portfolio_rate_approvals_one_pending';
      END IF;
    END LOOP;
    NEW.roi_percentage := OLD.roi_percentage;      -- the old rate stays until the CFO approves
    RETURN NEW;
  END IF;


  -- Only a locked, approved agreement request being consumed in this transaction can set a new portfolio rate.
  IF EXISTS(SELECT 1 FROM public.partner_agreement_rate_requests r WHERE r.id::text=current_setting('app.agreement_rate_request',true) AND r.partner_id=NEW.investor_id AND r.status='approved' AND r.applied_at IS NULL AND r.applied_xact=txid_current() AND r.requested_rate=NEW.roi_percentage) THEN
    NEW.entitled_rate:=NEW.roi_percentage;
    NEW.rate_decided_at:=clock_timestamp();
    NEW.rate_existing_at_decision:=NULL;
    NEW.rate_basis:=CASE WHEN v_on THEN 'cfo_approved' ELSE 'typed_switch_off' END;
    RETURN NEW;
  END IF;
  -- INSERT
  NEW.rate_decided_at := clock_timestamp();
  NEW.rate_existing_at_decision := NULL;

  IF NOT v_on THEN
    -- Off after a cut-off: record whether the person counts as existing (rate and basis stay the
    -- switch-off ones), so a portfolio opened during an off period keeps an existing partner existing
    -- when the switch comes back on.
    -- Rate lock with a bounded wait (G1), as on the switch-on path below. Never before a cut-off.
    IF NEW.investor_id IS NOT NULL AND v_pol.cutoff_at IS NOT NULL THEN
      IF v_lt::interval = interval '0' OR v_lt::interval > interval '3 seconds' THEN
        PERFORM set_config('lock_timeout', '3s', true);
      END IF;
      BEGIN
        PERFORM public.partner_rate_lock(ARRAY[NEW.investor_id]);
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'The portfolio was not saved: this partner''s Returns rate is being updated by another change right now. Nothing was changed; try again in a minute.'
          USING ERRCODE = '55P03',
                HINT = 'A bulk note link or contact backfill holds the rate lock; it is released when that change finishes.';
      END;
      PERFORM set_config('lock_timeout', v_lt, true);
      SELECT r.existing INTO v_ex FROM public.partner_rates_for(ARRAY[NEW.investor_id], true) r;
      NEW.rate_existing_at_decision := COALESCE(v_ex, false);
    END IF;
    IF NEW.roi_percentage IS NULL THEN
      NEW.roi_percentage := trim_scale(COALESCE(v_pol.legacy_rate, 15));
      NEW.rate_basis := 'switch_off';
    ELSE
      NEW.rate_basis := 'typed_switch_off';
    END IF;
    NEW.entitled_rate := NEW.roi_percentage;
    RETURN NEW;
  END IF;

  -- Split / lock child (only the owner's split and lock tools get here, see 5a): keeps the rate
  -- of a LIVE parent of the same investor.
  IF NEW.locked_from_portfolio_id IS NOT NULL AND NEW.investor_id IS NOT NULL THEN
    SELECT ip.investor_id, ip.roi_percentage, ip.status INTO v_parent
      FROM public.investor_portfolios ip WHERE ip.id = NEW.locked_from_portfolio_id;
    IF FOUND AND v_parent.investor_id = NEW.investor_id
       AND v_parent.status = ANY (public.partner_live_portfolio_statuses())
       AND (NEW.roi_percentage IS NULL OR NEW.roi_percentage = v_parent.roi_percentage) THEN
      NEW.roi_percentage := v_parent.roi_percentage;
      NEW.entitled_rate  := v_parent.roi_percentage;
      NEW.rate_basis     := 'carried';
      RETURN NEW;
    END IF;
  END IF;

  -- The person's rate, and whether they count as an existing partner right now, kept on the portfolio
  -- whichever basis wins (employee on a tie, a note's rate, salary reinvestment): partner_rates_for
  -- counts a live portfolio opened by an existing partner as continuing, so they keep their own rate.
  -- The rate lock waits at most 3 s (never longer than the caller's own lock_timeout), then fails
  -- with a clear retryable error instead of hanging behind a bulk note link (G1).
  IF NEW.investor_id IS NOT NULL THEN
    IF v_lt::interval = interval '0' OR v_lt::interval > interval '3 seconds' THEN
      PERFORM set_config('lock_timeout', '3s', true);
    END IF;
    BEGIN
      PERFORM public.partner_rate_lock(ARRAY[NEW.investor_id]);
    EXCEPTION WHEN lock_not_available THEN
      RAISE EXCEPTION 'The portfolio was not saved: this partner''s Returns rate is being updated by another change right now. Nothing was changed; try again in a minute.'
        USING ERRCODE = '55P03',
              HINT = 'A bulk note link or contact backfill holds the rate lock; it is released when that change finishes.';
    END;
    PERFORM set_config('lock_timeout', v_lt, true);
    SELECT r.rate, r.basis, r.existing INTO v_rate, v_basis, v_ex
      FROM public.partner_rates_for(ARRAY[NEW.investor_id], true) r;
    NEW.rate_existing_at_decision := v_ex;
  END IF;

  -- Salary reinvestment: the payroll function sets this context; browsers cannot set app.* settings.
  -- Earns the employee rate even on a leaver's final payslip.
  IF v_ctx = 'salary_reinvestment'
     AND (NEW.roi_percentage IS NULL OR NEW.roi_percentage = v_pol.employee_rate) THEN
    NEW.roi_percentage := trim_scale(v_pol.employee_rate);
    NEW.entitled_rate  := v_pol.employee_rate;
    NEW.rate_basis     := 'salary_reinvestment';
    RETURN NEW;
  END IF;

  IF NEW.investor_id IS NULL THEN
    v_rate := trim_scale(v_pol.new_contract_rate);  -- never borrow the agent's own rate
    v_basis := 'new_no_investor';
  END IF;

  NEW.entitled_rate := v_rate;
  NEW.rate_basis    := v_basis;
  IF NEW.roi_percentage IS NULL OR NEW.roi_percentage = v_rate THEN
    NEW.roi_percentage := v_rate;
    RETURN NEW;
  END IF;

  INSERT INTO public.portfolio_rate_approvals
    (portfolio_id, requested_rate, rate_in_force, standard_rate, source, requested_by)
  VALUES (NEW.id, NEW.roi_percentage, v_rate, v_rate, 'new_portfolio', auth.uid());
  NEW.roi_percentage := v_rate;
  RETURN NEW;
END $function$;
