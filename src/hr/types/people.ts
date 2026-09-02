/**
 * HR data contracts — People
 * Part of the HR module contract. Do not add, rename or remove fields.
 */
export type EmployeeStatus = 'active' | 'suspended' | 'exited';

export interface Department {
  id: string;
  name: string;
  code: string;
  head_employee_id: string | null;
  active: boolean;
}

/**
 * Department is a property of the POSTING, not of the person.
 * Metrics attach to the assignment that was active during the period,
 * so historical reports never silently rewrite themselves when someone
 * transfers between departments.
 */
export interface Assignment {
  id: string;
  employee_id: string;
  department_id: string;
  department_name: string;
  role_title: string;
  manager_employee_id: string | null;
  employment_type: 'permanent' | 'contract' | 'intern' | 'probation';
  valid_from: string;        // ISO date
  valid_to: string | null;   // null = current posting
}

export interface Employee {
  id: string;
  staff_number: string;
  full_name: string;
  email: string;
  phone: string;
  photo_url: string | null;
  status: EmployeeStatus;
  joined_at: string;
  /** Date the staff member exited (hr_staff.ended_on). */
  ended_on: string | null;
  /** Denormalised for fast display and filtering ONLY. Never the source of truth. */
  current_assignment: Assignment | null;
}
