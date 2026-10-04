CREATE OR REPLACE FUNCTION public.hr_birthday_can_write()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.has_role(auth.uid(), 'hr'::app_role)
      OR EXISTS (
           SELECT 1 FROM public.hr_birthday_recipients r
            WHERE r.user_id = auth.uid()
              AND r.active
         );
$function$;

CREATE OR REPLACE FUNCTION public.hr_birthday_queue_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_today date := (now() AT TIME ZONE 'Africa/Kampala')::date;
  v_inserted int := 0;
BEGIN
  WITH days AS (
    SELECT d::date AS d,
           (to_char(d::date, 'MM-DD') = '02-28'
            AND NOT ((date_part('year', d::date)::int % 4 = 0
                      AND date_part('year', d::date)::int % 100 <> 0)
                     OR date_part('year', d::date)::int % 400 = 0)) AS leap_shift
      FROM (VALUES (v_today), (v_today - 1), (v_today - 2)) AS t(d)
  ), matched AS (
    SELECT s.id AS staff_id, dd.d
      FROM public.hr_staff s
      JOIN public.hr_staff_birthdays b ON b.staff_id = s.id
      JOIN days dd ON (
             to_char(b.birth_date, 'MM-DD') = to_char(dd.d, 'MM-DD')
             OR (dd.leap_shift AND to_char(b.birth_date, 'MM-DD') = '02-29')
           )
     WHERE s.active
  ), ins AS (
    INSERT INTO public.hr_birthday_notices (staff_id, birthday_on, recipient_user_id)
    SELECT m.staff_id, m.d, r.user_id
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
         'hr_birthday:' || s.id::text || ':' || dd.d::text,
         'Birthday today',
         coalesce(p.full_name, s.staff_ref, 'A staff member') || ' is celebrating a birthday today.',
         '/hr/people?tab=birthdays'
    FROM public.hr_staff s
    JOIN public.hr_staff_birthdays b ON b.staff_id = s.id
    JOIN (
      SELECT d::date AS d,
             (to_char(d::date, 'MM-DD') = '02-28'
              AND NOT ((date_part('year', d::date)::int % 4 = 0
                        AND date_part('year', d::date)::int % 100 <> 0)
                       OR date_part('year', d::date)::int % 400 = 0)) AS leap_shift
        FROM (VALUES (v_today), (v_today - 1), (v_today - 2)) AS t(d)
    ) dd ON (
      to_char(b.birth_date, 'MM-DD') = to_char(dd.d, 'MM-DD')
      OR (dd.leap_shift AND to_char(b.birth_date, 'MM-DD') = '02-29')
    )
    LEFT JOIN public.profiles p ON p.id = s.user_id
    CROSS JOIN public.hr_birthday_recipients r
   WHERE s.active
     AND r.active
     AND NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.user_id = r.user_id
          AND n.event_key = 'hr_birthday:' || s.id::text || ':' || dd.d::text
     );

  RETURN v_inserted;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.hr_birthday_recipients_no_truncate() FROM PUBLIC, anon, authenticated;