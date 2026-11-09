import type { ComponentProps } from 'react';
import { Navigate } from 'react-router-dom';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import { useFunderUiV3PreviewState } from './useFunderUiV3Preview';

const SupporterDashboard = lazyWithRetry(() => import('@/components/dashboards/SupporterDashboard'));
const FunderDashboardV3 = lazyWithRetry(() => import('./FunderDashboardV3'));

type Props = ComponentProps<typeof FunderDashboardV3> & {
  /** /dashboard/funder-v3 review route: V3 for switch holders, everyone else is sent to /dashboard/funder. */
  forceV3?: boolean;
};

/**
 * Picks the funder dashboard: the live SupporterDashboard unless the viewer has
 * the `funders_ui_v3` preview switch on. Default OFF; a failed switch read also
 * means the live dashboard. On /dashboard/funder-v3 (`forceV3`) a viewer without
 * the switch is redirected to /dashboard/funder once the server has answered.
 * Rendered inside the page's existing Suspense boundary.
 */
export default function FunderDashboardGate({ forceV3 = false, ...props }: Props) {
  const { on, resolved } = useFunderUiV3PreviewState(props.user?.id);
  if (on) return <FunderDashboardV3 {...props} />;
  if (!forceV3) return <SupporterDashboard {...props} />;
  if (!resolved) return null;
  return <Navigate to="/dashboard/funder" replace />;
}
