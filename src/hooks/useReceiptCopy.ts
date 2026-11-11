import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchPartnerReceiptRow, type ArchiveRow } from '@/hooks/useReceiptArchive';
import { copyFromPartnerRow, copyFromPayoutRow, reprintNote, type ReceiptCopyData } from '@/lib/receiptCopy';
import type { PartnerReceiptRow } from '@/lib/partnerReceiptPdf';

/** The signed-in person's name, for the "Reprint printed by" line. A failure just leaves the name off. */
async function currentStaffName(): Promise<string | null> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    if (!auth.user) return null;
    const { data } = await supabase.from('profiles').select('full_name').eq('id', auth.user.id).maybeSingle();
    return data?.full_name ?? null;
  } catch {
    return null;
  }
}

export interface ReceiptCopyBundle {
  copy: ReceiptCopyData;
  /** Money in: the full partner receipt (cash confirmation, delivery, linked deposit). */
  partner: PartnerReceiptRow | null;
  /** Money out: the payout's own reference (transaction ID). */
  reference: string | null;
}

/** Everything needed to draw, print or download one row's receipt copy. */
export async function loadReceiptCopy(row: ArchiveRow): Promise<ReceiptCopyBundle> {
  const note = reprintNote(await currentStaffName());
  if (row.source === 'partner_receipt' && row.receipt_no != null) {
    const partner = await fetchPartnerReceiptRow(row.receipt_no, row.id);
    return { copy: copyFromPartnerRow(partner, row.replaced_by_no, note), partner, reference: null };
  }
  let reference: string | null = null;
  try {
    const { data } = await supabase.from('withdrawal_requests').select('transaction_id').eq('id', row.id).maybeSingle();
    reference = data?.transaction_id ?? null;
  } catch {
    reference = null;
  }
  return { copy: copyFromPayoutRow(row, reference, note), partner: null, reference };
}

export function useReceiptCopy(row: ArchiveRow | null) {
  return useQuery({
    queryKey: ['receipt-copy', row?.source, row?.id],
    enabled: !!row,
    queryFn: () => loadReceiptCopy(row!),
  });
}
