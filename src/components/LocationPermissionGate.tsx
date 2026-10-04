import { ReactNode } from 'react';

interface LocationPermissionGateProps {
  children: ReactNode;
}

/**
 * LocationPermissionGate - Wrapper component for location tracking.
 * Location tracking is handled automatically by useLocationTracking hook
 * in the Dashboard. This component simply passes through children.
 */
export function LocationPermissionGate({ children }: LocationPermissionGateProps) {
  // Always render children - no blocking UI, no prompts
  // Location tracking is handled silently by useLocationTracking in Dashboard
  return <>{children}</>;
}
