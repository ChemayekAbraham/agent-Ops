ALTER TABLE public.hr_pay_run_events DROP CONSTRAINT hr_pay_run_events_event_type_check;
ALTER TABLE public.hr_pay_run_events ADD CONSTRAINT hr_pay_run_events_event_type_check
  CHECK ((event_type = ANY (ARRAY['created'::text,'calculated'::text,'submitted'::text,'returned'::text,'approved'::text,'paid'::text,'locked'::text,'reversed'::text,'cancelled'::text])));

ALTER TABLE public.hr_pay_runs DROP CONSTRAINT hr_pay_runs_status_check;
ALTER TABLE public.hr_pay_runs ADD CONSTRAINT hr_pay_runs_status_check
  CHECK ((status = ANY (ARRAY['draft'::text,'calculated'::text,'in_review'::text,'returned'::text,'approved'::text,'paid'::text,'locked'::text,'cancelled'::text])));

CREATE OR REPLACE FUNCTION public.hr_pay_run_event_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_missing int;
        v_status text;
begin
  if new.event_type in ('created','calculated','submitted') then
    if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
      raise exception 'Only the position holding prepare authority may record a % event.', new.event_type;
    end if;
    new.actor_position_id := public.hr_pay_position_for('prepare');

  elsif new.event_type in ('returned','approved') then
    if not (public.hr_pay_is_approver() or public.hr_pay_is_rule_admin()) then
      raise exception 'Only the position holding approve authority may record a % event.', new.event_type;
    end if;
    new.actor_position_id := public.hr_pay_position_for('approve');

  elsif new.event_type in ('paid','locked') then
    if not (public.hr_pay_is_releaser() or public.hr_pay_is_approver()
            or public.hr_pay_is_rule_admin()) then
      raise exception 'Only the position holding release authority may record a % event.', new.event_type;
    end if;
    new.actor_position_id := public.hr_pay_position_for('release');

    if new.event_type = 'paid' then
      select count(*) into v_missing
      from public.hr_pay_payslips ps
      where ps.run_id = new.run_id and ps.is_current and ps.net > 0
        and not exists (
          select 1 from public.hr_pay_disbursements d
          where d.payslip_id = ps.id and d.status = 'posted'
        );
      if v_missing > 0 then
        raise exception
          'Cannot mark this run paid: % payslip(s) have no posted disbursement. Resolve or retry them first.', v_missing;
      end if;
    end if;

  elsif new.event_type = 'cancelled' then
    if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
      raise exception 'Only the position holding prepare authority may record a cancelled event.';
    end if;
    new.actor_position_id := public.hr_pay_position_for('prepare');

    select r.status into v_status from public.hr_pay_runs r where r.id = new.run_id;
    if not found then
      raise exception 'Cannot cancel: no pay run exists with id %.', new.run_id;
    end if;

    if v_status not in ('draft','calculated','in_review','returned') then
      raise exception
        'A run in status % cannot be cancelled. An approved run has to be returned before it can be cancelled, and paid and locked runs are settled money correctable only by an adjustment run.', v_status;
    end if;

    if length(btrim(coalesce(new.note, ''))) < 10 then
      raise exception 'A cancellation requires a written basis of at least 10 characters.';
    end if;

  elsif new.event_type = 'reversed' then
    raise exception
      'Reversal is not implemented: no status transition exists for a reversed event, and recording one would leave a misleading event trail against an unchanged run.';
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hr_pay_apply_run_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.event_type = 'created' then
    update public.hr_pay_runs
       set status = 'draft', prepared_by = new.actor,
           prepared_position_id = new.actor_position_id, prepared_at = new.created_at
     where id = new.run_id;

  elsif new.event_type = 'calculated' then
    update public.hr_pay_runs r
       set status = 'calculated',
           total_gross = coalesce(t.g, 0),
           total_net = coalesce(t.n, 0),
           total_employer_cost = coalesce(t.e, 0)
      from (
        select sum(ps.gross) as g, sum(ps.net) as n, sum(ps.employer_cost) as e
        from public.hr_pay_payslips ps
        where ps.run_id = new.run_id and ps.is_current
      ) t
     where r.id = new.run_id;

  elsif new.event_type = 'submitted' then
    update public.hr_pay_runs set status = 'in_review' where id = new.run_id;

  elsif new.event_type = 'returned' then
    update public.hr_pay_runs set status = 'returned' where id = new.run_id;

  elsif new.event_type = 'approved' then
    update public.hr_pay_runs
       set status = 'approved', approved_by = new.actor,
           approved_position_id = new.actor_position_id, approved_at = new.created_at
     where id = new.run_id;

  elsif new.event_type = 'paid' then
    update public.hr_pay_runs set status = 'paid' where id = new.run_id;

  elsif new.event_type = 'locked' then
    update public.hr_pay_runs
       set status = 'locked', locked_at = new.created_at
     where id = new.run_id;

  elsif new.event_type = 'cancelled' then
    update public.hr_pay_runs set status = 'cancelled' where id = new.run_id;
  end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.hr_pay_run_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
declare v_verified timestamptz;
begin
  if tg_op = 'INSERT' then
    select rv.verified_at into v_verified
    from public.hr_pay_rule_versions rv where rv.id = new.rule_version_id;

    new.rule_status_at_run :=
      case when v_verified is null then 'provisional' else 'verified' end;
  end if;

  if tg_op = 'UPDATE' then
    if old.status = 'locked' then
      raise exception
        'This run is locked and immutable. Create an adjustment run against the same period.';
    end if;
    if old.status = 'cancelled' then
      raise exception
        'This run is cancelled and immutable. Create a new run against the same period.';
    end if;
    if new.rule_status_at_run is distinct from old.rule_status_at_run then
      raise exception
        'rule_status_at_run is a historical fact and cannot be changed. Recompute against a verified version instead.';
    end if;
  end if;

  return new;
end;
$function$;