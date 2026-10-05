-- SRQ-FLOW-06: executive stages (coo/ceo/cfo) may only be signed by the
-- current office holder from staff_requisition_offices. All existing checks
-- are kept exactly as they were, in the same order; one check is added after
-- the has_role check.
CREATE OR REPLACE FUNCTION public.staff_requisition_assert_signer(p_signer uuid, p_role text, p_requester uuid, p_prior uuid[])
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF p_signer IS NULL THEN
    RAISE EXCEPTION 'Six-eyes approval: the % sign-off is missing.', upper(p_role);
  END IF;
  IF p_signer = p_requester THEN
    RAISE EXCEPTION 'Six-eyes approval: the requester cannot sign their own requisition.';
  END IF;
  IF p_signer = ANY (array_remove(p_prior, NULL)) THEN
    RAISE EXCEPTION 'Six-eyes approval: the % sign-off must come from a different person than the earlier approvers.', upper(p_role);
  END IF;
  IF NOT public.has_role(p_signer, p_role::app_role) THEN
    RAISE EXCEPTION 'Six-eyes approval: the % sign-off came from someone who does not hold the % role.', upper(p_role), upper(p_role);
  END IF;
  IF p_role IN ('coo', 'ceo', 'cfo') THEN
    IF p_signer <> (SELECT o.holder_id
                    FROM public.staff_requisition_offices o
                    WHERE o.office_key = p_role) THEN
      RAISE EXCEPTION 'Six-eyes approval: the % sign-off must come from the current % office holder.', upper(p_role), upper(p_role);
    END IF;
  END IF;
END;
$function$
