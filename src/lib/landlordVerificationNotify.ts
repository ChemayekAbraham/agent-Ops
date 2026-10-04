import { supabase } from '@/integrations/supabase/client';

type NotifType = 'info' | 'success' | 'error' | 'warning';

interface NotifPayload {
  user_id: string;
  title: string;
  message: string;
  type: NotifType;
  metadata?: Record<string, unknown>;
}

/**
 * Best-effort lookup of a landlord's app user account by phone number.
 * Landlords are stored as records (no direct user link), but many also have a
 * profile (auto-registered by phone). We match on the last 9 digits so local
 * formatting differences (0XXXXXXXXX vs +256XXXXXXXXX) still resolve.
 */
async function resolveLandlordUserId(phone?: string | null): Promise<string | null> {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length < 9) return null;
  const last9 = digits.slice(-9);
  try {
    const { data } = await supabase
      .from('profiles')
      .select('id, phone')
      .ilike('phone', `%${last9}`)
      .limit(1);
    return data && data.length ? (data[0] as any).id : null;
  } catch {
    return null;
  }
}

async function insertNotifications(rows: NotifPayload[]) {
  const clean = rows.filter(r => !!r.user_id);
  if (!clean.length) return;
  try {
    await supabase.from('notifications').insert(
      clean.map(r => ({
        user_id: r.user_id,
        title: r.title,
        message: r.message,
        type: r.type,
        metadata: (r.metadata ?? {}) as never,
      })),
    );
  } catch {
    // Notifications are non-critical — never block the main flow on failure.
  }
}

const META = (status: string, landlordId: string, requestId?: string | null) => ({
  kind: 'landlord_verification_request',
  status,
  landlord_id: landlordId,
  request_id: requestId ?? null,
});

/** Agent submitted a request to verify an unverified landlord. */
export async function notifyVerificationCreated(opts: {
  agentId: string;
  agentName?: string | null;
  landlordId: string;
  landlordName?: string | null;
  landlordPhone?: string | null;
  requestId?: string | null;
}) {
  const name = opts.landlordName || 'the landlord';
  const rows: NotifPayload[] = [
    {
      user_id: opts.agentId,
      title: 'Verification request sent',
      message: `Landlord Operations will review ${name}. You'll be alerted once they decide.`,
      type: 'info',
      metadata: META('pending', opts.landlordId, opts.requestId),
    },
  ];
  const landlordUserId = await resolveLandlordUserId(opts.landlordPhone);
  if (landlordUserId && landlordUserId !== opts.agentId) {
    rows.push({
      user_id: landlordUserId,
      title: 'Verification requested',
      message: `${opts.agentName || 'An agent'} asked Welile to verify your landlord account.`,
      type: 'info',
      metadata: META('pending', opts.landlordId, opts.requestId),
    });
  }
  await insertNotifications(rows);
}

/** Ops verified or rejected a landlord verification request. */
export async function notifyVerificationResolved(opts: {
  status: 'verified' | 'rejected';
  agentId: string;
  landlordId: string;
  landlordName?: string | null;
  landlordPhone?: string | null;
  comment?: string | null;
  requestId?: string | null;
}) {
  const name = opts.landlordName || 'the landlord';
  const verified = opts.status === 'verified';
  const rows: NotifPayload[] = [
    {
      user_id: opts.agentId,
      title: verified ? '✅ Landlord verified' : 'Verification rejected',
      message: verified
        ? `${name} is now verified — you can post the rent request.`
        : `Your request to verify ${name} was rejected.${opts.comment ? ` Reason: ${opts.comment}` : ''}`,
      type: verified ? 'success' : 'error',
      metadata: META(opts.status, opts.landlordId, opts.requestId),
    },
  ];
  const landlordUserId = await resolveLandlordUserId(opts.landlordPhone);
  if (landlordUserId && landlordUserId !== opts.agentId) {
    rows.push({
      user_id: landlordUserId,
      title: verified ? '✅ Account verified' : 'Verification not approved',
      message: verified
        ? 'Your landlord account has been verified by Welile.'
        : `Your landlord verification was not approved.${opts.comment ? ` Reason: ${opts.comment}` : ''}`,
      type: verified ? 'success' : 'warning',
      metadata: META(opts.status, opts.landlordId, opts.requestId),
    });
  }
  await insertNotifications(rows);
}
