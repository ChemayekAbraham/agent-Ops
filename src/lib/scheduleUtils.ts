import { addDays, format } from 'date-fns';

export interface SchedulePayment {
  payment_number: number;
  due_date: string;
  amount: number;
  status: string;
}

/**
 * Generate a repayment schedule based on total amount and number of payments
 */
export function generateRepaymentSchedule(
  totalAmount: number,
  numberOfPayments: number,
  durationDays: number,
  startDate: Date = new Date()
): SchedulePayment[] {
  const schedule: SchedulePayment[] = [];
  const daysBetweenPayments = Math.floor(durationDays / numberOfPayments);
  const amountPerPayment = Math.ceil(totalAmount / numberOfPayments);
  
  // Handle remainder to ensure total matches
  const remainder = totalAmount - (amountPerPayment * (numberOfPayments - 1));

  for (let i = 0; i < numberOfPayments; i++) {
    const dueDate = addDays(startDate, daysBetweenPayments * (i + 1));
    const isLastPayment = i === numberOfPayments - 1;
    
    schedule.push({
      payment_number: i + 1,
      due_date: format(dueDate, 'yyyy-MM-dd'),
      amount: isLastPayment ? remainder : amountPerPayment,
      status: 'pending',
    });
  }

  return schedule;
}

/**
 * Insert repayment schedule into database
 */
export async function insertRepaymentSchedule(
  supabase: any,
  rentRequestId: string,
  tenantId: string,
  schedule: SchedulePayment[]
): Promise<{ success: boolean; error?: string }> {
  const scheduleRows = schedule.map((item) => ({
    rent_request_id: rentRequestId,
    tenant_id: tenantId,
    payment_number: item.payment_number,
    due_date: item.due_date,
    amount: item.amount,
    status: item.status,
  }));

  const { error } = await supabase
    .from('repayment_schedules')
    .insert(scheduleRows);

  if (error) {
    return { success: false, error: error.message };
  }

  return { success: true };
}
