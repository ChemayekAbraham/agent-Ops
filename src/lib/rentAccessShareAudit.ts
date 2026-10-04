import { supabase } from '@/integrations/supabase/client';
import { RENT_ACCESS_CARD_IMAGE_VERSION } from '@/lib/rentAccessLimitPdf';

export type RentAccessShareChannel =
  | 'whatsapp'
  | 'whatsapp_preview'
  | 'sms'
  | 'image_download'
  | 'pdf_download'
  | 'copy_link'
  | 'native_share';

export interface RecordRentAccessShareInput {
  agentId: string;
  tenantId: string;
  tenantName?: string;
  tenantPhone?: string;
  channel: RentAccessShareChannel;
  limitAmount?: number | null;
  shareUrl?: string | null;
  messageSnapshot?: string | null;
  success?: boolean;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  imageVersion?: string;
}

/**
 * Fire-and-forget audit logger for every WhatsApp / SMS / image share of a
 * tenant's Rent Access Limit card. Never throws — sharing must not be blocked
 * by an audit failure.
 */
export async function recordRentAccessShare(input: RecordRentAccessShareInput): Promise<void> {
  try {
    await supabase.from('rent_access_share_audit').insert([{
      agent_id: input.agentId,
      tenant_id: input.tenantId,
      tenant_name: input.tenantName ?? null,
      tenant_phone: input.tenantPhone ?? null,
      channel: input.channel,
      image_version: input.imageVersion ?? RENT_ACCESS_CARD_IMAGE_VERSION,
      limit_amount: input.limitAmount ?? null,
      share_url: input.shareUrl ?? null,
      message_snapshot: input.messageSnapshot ?? null,
      success: input.success ?? true,
      error_message: input.errorMessage ?? null,
      metadata: (input.metadata ?? {}) as any,
    }]);
  } catch (err) {
    // Audit must never block the share flow.
    // eslint-disable-next-line no-console
    console.warn('[rentAccessShareAudit] insert failed', err);
  }
}