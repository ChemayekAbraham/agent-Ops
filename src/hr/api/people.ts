/**
 * HR data access — People (hr_departments, hr_staff, hr_assignments)
 */
import type { Assignment, Department, Employee } from '../types';
import { requireUserId, supabase, unwrap } from './client';

type DeptRow = { id: string; key: string; name: string; active: boolean };
type AssignmentRow = {
  id: string;
  staff_id: string;
  department_id: string;
  position_id: string;
  reports_to_position_id: string | null;
  position?: { id: string; title: string | null } | null;
  reports_to?: { id: string; title: string | null } | null;
  started_on: string;
  ended_on: string | null;
  is_primary?: boolean;
};

const ASSIGNMENT_SELECT =
  'id, staff_id, department_id, position_id, reports_to_position_id, started_on, ended_on, is_primary, position:hr_positions!position_id(id, title), reports_to:hr_positions!reports_to_position_id(id, title)';

function mapDepartment(row: DeptRow): Department {
  return {
    id: row.id,
    name: row.name,
    code: row.key,
    head_employee_id: null,
    active: row.active,
  };
}

function mapAssignment(row: AssignmentRow, departmentName: string): Assignment {
  return {
    id: row.id,
    employee_id: row.staff_id,
    department_id: row.department_id,
    department_name: departmentName,
    role_title: row.position?.title ?? '',
    manager_employee_id: row.reports_to_position_id,
    employment_type: 'permanent',
    valid_from: row.started_on,
    valid_to: row.ended_on,
  };
}

export async function getDepartments(): Promise<Department[]> {
  return getDepartmentsInternal();
}

/** Creates a department; the key is derived from the name. */
export async function createDepartment(input: {
  name: string;
  measurementMode: 'output' | 'time';
}): Promise<Department> {
  const name = input.name.trim();
  const row = unwrap(
    await supabase
      .from('hr_departments')
      .insert({
        name,
        key: name.toLowerCase().replace(/[\s&]+/g, '_'),
        measurement_mode: input.measurementMode,
      })
      .select('id, key, name, active')
      .single(),
  ) as DeptRow;
  return mapDepartment(row);
}

export type Position = {
  id: string;
  title: string;
  key: string;
  department_id: string | null;
};

/** Active positions, ordered by title. Reporting lines point at these. */
export async function getPositions(): Promise<Position[]> {
  return unwrap(
    await supabase
      .from('hr_positions')
      .select('id, title, key, department_id')
      .eq('active', true)
      .order('title', { ascending: true }),
  ) as Position[];
}

/** Creates a position; the key is derived from the title. */
export async function createPosition(input: {
  title: string;
  departmentId?: string | null;
}): Promise<Position> {
  const title = input.title.trim();
  return unwrap(
    await supabase
      .from('hr_positions')
      .insert({
        title,
        key: title.toLowerCase().replace(/\s+/g, '_'),
        department_id: input.departmentId || null,
      })
      .select('id, title, key, department_id')
      .single(),
  ) as Position;
}

async function getDepartmentsInternal(): Promise<Department[]> {
  const rows = unwrap(
    await supabase
      .from('hr_departments')
      .select('id, key, name, active')
      .order('name', { ascending: true }),
  ) as DeptRow[];
  return rows.map(mapDepartment);
}

async function departmentNameMap(): Promise<Record<string, string>> {
  const rows = unwrap(
    await supabase.from('hr_departments').select('id, name'),
  ) as { id: string; name: string }[];
  return Object.fromEntries(rows.map((d) => [d.id, d.name]));
}

type StaffRow = {
  id: string;
  user_id: string;
  staff_ref: string;
  active: boolean;
  created_at: string;
  ended_on: string | null;
};

