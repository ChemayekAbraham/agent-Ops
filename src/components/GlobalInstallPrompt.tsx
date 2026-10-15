import { useLocation } from 'react-router-dom';
import InstallNagOverlay from '@/components/InstallNagOverlay';

/** Routes where no install offer should ever appear (signup funnels, etc.). */
const INSTALL_PROMPT_EXCLUDED_PREFIXES = ['/funder-onboarding'];

/** The single install prompt shown across the app. */
export default function GlobalInstallPrompt() {
  const { pathname } = useLocation();
  const excluded = INSTALL_PROMPT_EXCLUDED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );
  if (excluded) return null;
  return <InstallNagOverlay />;
}
