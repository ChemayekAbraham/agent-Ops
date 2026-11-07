import type { ComponentProps } from 'react';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import { useFunderUiV3Preview } from './useFunderUiV3Preview';

const SupporterDashboard = lazyWithRetry(() => import('@/components/dashboards/SupporterDashboard'));
const FunderDashboardV3 = lazyWithRetry(() => import('./FunderDashboardV3'));

type Props = ComponentProps<typeof FunderDashboardV3> & {
  /** /dashboard/funder-v3 review route: always V3, whatever the switch says. */
  forceV3?: boolean;
};

/**
 * Picks the funder dashboard for /dashboard/funder: the live SupporterDashboard
 * unless the viewer has the `funders_ui_v3` preview switch on. Default OFF; a
 * failed switch read also means the live dashboard. Rendered inside the page's
 * existing Suspense boundary.
 */
export default function FunderDashboardGate({ forceV3 = false, ...props }: Props) {
  const previewOn = useFunderUiV3Preview(forceV3 ? null : props.user?.id);
  return forceV3 || previewOn ? <FunderDashboardV3 {...props} /> : <SupporterDashboard {...props} />;
}
