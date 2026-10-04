import { getDeviceFingerprint, isValidFingerprintShape } from './deviceFingerprint';

export type AgentSignupTelemetry = {
  device_fp: string | null;
  /** The real in-app screen the agent used, e.g. /dashboard/agent#quick-register */
  screen: string;
  user_agent: string | null;
  target_role?: string;
};

/**
 * Collects the anti-bot telemetry for an agent-assisted registration.
 * Agent-created accounts (tenants, funders, sub-agents) go through edge
 * functions, so they never hit the /auth signup guard. Passing this payload
 * lets the server log the device fingerprint + true source screen and apply
 * the registration burst cap.
 */
export async function collectAgentSignupTelemetry(
  screen: string,
  targetRole?: string,
): Promise<AgentSignupTelemetry> {
  const raw = await getDeviceFingerprint().catch(() => null);
  return {
    device_fp: isValidFingerprintShape(raw) ? raw : null,
    screen:
      screen ||
      (typeof window !== 'undefined' ? window.location.pathname : '/agent-registration'),
    user_agent:
      typeof navigator !== 'undefined' ? (navigator.userAgent || '').slice(0, 500) : null,
    target_role: targetRole,
  };
}
