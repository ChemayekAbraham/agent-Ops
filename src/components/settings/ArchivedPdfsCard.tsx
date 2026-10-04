import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Archive } from 'lucide-react';
import { ArchivedPdfsDrawer } from '@/components/financial-ops/ArchivedPdfsDrawer';

/**
 * Settings tile that opens the global offline PDF vault from anywhere
 * in the app — every receipt, report, statement, or audit PDF you've
 * ever generated on this device, kept on-device so you never lose a
 * record (works fully offline).
 */
export function ArchivedPdfsCard() {
  return (
    <Card className="border-border/40 rounded-2xl">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Archive className="h-4 w-4 text-primary" />
          <div className="min-w-0">
            <CardTitle className="text-sm">Offline PDF Vault</CardTitle>
            <CardDescription className="text-xs">
              Every receipt & report you've generated on this device — keep them safe even offline.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <ArchivedPdfsDrawer />
      </CardContent>
    </Card>
  );
}