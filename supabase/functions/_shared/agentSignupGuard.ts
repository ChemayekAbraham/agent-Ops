// Shared anti-bot guard for agent-assisted (server-side) registrations.
// Logs device fingerprint / true source screen / IP / user agent into
// signup_attempts and enforces the registration burst cap.
export type AgentSignupGuardResult = {
  allowed: boolean;
  status: string;
  reason: string | null;
  attempt_id: string | null;
};

type Telemetry = {
  device_fp?: unknown;
  screen?: unknown;
  user_agent?: unknown;
  target_role?: unknown;
};

function str(value: unknown, max = 500): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export async function guardAgentAssistedSignup(
  admin: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> },
  opts: {
    req: Request;
    actorUserId: string;
    telemetry?: Telemetry | null;
    email?: string | null;
    phone?: string | null;
    targetRole?: string;
  },
): Promise<AgentSignupGuardResult> {
  const t = (opts.telemetry ?? {}) as Telemetry;
  const ip = (opts.req.headers.get('x-forwarded-for') || '').split(',')[0]?.trim() || null;

  const { data, error } = await admin.rpc('record_agent_assisted_signup', {
    p_actor_user_id: opts.actorUserId,
    p_device_fp: str(t.device_fp, 128),
    p_screen: str(t.screen, 200),
    p_user_agent: str(t.user_agent) ?? opts.req.headers.get('user-agent'),
    p_ip: ip,
    p_email: opts.email ?? null,
    p_phone: opts.phone ?? null,
    p_target_role: str(t.target_role, 40) ?? opts.targetRole ?? 'tenant',
  });

  if (error) {
    // Fail-open on logging errors: never block a legitimate field registration
    // because the telemetry RPC threw.
    console.error('[agentSignupGuard] rpc error, allowing:', error.message);
    return { allowed: true, status: 'rpc_error', reason: null, attempt_id: null };
  }

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    allowed: Boolean(row.allowed),
    status: String(row.status ?? 'unknown'),
    reason: (row.reason as string | null) ?? null,
    attempt_id: (row.attempt_id as string | null) ?? null,
  };
}

export async function attachAgentSignupUser(
  admin: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }> },
  attemptId: string | null,
  userId: string | null,
) {
  if (!attemptId || !userId) return;
  try {
    await admin.rpc('attach_signup_attempt_user', { p_attempt_id: attemptId, p_user_id: userId });
  } catch { /* non-critical */ }
}
