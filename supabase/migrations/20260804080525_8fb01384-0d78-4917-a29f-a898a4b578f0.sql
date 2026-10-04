CREATE OR REPLACE FUNCTION public.sync_operations_department_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role app_role;
BEGIN
  IF TG_OP = 'DELETE' THEN
    BEGIN
      v_role := OLD.department::app_role;
    EXCEPTION WHEN others THEN
      RETURN OLD;
    END;
    IF NOT EXISTS (
      SELECT 1 FROM public.operations_departments
      WHERE user_id = OLD.user_id AND department = OLD.department
    ) THEN
      DELETE FROM public.user_roles
      WHERE user_id = OLD.user_id AND role = v_role;
    END IF;
    RETURN OLD;
  END IF;

  BEGIN
    v_role := NEW.department::app_role;
  EXCEPTION WHEN others THEN
    RETURN NEW;
  END;

  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.user_id, v_role)
  ON CONFLICT (user_id, role) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_operations_department_role ON public.operations_departments;
CREATE TRIGGER trg_sync_operations_department_role
AFTER INSERT OR UPDATE OR DELETE ON public.operations_departments
FOR EACH ROW EXECUTE FUNCTION public.sync_operations_department_role();

-- Backfill existing assignments
INSERT INTO public.user_roles (user_id, role)
SELECT od.user_id, od.department::app_role
FROM public.operations_departments od
ON CONFLICT (user_id, role) DO NOTHING;