async function hydrateStaff(staff: StaffRow[]): Promise<Employee[]> {
  if (staff.length === 0) return [];
  const userIds = staff.map((s) => s.user_id);
  const staffIds = staff.map((s) => s.id);

  const profiles = unwrap(
    await supabase
      .from('profiles')
      .select('id, full_name, email, phone, avatar_url')
      .in('id', userIds),
  ) as { id: string; full_name: string | null; email: string | null; phone: string | null; avatar_url: string | null }[];
  const profileById = Object.fromEntries(profiles.map((p) => [p.id, p]));

  const assignments = unwrap(
    await supabase
      .from('hr_assignments')
      .select(ASSIGNMENT_SELECT)
      .in('staff_id', staffIds)
      .is('ended_on', null),
  ) as unknown as AssignmentRow[];
  const names = await departmentNameMap();
  const currentByStaff: Record<string, Assignment> = {};
  for (const a of assignments) {
    // A person may hold several active assignments. The primary one is the
    // face of the row and the department their metrics roll up to.
    if (currentByStaff[a.staff_id] && a.is_primary !== true) continue;
    currentByStaff[a.staff_id] = mapAssignment(a, names[a.department_id] ?? '');
  }

  return staff.map((s) => {
    const p = profileById[s.user_id];
    return {
      id: s.id,
      staff_number: s.staff_ref,
      full_name: p?.full_name ?? '',
      email: p?.email ?? '',
      phone: p?.phone ?? '',
      photo_url: p?.avatar_url ?? null,
      status: s.active ? 'active' : 'exited',
      joined_at: s.created_at,
      ended_on: s.ended_on,
      current_assignment: currentByStaff[s.id] ?? null,
    } satisfies Employee;
  });
}

export async function getEmployees(): Promise<Employee[]> {
  const staff = unwrap(
    await supabase
      .from('hr_staff')
      .select('id, user_id, staff_ref, active, created_at, ended_on')
      .order('created_at', { ascending: true }),
  ) as StaffRow[];
  return hydrateStaff(staff);
}

/** Alias kept explicit for callers that want the whole directory. */
export async function getStaffDirectory(): Promise<Employee[]> {
  return getEmployees();
}

export async function getEmployee(employeeId: string): Promise<Employee | null> {
  const rows = unwrap(
    await supabase
      .from('hr_staff')
      .select('id, user_id, staff_ref, active, created_at, ended_on')
      .eq('id', employeeId)
      .limit(1),
  ) as StaffRow[];
  const hydrated = await hydrateStaff(rows);
  return hydrated[0] ?? null;
}

/** The hr_staff record belonging to the signed-in user, if enrolled. */
export async function getMyStaff(): Promise<Employee | null> {
  const userId = await requireUserId();
  const rows = unwrap(
    await supabase
      .from('hr_staff')
      .select('id, user_id, staff_ref, active, created_at, ended_on')
      .eq('user_id', userId)
      .limit(1),
  ) as StaffRow[];
  const hydrated = await hydrateStaff(rows);
  return hydrated[0] ?? null;
}

/** Enrols a user into HR. Optionally creates their opening assignment. */
export async function enrollStaff(input: {
  userId: string;
  /** Optional — the database generates EMP-00001 style refs when omitted. */
  staffRef?: string;
  departmentId?: string;
  positionId?: string;
  reportsToPositionId?: string | null;
  startedOn?: string;
}): Promise<Employee> {
  const enrolledBy = await requireUserId();
  const staff = unwrap(
    await supabase
      .from('hr_staff')
      .insert({
        user_id: input.userId,
        ...(input.staffRef ? { staff_ref: input.staffRef } : {}),
        enrolled_by: enrolledBy,
      })
      .select('id, user_id, staff_ref, active, created_at')
      .single(),
  ) as StaffRow;

  if (input.departmentId && input.positionId) {
    unwrap(
      await supabase
        .from('hr_assignments')
        .insert({
          staff_id: staff.id,
          department_id: input.departmentId,
          position_id: input.positionId,
          reports_to_position_id: input.reportsToPositionId ?? undefined,
          started_on: input.startedOn ?? new Date().toISOString().slice(0, 10),
          // The opening assignment is always the person's primary one.
          is_primary: true,
        })
        .select('id')
        .single(),
    );
  }

  // The staff row exists from here on. A failing follow-up read is a display
  // problem, never an enrolment failure — fall back to the inserted row.
  try {
    const hydrated = await hydrateStaff([staff]);
    if (hydrated[0]) return hydrated[0];
  } catch (e) {
    console.warn('[hr] enrolled, but reading the new staff record failed', e);
  }
  return {
    id: staff.id,
    staff_number: staff.staff_ref,
    full_name: '',
    email: '',
    phone: '',
    photo_url: null,
    status: staff.active ? 'active' : 'exited',
    joined_at: staff.created_at,
    ended_on: staff.ended_on ?? null,
    current_assignment: null,
  } satisfies Employee;
}

