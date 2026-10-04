import type { ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Shared card wrapper so a slow/failed block never blocks its neighbours. */
export function BlockShell({
  title,
  isLoading,
  error,
  children,
}: {
  title: string;
  isLoading?: boolean;
  error?: unknown;
  children: ReactNode;
}) {
  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="py-4 text-center text-xs text-destructive">Could not load this block.</p>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}
