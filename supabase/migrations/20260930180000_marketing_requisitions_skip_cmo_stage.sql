-- Marketing requisitions no longer stop at the CMO (handover doc 173).
--
-- Josh, 2026-09-30: Marketing requisitions go COO -> CEO -> CFO like everyone
-- else's. The department-head (CMO) stage is dropped for the whole department.
-- Requires 20260924130000_six_eyes_staff_requisition_approval.sql.
--
-- staff_requisition_route reads this row; 'coo' means no department-head stage,
-- so new Marketing requisitions enter at the COO.
UPDATE public.staff_requisition_department_routes r
   SET approver_role = 'coo', updated_at = now()
  FROM public.hr_departments d
 WHERE d.id = r.department_id
   AND d.key = 'marketing'
   AND r.approver_role IS DISTINCT FROM 'coo';
