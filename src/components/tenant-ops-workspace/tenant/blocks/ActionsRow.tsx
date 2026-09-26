import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Every action deep-links to the existing Classic surface that already
 * performs it — no write path is reimplemented here. None of those existing
 * surfaces read a tenant/rent_request id from the URL today (confirmed by
 * direct investigation: TenantOpsDashboard.tsx keeps the selected tenant in
 * local state, not a search param), so these open the correct screen but
 * cannot pre-select this specific tenant there yet — wiring that would mean
 * editing an existing file beyond this build's two permitted lines.
 */
const ACTIONS = [
  { label: 'Record collection', href: '/executive-hub?tab=tenant-ops&mode=classic&view=collect-rent' },
  { label: 'Log call', href: '/executive-hub?tab=tenant-ops&mode=classic&view=calling-hub' },
  { label: 'Set promise', href: '/executive-hub?tab=tenant-ops&mode=classic&view=calling-hub' },
  { label: 'Pause', href: '/executive-hub?tab=tenant-ops&mode=classic&view=tenant-detail' },
  { label: 'Correct balance', href: '/executive-hub?tab=tenant-ops&mode=classic&view=tenant-detail' },
  { label: 'Reassign', href: '/executive-hub?tab=tenant-ops&mode=classic&view=link-agent' },
  { label: 'Escalate', href: '/executive-hub?tab=tenant-ops&mode=classic&view=calling-center' },
] as const;

export function ActionsRow() {
  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((action) => (
            <Button key={action.label} asChild variant="outline" size="sm">
              <a href={action.href} target="_blank" rel="noopener noreferrer">
                {action.label}
              </a>
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Opens the existing screen in a new tab — find or reselect this tenant there.
        </p>
      </CardContent>
    </Card>
  );
}
