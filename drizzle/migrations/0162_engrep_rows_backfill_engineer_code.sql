update public.engrep_rows r
   set engineer_code = e.code
  from public.engrep_engineers e
 where r.engineer_id = e.id
   and r.engineer_code is null;