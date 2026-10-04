import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Calls, messages and promises are wired in a later prompt — this block is a placeholder until then. */
export function ContactHistoryBlock() {
  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Contact history</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="py-4 text-center text-xs text-muted-foreground">
          Calls, messages and promises will appear here in a later prompt.
        </p>
      </CardContent>
    </Card>
  );
}
