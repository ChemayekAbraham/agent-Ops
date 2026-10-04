import { ReactNode } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Loader2, ShieldAlert, Clock, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useMyProxyAgentStatus } from '@/hooks/useProxyAgentApproval';

/**
 * Route gate for proxy-agent-only surfaces.
 *
 * Access requires a database-verified proxy agent identity with
 * `status = 'approved'` (see `my_proxy_agent_status`). Pending, rejected,
 * suspended and non-applicants are all denied — the client never decides
 * eligibility on its own, it only renders the server verdict.
 */
export default function ProxyAgentGuard({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const { data, isLoading, isError, error } = useMyProxyAgentStatus(user?.id);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  if (isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Verifying proxy agent access…</p>
      </div>
    );
  }

  const status = data?.status ?? 'none';

  if (status === 'approved') return <>{children}</>;

  const pending = status === 'pending';

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 text-center space-y-3">
        <div className="mx-auto h-11 w-11 rounded-full bg-muted flex items-center justify-center">
          {pending ? (
            <Clock className="h-5 w-5 text-amber-600" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-destructive" />
          )}
        </div>
        <h1 className="text-lg font-bold">
          {pending ? 'Approval pending' : 'Proxy agents only'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isError
            ? `Access could not be verified: ${error instanceof Error ? error.message : 'unknown error'}`
            : pending
              ? 'Your proxy agent application is still under review. You will get access to the command center once Partner Operations approves it.'
              : status === 'rejected'
                ? 'Your proxy agent application was not approved, so this command center is not available.'
                : status === 'suspended'
                  ? 'Your proxy agent access is currently suspended. Contact Partner Operations to restore it.'
                  : 'This page is only available to verified proxy agents.'}
        </p>
        {data?.review_notes && (
          <p className="text-xs text-muted-foreground italic">{data.review_notes}</p>
        )}
        <Button variant="outline" className="w-full" onClick={() => navigate('/', { replace: true })}>
          <ArrowLeft className="h-4 w-4 mr-2" /> Back to home
        </Button>
      </div>
    </div>
  );
}