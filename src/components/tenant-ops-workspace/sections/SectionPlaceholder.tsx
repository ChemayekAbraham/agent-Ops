import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { WORKSPACE_NAV_SECTIONS, type WorkspaceSectionId } from '../workspaceNav';

/** Shared body for every workspace section until a later prompt fills it in. */
export function SectionPlaceholder({ id }: { id: WorkspaceSectionId }) {
  const section = WORKSPACE_NAV_SECTIONS.find((s) => s.id === id);
  if (!section) return null;
  const Icon = section.icon;

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {section.label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-center">
          <Icon className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">Nothing here yet</p>
          <p className="max-w-xs text-xs text-muted-foreground">{section.description}</p>
        </div>
      </CardContent>
    </Card>
  );
}
