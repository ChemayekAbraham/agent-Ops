-- Verbatim production copy (13 Nov 2026, read-only export) of hr_pay_advance_guard(), md5(prosrc) 9df13bf7ddf908dba1768c13c4507a98.
CREATE OR REPLACE FUNCTION public.hr_pay_advance_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if tg_op = 'INSERT' then
    new.status                  := 'requested';
    new.hr_approved_by          := null;
    new.hr_approved_position_id := null;
    new.hr_approved_at          := null;
    new.approved_by             := null;
    new.approved_position_id    := null;
    new.approved_at             := null;
    new.disbursed_by            := null;
    new.disbursed_position_id   := null;
    new.disbursed_at            := null;
    new.requested_at            := coalesce(new.requested_at, now());
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.principal is distinct from old.principal
    or new.staff_id  is distinct from old.staff_id then
      raise exception 'Advance principal and staff cannot be changed. Cancel and raise a new one.';
    end if;

    if new.status is distinct from old.status then
      if old.status = 'requested' and new.status = 'hr_approved' then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may give HR approval to an advance.';
        end if;
        new.hr_approved_by := auth.uid();
        new.hr_approved_position_id := public.hr_pay_position_for('prepare');
        new.hr_approved_at := now();

      elsif old.status = 'hr_approved' and new.status = 'ceo_approved' then
        if not (public.hr_pay_is_approver() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding approve authority may approve an advance.';
        end if;
        new.approved_by := auth.uid();
        new.approved_position_id := public.hr_pay_position_for('approve');
        new.approved_at := now();

      elsif old.status = 'ceo_approved' and new.status = 'approved' then
        if not (public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding release authority may disburse an advance.';
        end if;
        new.disbursed_by := auth.uid();
        new.disbursed_position_id := public.hr_pay_position_for('release');
        new.disbursed_at := now();

      elsif new.status = 'rejected'
        and old.status in ('requested','hr_approved','ceo_approved') then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_approver()
                or public.hr_pay_is_releaser() or public.hr_pay_is_rule_admin()) then
          raise exception 'You do not hold authority to reject an advance.';
        end if;

      elsif new.status = 'cancelled'
        and old.status in ('requested','hr_approved','ceo_approved') then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may cancel an advance.';
        end if;

      elsif old.status = 'approved' and new.status = 'settled' then
        if not (public.hr_pay_is_preparer() or public.hr_pay_is_rule_admin()) then
          raise exception 'Only the position holding prepare authority may settle an advance.';
        end if;

      else
        raise exception 'Illegal advance status transition: % to %.', old.status, new.status;
      end if;
    end if;
  end if;

  return new;
end;
$function$;
