import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface HRPositionRow {
  id: string;
  title: string;
  key: string;
  active: boolean;
  department_id: string | null;
}

export interface HRPositionDepartment {
  id: string;
  name: string;
  active: boolean;
}

export interface HRPositionAccessLabel {
  dashboard_key: string;
  role: string;
}

export const slugifyPositionKey = (title: string) =>
  title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

// A database function grants a capability by matching lower(title) on this exact
// string, so the title is protected from both directions: no new/renamed title may
// become it, and the row that already carries it may not be renamed.
export const PROTECTED_TITLE = 'lead partner growth';
export const PROTECTED_TITLE_KEY = 'lead_partner_growth';
export const PROTECTED_TITLE_MESSAGE =
  'This title is matched by name in a database function. Changing it here would change who has access.';

export const isProtectedTitle = (title: string) => title.trim().toLowerCase() === PROTECTED_TITLE;

export const MIN_REASON_LENGTH = 10;

const requireReason = (reason: string) => {
  const clean = (reason || '').trim();
  if (clean.length < MIN_REASON_LENGTH) {
    throw new Error(`A reason of at least ${MIN_REASON_LENGTH} characters is required`);
  }
  return clean;
};

const POSITIONS_KEY = ['hr-roles', 'positions'];
const DEPARTMENTS_KEY = ['hr-roles', 'hr-departments'];
const HELD_BY_KEY = ['hr-roles', 'held-by'];
const ACCESS_KEY = ['hr-roles', 'access'];

