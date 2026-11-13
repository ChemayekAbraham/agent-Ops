import { Component, useEffect, type ComponentProps, type ReactNode } from 'react';
import { useCoSupportFloatWatch } from '@/hooks/useCoSupport';
import { coSupportErrorMessage, type CoSupportFloatWatchState, type CoSupportPreview } from '@/lib/coSupport';
import type { CoSupportDeposit } from './CoSupportFloatSheet';

export interface CoSupportWatchResult { state: CoSupportFloatWatchState; preview: CoSupportPreview | null }

function Watch({ code, userId, deposit, onChange }: { code: string | null; userId?: string; deposit: CoSupportDeposit; onChange: (value: CoSupportWatchResult) => void }) {
  const watch = useCoSupportFloatWatch(code, userId, deposit);
  useEffect(() => onChange(watch), [watch.state, watch.preview, onChange]);
  return null;
}

/** A failed optional progress read must never crash the invitation itself. */
class WatchBoundary extends Component<{ children: ReactNode; onError: (error: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { this.props.onError(coSupportErrorMessage(error)); }
  render() { return this.state.failed ? null : this.props.children; }
}

export function CoSupportDepositWatch(props: ComponentProps<typeof Watch> & { onError: (error: unknown) => void }) {
  return <WatchBoundary onError={props.onError}><Watch {...props} /></WatchBoundary>;
}