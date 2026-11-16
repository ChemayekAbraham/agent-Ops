import { useAuth } from '@/hooks/useAuth';
import { DirectPayOpsQueue } from '@/components/direct-pay/DirectPayOps';

export default function DirectPayments() {
  const { enabledRoles, loading } = useAuth();
  if (loading) return <p role="status">Loading…</p>;
  const roleNames: readonly string[] = enabledRoles;
  if (!roleNames.some((role) => role === 'landlord_ops' || role === 'coo' || role === 'super_admin')) return <p>This view is unavailable for your account.</p>;
  return <DirectPayOpsQueue readOnly={!roleNames.includes('landlord_ops')} />;
}