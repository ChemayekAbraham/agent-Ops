UPDATE public.hr_assignments a
SET department_id = (SELECT d.id FROM public.hr_departments d WHERE d.key = 'engineering')
WHERE a.staff_id = (SELECT s.id FROM public.hr_staff s WHERE s.staff_ref = 'EMP-00015')
  AND a.is_primary = true
  AND a.ended_on IS NULL;