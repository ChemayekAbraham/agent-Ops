-- HR birthday register + forceful birthday notice. Database only.

CREATE TABLE IF NOT EXISTS public.hr_staff_birthdays (
  staff_id uuid PRIMARY KEY REFERENCES public.hr_staff(id) ON DELETE CASCADE,
  birth_date date NOT NULL,
  recorded_by uuid,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hr_staff_birthdays_plausible_ck
    CHECK (birth_date < current_date AND birth_date > current_date - interval '90 years')
);

GRANT ALL ON public.hr_staff_birthdays TO service_role;
ALTER TABLE public.hr_staff_birthdays ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.hr_birthday_recipients (
  user_id uuid PRIMARY KEY,
  staff_ref text,
  label text,
  active boolean NOT NULL DEFAULT true,
  added_by uuid,
  added_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.hr_birthday_recipients TO service_role;
ALTER TABLE public.hr_birthday_recipients ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.hr_birthday_recipients_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION 'hr_birthday_recipients cannot be truncated';
END;
$fn$;

DROP TRIGGER IF EXISTS hr_birthday_recipients_no_truncate_trg ON public.hr_birthday_recipients;
CREATE TRIGGER hr_birthday_recipients_no_truncate_trg
BEFORE TRUNCATE ON public.hr_birthday_recipients
FOR EACH STATEMENT EXECUTE FUNCTION public.hr_birthday_recipients_no_truncate();

INSERT INTO public.hr_birthday_recipients (user_id, staff_ref, label)
SELECT s.user_id,
       s.staff_ref,
       CASE s.staff_ref WHEN 'EMP-00001' THEN 'CEO' WHEN 'EMP-00002' THEN 'HR' ELSE s.staff_ref END
  FROM public.hr_staff s
 WHERE s.staff_ref IN ('EMP-00001', 'EMP-00002')
   AND s.active
   AND s.user_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.hr_birthday_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES public.hr_staff(id) ON DELETE CASCADE,
  birthday_on date NOT NULL,
  recipient_user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (staff_id, birthday_on, recipient_user_id)
);

GRANT SELECT, UPDATE ON public.hr_birthday_notices TO authenticated;
GRANT ALL ON public.hr_birthday_notices TO service_role;
ALTER TABLE public.hr_birthday_notices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS hr_birthday_notices_own_select ON public.hr_birthday_notices;
CREATE POLICY hr_birthday_notices_own_select
ON public.hr_birthday_notices FOR SELECT TO authenticated
USING (recipient_user_id = auth.uid());

DROP POLICY IF EXISTS hr_birthday_notices_own_update ON public.hr_birthday_notices;
CREATE POLICY hr_birthday_notices_own_update
ON public.hr_birthday_notices FOR UPDATE TO authenticated
USING (recipient_user_id = auth.uid())
WITH CHECK (recipient_user_id = auth.uid());

CREATE INDEX IF NOT EXISTS hr_birthday_notices_pending_idx
  ON public.hr_birthday_notices (recipient_user_id, acknowledged_at)
  WHERE acknowledged_at IS NULL;

CREATE OR REPLACE FUNCTION public.hr_birthday_can_write()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT public.has_role(auth.uid(), 'hr'::app_role)
      OR public.has_role(auth.uid(), 'ceo'::app_role)
      OR public.has_role(auth.uid(), 'super_admin'::app_role);
$fn$;

