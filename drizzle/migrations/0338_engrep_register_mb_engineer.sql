INSERT INTO public.engrep_engineers (code, staff_id, git_emails, active)
VALUES ('MB', 'e6c2378c-7c01-44c1-aaf5-a80254561518',
        array['168916660+benjmu@users.noreply.github.com'], true);

UPDATE public.engrep_rows
   SET engineer_id = (SELECT id FROM public.engrep_engineers WHERE code = 'MB'),
       engineer_code = 'MB',
       attribution = 'email'
 WHERE author_email = '168916660+benjmu@users.noreply.github.com'
   AND engineer_id IS NULL;

UPDATE public.engrep_file_touches
   SET engineer_id = (SELECT id FROM public.engrep_engineers WHERE code = 'MB')
 WHERE engineer_id IS NULL
   AND evidence_ref IN (
     SELECT evidence_ref FROM public.engrep_rows
      WHERE author_email = '168916660+benjmu@users.noreply.github.com'
   );