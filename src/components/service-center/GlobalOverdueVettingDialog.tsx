import { useLocation } from 'react-router-dom';
import { useAuthenticatedAudience } from '@/hooks/useAuthenticatedPoll';
import { OverdueVettingDialog } from './OverdueVettingDialog';
import { SERVICE_CENTER_PATH } from './vettingNav';

/** Mounted once. Shows only for managers with overdue items (server-decided); suppressed on the queue page, which uses the banner. */
export function GlobalOverdueVettingDialog() {
  const signedIn = useAuthenticatedAudience();
  const { pathname } = useLocation();
  if (!signedIn) return null;
  return <OverdueVettingDialog suppressed={pathname === SERVICE_CENTER_PATH} />;
}