CREATE OR REPLACE FUNCTION public.hr_set_staff_birth_date(p_staff_id uuid, p_birth_date date)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_age int;
BEGIN
  IF NOT public.hr_birthday_can_write() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.hr_staff WHERE id = p_staff_id) THEN
    RAISE EXCEPTION 'staff member not found';
  END IF;

  IF p_birth_date IS NULL OR p_birth_date >= current_date THEN
    RAISE EXCEPTION 'birth date must be in the past';
  END IF;

  v_age := date_part('year', age(current_date, p_birth_date))::int;
  IF v_age < 16 OR v_age > 80 THEN
    RAISE EXCEPTION 'birth date is outside the accepted range';
  END IF;

  INSERT INTO public.hr_staff_birthdays (staff_id, birth_date, recorded_by, recorded_at, updated_by, updated_at)
  VALUES (p_staff_id, p_birth_date, auth.uid(), now(), auth.uid(), now())
  ON CONFLICT (staff_id) DO UPDATE
    SET birth_date = EXCLUDED.birth_date,
        updated_by = auth.uid(),
        updated_at = now();
END;
$fn$;

CREATE OR REPLACE FUNCTION public.hr_clear_staff_birth_date(p_staff_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT public.hr_birthday_can_write() THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  DELETE FROM public.hr_staff_birthdays WHERE staff_id = p_staff_id;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.hr_list_staff_birthdays()
RETURNS TABLE (
  staff_id uuid,
  staff_ref text,
  full_name text,
  birth_date date,
  birth_day_month text,
  turning_age int,
  next_birthday date,
  days_until int
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NOT (
    public.hr_birthday_can_write()
    OR EXISTS (
      SELECT 1 FROM public.hr_birthday_recipients r
       WHERE r.user_id = auth.uid() AND r.active
    )
  ) THEN
    RAISE EXCEPTION 'not permitted';
  END IF;

  RETURN QUERY
  WITH base AS (
    SELECT s.id AS sid,
           s.staff_ref AS sref,
           p.full_name AS fname,
           b.birth_date AS bdate,
           CASE
             WHEN b.birth_date IS NULL THEN NULL
             WHEN to_char(b.birth_date, 'MM-DD') >= to_char(current_date, 'MM-DD')
               THEN make_date(date_part('year', current_date)::int, date_part('month', b.birth_date)::int, date_part('day', b.birth_date)::int)
             ELSE make_date(date_part('year', current_date)::int + 1, date_part('month', b.birth_date)::int, date_part('day', b.birth_date)::int)
           END AS next_bday
      FROM public.hr_staff s
      LEFT JOIN public.hr_staff_birthdays b ON b.staff_id = s.id
      LEFT JOIN public.profiles p ON p.id = s.user_id
     WHERE s.active
  )
  SELECT base.sid,
         base.sref,
         base.fname,
         base.bdate,
         CASE WHEN base.bdate IS NULL THEN NULL ELSE to_char(base.bdate, 'DD Mon') END,
         CASE WHEN base.bdate IS NULL THEN NULL
              ELSE (date_part('year', base.next_bday) - date_part('year', base.bdate))::int END,
         base.next_bday,
         CASE WHEN base.next_bday IS NULL THEN NULL ELSE (base.next_bday - current_date)::int END
    FROM base
   ORDER BY CASE WHEN base.next_bday IS NULL THEN 1 ELSE 0 END,
            CASE WHEN base.next_bday IS NULL THEN NULL ELSE (base.next_bday - current_date)::int END,
            base.fname;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.hr_birthday_pending()
RETURNS TABLE (
  notice_id uuid,
  staff_id uuid,
  staff_ref text,
  full_name text,
  birthday_on date,
  turning_age int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT n.id,
         n.staff_id,
         s.staff_ref,
         p.full_name,
         n.birthday_on,
         CASE WHEN b.birth_date IS NULL THEN NULL
              ELSE (date_part('year', n.birthday_on) - date_part('year', b.birth_date))::int END
    FROM public.hr_birthday_notices n
    JOIN public.hr_staff s ON s.id = n.staff_id
    LEFT JOIN public.hr_staff_birthdays b ON b.staff_id = n.staff_id
    LEFT JOIN public.profiles p ON p.id = s.user_id
   WHERE n.recipient_user_id = auth.uid()
     AND n.acknowledged_at IS NULL
     AND n.birthday_on >= current_date - 2
   ORDER BY n.birthday_on DESC;
$fn$;

CREATE OR REPLACE FUNCTION public.hr_birthday_acknowledge(p_notice_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.hr_birthday_notices
     SET acknowledged_at = now()
   WHERE id = p_notice_id
     AND recipient_user_id = auth.uid()
     AND acknowledged_at IS NULL;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'notice not found or already acknowledged';
  END IF;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.hr_birthday_queue_daily()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_year int := date_part('year', (now() AT TIME ZONE 'Africa/Kampala')::date)::int;
  v_leap_shift boolean;
  v_inserted int := 0;
BEGIN
  v_leap_shift := to_char(v_today, 'MM-DD') = '02-28'
                  AND NOT ((v_year % 4 = 0 AND v_year % 100 <> 0) OR v_year % 400 = 0);

  WITH matched AS (
    SELECT s.id AS staff_id
      FROM public.hr_staff s
      JOIN public.hr_staff_birthdays b ON b.staff_id = s.id
     WHERE s.active
       AND (
         to_char(b.birth_date, 'MM-DD') = to_char(v_today, 'MM-DD')
         OR (v_leap_shift AND to_char(b.birth_date, 'MM-DD') = '02-29')
       )
  ), ins AS (
    INSERT INTO public.hr_birthday_notices (staff_id, birthday_on, recipient_user_id)
    SELECT m.staff_id, v_today, r.user_id
      FROM matched m
      CROSS JOIN public.hr_birthday_recipients r
     WHERE r.active
    ON CONFLICT (staff_id, birthday_on, recipient_user_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_inserted FROM ins;

  INSERT INTO public.notifications (user_id, type, event_key, title, message, link_path)
  SELECT r.user_id,
         'hr_birthday',
         'hr_birthday:' || s.id::text || ':' || v_today::text,
         'Birthday today',
         coalesce(p.full_name, s.staff_ref, 'A staff member') || ' is celebrating a birthday today.',
         '/hr/people'
    FROM public.hr_staff s
    JOIN public.hr_staff_birthdays b ON b.staff_id = s.id
    LEFT JOIN public.profiles p ON p.id = s.user_id
    CROSS JOIN public.hr_birthday_recipients r
   WHERE s.active
     AND r.active
     AND (
       to_char(b.birth_date, 'MM-DD') = to_char(v_today, 'MM-DD')
       OR (v_leap_shift AND to_char(b.birth_date, 'MM-DD') = '02-29')
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.user_id = r.user_id
          AND n.event_key = 'hr_birthday:' || s.id::text || ':' || v_today::text
     );

  RETURN v_inserted;
END;
$fn$;

REVOKE ALL ON FUNCTION public.hr_birthday_can_write() FROM anon, public;
REVOKE ALL ON FUNCTION public.hr_set_staff_birth_date(uuid, date) FROM anon, public;
REVOKE ALL ON FUNCTION public.hr_clear_staff_birth_date(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.hr_list_staff_birthdays() FROM anon, public;
REVOKE ALL ON FUNCTION public.hr_birthday_pending() FROM anon, public;
REVOKE ALL ON FUNCTION public.hr_birthday_acknowledge(uuid) FROM anon, public;
REVOKE ALL ON FUNCTION public.hr_birthday_queue_daily() FROM anon, public, authenticated;

GRANT EXECUTE ON FUNCTION public.hr_set_staff_birth_date(uuid, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_clear_staff_birth_date(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_list_staff_birthdays() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_birthday_pending() TO authenticated;
GRANT EXECUTE ON FUNCTION public.hr_birthday_acknowledge(uuid) TO authenticated;

DO $cron$
BEGIN
  PERFORM cron.unschedule('hr-birthday-notices-0600-eat');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$cron$;

SELECT cron.schedule('hr-birthday-notices-0600-eat', '0 3 * * *', $job$ SELECT public.hr_birthday_queue_daily(); $job$);