export type UnenrolledStaffCandidate = {
  user_id: string;
  display_name: string;
  staff_roles: string;
};

/** One active assignment, shown in the expandable staff row. */
export type ActiveAssignment = {
  id: string;
  staff_id: string;
  department_id: string;
  department_name: string;
  position_title: string;
  reports_to_title: string | null;
  started_on: string;
  is_primary: boolean;
};

/** Every active (not ended) assignment, grouped by staff id. */
export async function getActiveAssignmentsByStaff(): Promise<Record<string, ActiveAssignment[]>> {
  const rows = unwrap(
    await supabase.from('hr_assignments').select(ASSIGNMENT_SELECT).is('ended_on', null),
  ) as unknown as AssignmentRow[];
  const names = await departmentNameMap();
  const grouped: Record<string, ActiveAssignment[]> = {};
  for (const r of rows) {
    (grouped[r.staff_id] ||= []).push({
      id: r.id,
      staff_id: r.staff_id,
      department_id: r.department_id,
      department_name: names[r.department_id] ?? '',
      position_title: r.position?.title ?? '',
      reports_to_title: r.reports_to?.title ?? null,
      started_on: r.started_on,
      is_primary: r.is_primary === true,
    });
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.started_on.localeCompare(b.started_on));
  }
  return grouped;
}

/**
 * Adds a further active assignment to someone who is already enrolled.
 *
 * When it should become the primary one, the existing active primary is
 * demoted FIRST and the new row inserted SECOND — the reverse order would
 * momentarily leave two primaries and the unique index would reject it.
 */
export async function addAssignment(input: {
  staffId: string;
  departmentId: string;
  positionId: string;
  reportsToPositionId?: string | null;
  makePrimary: boolean;
  startedOn?: string;
}): Promise<void> {
  if (input.makePrimary) {
    unwrap(
      await supabase
        .from('hr_assignments')
        .update({ is_primary: false })
        .eq('staff_id', input.staffId)
        .is('ended_on', null)
        .eq('is_primary', true)
        .select('id'),
    );
  }

  unwrap(
    await supabase
      .from('hr_assignments')
      .insert({
        staff_id: input.staffId,
        department_id: input.departmentId,
        position_id: input.positionId,
        reports_to_position_id: input.reportsToPositionId ?? null,
        started_on: input.startedOn ?? new Date().toISOString().slice(0, 10),
        is_primary: input.makePrimary,
      })
      .select('id')
      .single(),
  );
}

/**
 * Staff-role platform users that are not yet enrolled.
 * Served entirely by the `hr_unenrolled_staff_candidates` database function —
 * the picker never scans the profiles table.
 */
export async function searchUnenrolledStaff(search: string): Promise<UnenrolledStaffCandidate[]> {
  return unwrap(
    await supabase.rpc('hr_unenrolled_staff_candidates', { _q: search }),
  ) as UnenrolledStaffCandidate[];
}

/**
 * Department is a property of the assignment, never of the employee.
 * Use this when reporting on a past period so historical numbers stay stable.
 */
export async function getAssignmentsForPeriod(
  periodStart: string,
  periodEnd: string,
): Promise<Assignment[]> {
  const rows = unwrap(
    await supabase
      .from('hr_assignments')
      .select(ASSIGNMENT_SELECT)
      .lte('started_on', periodEnd)
      .or(`ended_on.is.null,ended_on.gte.${periodStart}`),
  ) as unknown as AssignmentRow[];
  const names = await departmentNameMap();
  return rows.map((r) => mapAssignment(r, names[r.department_id] ?? ''));
}

/**
 * Hands one open position from its current holder to another staff member.
 * The database ends the source assignment and opens the new one atomically;
 * errors are thrown verbatim so the caller can show the database message.
 */
export async function transferPosition(input: {
  fromAssignmentId: string;
  toStaffId: string;
  reason: string;
}): Promise<string> {
  return unwrap(
    await supabase.rpc('hr_transfer_position', {
      p_from_assignment: input.fromAssignmentId,
      p_to_staff_id: input.toStaffId,
      p_reason: input.reason,
    }),
  ) as string;
}

