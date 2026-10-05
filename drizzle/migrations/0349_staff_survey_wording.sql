do $$
begin
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='user_roles'
                   and column_name='enabled') then
    raise exception 'Wrong database: public.user_roles.enabled not found. This migration belongs to RentFlow.';
  end if;
  if (select count(*) from public.staff_surveys
       where code in ('statutory_consent_2026','salary_reinvestment_2026')) <> 2 then
    raise exception 'The two staff surveys are not both present. Apply the staff surveys migration first.';
  end if;
  -- Never change the wording under an answer someone has already given.
  if exists (select 1 from public.staff_survey_responses r
             join public.staff_surveys s on s.id = r.survey_id
             where s.code in ('statutory_consent_2026','salary_reinvestment_2026')) then
    raise exception 'Someone has already answered one of these surveys. Their wording cannot be changed now.';
  end if;
end $$;

update public.staff_surveys
   set title = 'Your salary as gross pay — PAYE and NSSF',
       body = $body$Welile is asking each member of staff to choose how their salary is treated for tax.

If you ACCEPT
Your current monthly salary becomes your gross salary. PAYE tax and your 5% NSSF contribution will be deducted from it every month, so your take-home pay will be lower than it is today. Welile pays the deductions on your behalf to the Uganda Revenue Authority (URA) and to NSSF, and they appear on your payslip.

If you DECLINE
Your current salary stays your take-home pay. HR will contact you to confirm how your PAYE and NSSF will be handled.

How PAYE is worked out each month, on gross pay:
- Up to UGX 235,000 — no tax
- UGX 235,001 to 335,000 — 10% of the amount above 235,000
- UGX 335,001 to 410,000 — UGX 10,000 plus 20% of the amount above 335,000
- UGX 410,001 to 10,000,000 — UGX 25,000 plus 30% of the amount above 410,000
- Above UGX 10,000,000 — UGX 2,902,000 plus 40% of the amount above 10,000,000

NSSF: 5% of your gross pay is deducted as your contribution. Welile adds a further 10% from its own funds — that part is never taken from your salary. The full 15% is saved in your name at NSSF.

Example — a current salary of UGX 1,000,000, if you accept:
Gross 1,000,000 · PAYE 202,000 · NSSF 50,000 · take-home 748,000, before any other deductions. Welile also pays 100,000 into your NSSF account.

If you accept, enter your TIN so your tax can be filed in your name.$body$
 where code = 'statutory_consent_2026';

update public.staff_surveys
   set title = 'Reinvest part of your salary in Welile',
       body = $body$This is optional.

You can choose to reinvest part of your monthly salary into Welile. The amount you reinvest becomes the principal of your investment and earns 15% per month, on the terms already shared with staff.

Choose the percentage of your salary you would like to reinvest each month — from 5% up to 100% — or press Decline if you do not wish to take part.

Your choice will be confirmed with HR before your first reinvestment.$body$
 where code = 'salary_reinvestment_2026';