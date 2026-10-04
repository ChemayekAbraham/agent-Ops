/**
 * HR Payroll configuration data access (hr_pay_grades, hr_pay_components).
 * Reference data only — no employee or payslip data is read or written here.
 */
import { supabase, unwrap } from '../../api/client';

export interface PayGradeRow {
  id: string;
  code: string;
  name: string;
  band_min: number;
  band_max: number;
  currency: string;
  active: boolean;
}

export interface PayComponentRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  taxable: boolean;
  nssf_able: boolean;
  lst_able: boolean;
  is_statutory: boolean;
  display_order: number;
  active: boolean;
}

export async function listGrades(): Promise<PayGradeRow[]> {
  const res = await supabase
    .from('hr_pay_grades')
    .select('id, code, name, band_min, band_max, currency, active')
    .order('code', { ascending: true });
  return (unwrap(res) ?? []) as PayGradeRow[];
}

export async function createGrade(input: {
  code: string;
  name: string;
  bandMin: number;
  bandMax: number;
  currency: string;
}): Promise<PayGradeRow> {
  const res = await supabase
    .from('hr_pay_grades')
    .insert({
      code: input.code,
      name: input.name,
      band_min: input.bandMin,
      band_max: input.bandMax,
      currency: input.currency,
    })
    .select('id, code, name, band_min, band_max, currency, active')
    .single();
  return unwrap(res) as PayGradeRow;
}

export async function updateGrade(
  id: string,
  input: { name: string; bandMin: number; bandMax: number; active: boolean },
): Promise<PayGradeRow> {
  const res = await supabase
    .from('hr_pay_grades')
    .update({
      name: input.name,
      band_min: input.bandMin,
      band_max: input.bandMax,
      active: input.active,
    })
    .eq('id', id)
    .select('id, code, name, band_min, band_max, currency, active')
    .single();
  return unwrap(res) as PayGradeRow;
}

export async function listComponents(): Promise<PayComponentRow[]> {
  const res = await supabase
    .from('hr_pay_components')
    .select('id, code, name, kind, taxable, nssf_able, lst_able, is_statutory, display_order, active')
    .order('display_order', { ascending: true });
  return (unwrap(res) ?? []) as PayComponentRow[];
}

export async function setComponentActive(id: string, active: boolean): Promise<void> {
  const res = await supabase
    .from('hr_pay_components')
    .update({ active })
    .eq('id', id)
    .select('id')
    .single();
  unwrap(res);
}