/**
 * Moves one open assignment to a different department.
 * Returns the id of the newly opened assignment. Throws on error.
 */
export async function changeDepartment(input: {
  assignmentId: string;
  departmentId: string;
  reason: string;
}): Promise<string> {
  return unwrap(
    await supabase.rpc('hr_change_department', {
      p_assignment: input.assignmentId,
      p_department_id: input.departmentId,
      p_reason: input.reason,
    }),
  ) as string;
}

/**
 * Ends one open assignment, so the person no longer holds that position or
 * sits in that department. History is kept: the row is closed with an
 * `ended_on` date rather than deleted, and the primary flag is cleared so a
 * different assignment can take over as primary afterwards.
 */
export async function endAssignment(input: {
  assignmentId: string;
  reason: string;
  endedOn?: string;
}): Promise<void> {
  const endedOn = input.endedOn ?? new Date().toISOString().slice(0, 10);
  const rows = unwrap(
    await supabase
      .from('hr_assignments')
      .update({ ended_on: endedOn, is_primary: false })
      .eq('id', input.assignmentId)
      .is('ended_on', null)
      .select('id'),
  ) as unknown as { id: string }[];

  if (!rows || rows.length === 0) {
    throw new Error(
      'Nothing was removed. The assignment may already be closed, or your role does not permit this change.',
    );
  }

  const { data: auth } = await supabase.auth.getUser();
  await supabase.from('audit_logs').insert({
    action_type: 'hr_assignment_ended',
    table_name: 'hr_assignments',
    record_id: input.assignmentId,
    user_id: auth?.user?.id ?? null,
    metadata: { reason: input.reason, ended_on: endedOn },
  });
}

/**
 * Exits a staff member. One UPDATE writes active = false, ended_on and
 * exit_reason together — the check constraints demand that the reason is at
 * least 10 characters whenever ended_on is set, and that ended_on is only
 * set when active is false. The ended_on IS NULL filter makes the call
 * idempotent: an already-exited member cannot be exited twice.
 */
export async function exitStaff(input: {
  staffId: string;
  endedOn: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new Error('The exit reason must be at least 10 characters.');
  }
  if (Number.isNaN(Date.parse(input.endedOn))) {
    throw new Error('The ended-on date is not a valid date.');
  }

  const rows = unwrap(
    await supabase
      .from('hr_staff')
      .update({ active: false, ended_on: input.endedOn, exit_reason: reason })
      .eq('id', input.staffId)
      .is('ended_on', null)
      .select('id'),
  ) as unknown as { id: string }[];

  if (!rows || rows.length === 0) {
    throw new Error(
      'Nothing was changed. The staff member may already be exited, or your role does not permit this change.',
    );
  }

  const { data: auth } = await supabase.auth.getUser();
  await supabase.from('audit_logs').insert({
    action_type: 'hr_staff_exited',
    table_name: 'hr_staff',
    record_id: input.staffId,
    user_id: auth?.user?.id ?? null,
    metadata: { reason, ended_on: input.endedOn },
  });
}

/**
 * Reinstates an exited staff member. Both ended_on and exit_reason are
 * nulled in the same statement as active = true — nulling only one would
 * trip the check constraints.
 */
export async function reinstateStaff(input: {
  staffId: string;
  reason: string;
}): Promise<void> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    throw new Error('The reinstatement reason must be at least 10 characters.');
  }

  const rows = unwrap(
    await supabase
      .from('hr_staff')
      .update({ active: true, ended_on: null, exit_reason: null })
      .eq('id', input.staffId)
      .select('id'),
  ) as unknown as { id: string }[];

  if (!rows || rows.length === 0) {
    throw new Error(
      'Nothing was changed. The staff member may not exist, or your role does not permit this change.',
    );
  }

  const { data: auth } = await supabase.auth.getUser();
  await supabase.from('audit_logs').insert({
    action_type: 'hr_staff_reinstated',
    table_name: 'hr_staff',
    record_id: input.staffId,
    user_id: auth?.user?.id ?? null,
    metadata: { reason },
  });
}