export function useHRPositions() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // An audit row with a null actor records nothing: refuse the change instead.
  const requireActor = () => {
    const actorId = user?.id;
    if (!actorId) throw new Error('You must be signed in to change roles');
    return actorId;
  };

  const refetchAll = async () => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: POSITIONS_KEY }),
      queryClient.refetchQueries({ queryKey: DEPARTMENTS_KEY }),
      queryClient.refetchQueries({ queryKey: HELD_BY_KEY }),
      queryClient.refetchQueries({ queryKey: ACCESS_KEY }),
    ]);
  };

  // Audit logging must never block or undo the change it describes.
  const logAudit = async (payload: any) => {
    try {
      await supabase.from('audit_logs').insert(payload);
    } catch (auditError) {
      console.error('[useHRPositions] audit log insert failed', auditError);
    }
  };

  const positionsQuery = useQuery({
    queryKey: POSITIONS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('hr_positions')
        .select('id, title, key, active, department_id')
        .order('title');
      if (error) throw error;
      return (data || []) as HRPositionRow[];
    },
  });

  const departmentsQuery = useQuery({
    queryKey: DEPARTMENTS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('hr_departments')
        .select('id, name, active')
        .order('name');
      if (error) throw error;
      return (data || []) as HRPositionDepartment[];
    },
  });

  // READ ONLY: how many people currently hold each position.
  const heldByQuery = useQuery({
    queryKey: HELD_BY_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('hr_assignments')
        .select('position_id')
        .is('ended_on', null);
      if (error) throw error;
      const counts: Record<string, number> = {};
      (data || []).forEach((row: any) => {
        if (row.position_id) counts[row.position_id] = (counts[row.position_id] || 0) + 1;
      });
      return counts;
    },
  });

  // READ ONLY: what a title grants once assigned.
  const accessQuery = useQuery({
    queryKey: ACCESS_KEY,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('hr_position_access')
        .select('position_id, dashboard_key, role');
      if (error) throw error;
      const map: Record<string, HRPositionAccessLabel[]> = {};
      (data || []).forEach((row: any) => {
        if (!row.position_id) return;
        map[row.position_id] = map[row.position_id] || [];
        map[row.position_id].push({ dashboard_key: row.dashboard_key, role: row.role });
      });
      return map;
    },
  });

  const describeError = (error: any) => {
    if (error?.code === '23505' || String(error?.message || '').includes('duplicate key')) {
      return null;
    }
    return error?.message || 'Operation failed';
  };

  const addPosition = useMutation({
    mutationFn: async ({
      title,
      departmentId,
      reason,
    }: { title: string; departmentId: string | null; reason: string }) => {
      const cleanReason = requireReason(reason);
      const actorId = requireActor();
      const cleanTitle = title.trim();
      if (!cleanTitle) throw new Error('Title is required');
      if (isProtectedTitle(cleanTitle)) throw new Error(PROTECTED_TITLE_MESSAGE);
      const key = slugifyPositionKey(cleanTitle);
      if (!key) throw new Error('Title must contain letters or numbers');
      const { data: inserted, error } = await supabase
        .from('hr_positions')
        .insert({ title: cleanTitle, key, department_id: departmentId })
        .select('id')
        .single();
      if (error) {
        if (describeError(error) === null) {
          throw new Error(`a role with this key already exists: ${key}`);
        }
        throw error;
      }
      if (!inserted?.id) throw new Error('Role was not created');
      await logAudit({
        user_id: actorId, action_type: 'hr_position_created', table_name: 'hr_positions',
        record_id: inserted.id,
        metadata: { title: cleanTitle, key, department_id: departmentId, reason: cleanReason },
      });
    },
    onSuccess: refetchAll,
  });

  const renamePosition = useMutation({
    mutationFn: async ({
      id,
      title,
      currentKey,
      currentTitle,
      reason,
    }: { id: string; title: string; currentKey: string; currentTitle: string; reason: string }) => {
      const cleanReason = requireReason(reason);
      const actorId = requireActor();
      const cleanTitle = title.trim();
      if (!cleanTitle) throw new Error('Title is required');
      // Protected in both directions: the row that carries it, and any title becoming it.
      if (currentKey === PROTECTED_TITLE_KEY || isProtectedTitle(currentTitle) || isProtectedTitle(cleanTitle)) {
        throw new Error(PROTECTED_TITLE_MESSAGE);
      }
      const { error } = await supabase.from('hr_positions').update({ title: cleanTitle }).eq('id', id);
      if (error) throw error;
      await logAudit({
        user_id: actorId, action_type: 'hr_position_updated', table_name: 'hr_positions', record_id: id,
        metadata: { title: cleanTitle, previous_title: currentTitle, reason: cleanReason },
      });
    },
    onSuccess: refetchAll,
  });

  const movePosition = useMutation({
    mutationFn: async ({
      id,
      departmentId,
      reason,
    }: { id: string; departmentId: string | null; reason: string }) => {
      const cleanReason = requireReason(reason);
      const actorId = requireActor();
      const { error } = await supabase
        .from('hr_positions')
        .update({ department_id: departmentId })
        .eq('id', id);
      if (error) throw error;
      await logAudit({
        user_id: actorId, action_type: 'hr_position_moved', table_name: 'hr_positions', record_id: id,
        metadata: { department_id: departmentId, reason: cleanReason },
      });
    },
    onSuccess: refetchAll,
  });

  const setPositionActive = useMutation({
    mutationFn: async ({
      id,
      active,
      heldBy: heldByCount,
      reason,
    }: { id: string; active: boolean; heldBy: number; reason: string }) => {
      const cleanReason = requireReason(reason);
      const actorId = requireActor();
      if (!active && heldByCount > 0) {
        throw new Error(
          `Cannot deactivate: this position is held by ${heldByCount} ${heldByCount === 1 ? 'person' : 'people'}. The position must be vacated first.`,
        );
      }
      const { error } = await supabase.from('hr_positions').update({ active }).eq('id', id);
      if (error) throw error;
      await logAudit({
        user_id: actorId,
        action_type: active ? 'hr_position_activated' : 'hr_position_deactivated',
        table_name: 'hr_positions', record_id: id,
        metadata: { active, reason: cleanReason },
      });
    },
    onSuccess: refetchAll,
  });

  return {
    positions: positionsQuery.data || [],
    departments: departmentsQuery.data || [],
    heldBy: heldByQuery.data || {},
    accessByPosition: accessQuery.data || {},
    isLoading:
      positionsQuery.isLoading || departmentsQuery.isLoading || heldByQuery.isLoading || accessQuery.isLoading,
    refetchAll,
    addPosition,
    renamePosition,
    movePosition,
    setPositionActive,
  };
}