import { AlertCircle, ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';

export function FieldError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p className="text-[11px] text-destructive flex items-center gap-1 mt-0.5" role="alert">
      <AlertCircle className="h-3 w-3 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

export function FormErrorBanner({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive flex items-start gap-2">
      <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

export function PermissionBanner({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300 flex items-start gap-2">
      <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
      <div>{children}</div>
    </div>
  );
}

export function reasonError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return 'Please provide a reason for this action.';
  if (trimmed.length < 10) return `Reason must be at least 10 characters (currently ${trimmed.length}).`;
  if (trimmed.length > 500) return 'Reason must be 500 characters or fewer.';
  return null;
}

export function parseRpcError(err: unknown): string {
  const msg = (err as { message?: string })?.message ?? String(err);
  if (/not authenticated/i.test(msg)) return 'You are not signed in. Please log in and try again.';
  if (/only .* or manager/i.test(msg) || /not authorized/i.test(msg)) {
    return 'Your current role does not have permission for this action.';
  }
  if (/at least 10 characters/i.test(msg)) return 'Reason must be at least 10 characters.';
  return msg;
}
