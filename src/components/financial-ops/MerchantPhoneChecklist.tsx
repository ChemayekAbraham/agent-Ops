import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Smartphone, Wifi, BatteryCharging, MessageSquare, PlayCircle, RotateCcw, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';

const STORAGE_KEY = 'welile-merchant-phone-checklist';

type Item = { id: string; group: string; label: string; detail: string };

const GROUPS = [
  { name: 'Network', icon: Wifi },
  { name: 'Battery optimization', icon: BatteryCharging },
  { name: 'SMS permissions', icon: MessageSquare },
] as const;

const ITEMS: Item[] = [
  {
    id: 'net-online',
    group: 'Network',
    label: 'Phone is online (mobile data or Wi-Fi)',
    detail: 'Open a browser and load any page. If it fails, data bundle or Wi-Fi is down.',
  },
  {
    id: 'net-data-saver',
    group: 'Network',
    label: 'Data Saver is OFF for IFTTT and Gmail',
    detail: 'Settings → Network → Data Saver → Unrestricted data for IFTTT and Gmail.',
  },
  {
    id: 'net-bg-data',
    group: 'Network',
    label: 'Background data allowed for IFTTT and Gmail',
    detail: 'Settings → Apps → IFTTT → Mobile data → enable Background data + Unrestricted.',
  },
  {
    id: 'net-airplane',
    group: 'Network',
    label: 'Airplane mode is off and SIM has signal',
    detail: 'The SIM receiving MoMo SMS must show bars — no signal means no receipts at all.',
  },
  {
    id: 'bat-unrestricted',
    group: 'Battery optimization',
    label: 'IFTTT set to Unrestricted battery usage',
    detail: 'Settings → Apps → IFTTT → Battery → Unrestricted (not Optimised / Restricted).',
  },
  {
    id: 'bat-gmail',
    group: 'Battery optimization',
    label: 'Gmail set to Unrestricted battery usage',
    detail: 'Settings → Apps → Gmail → Battery → Unrestricted, and Gmail sync is ON.',
  },
  {
    id: 'bat-autostart',
    group: 'Battery optimization',
    label: 'Auto-start / autolaunch enabled for IFTTT',
    detail: 'On Xiaomi / Oppo / Tecno / Infinix: Security → Autostart → enable IFTTT.',
  },
  {
    id: 'bat-powersave',
    group: 'Battery optimization',
    label: 'Power saving / adaptive battery OFF',
    detail: 'Power saving mode kills background SMS triggers after a few hours of idle.',
  },
  {
    id: 'bat-charger',
    group: 'Battery optimization',
    label: 'Phone is on a charger and above 30% battery',
    detail: 'Keep the merchant phone permanently plugged in at the office.',
  },
  {
    id: 'sms-permission',
    group: 'SMS permissions',
    label: 'IFTTT has SMS permission granted',
    detail: 'Settings → Apps → IFTTT → Permissions → SMS → Allow.',
  },
  {
    id: 'sms-applet',
    group: 'SMS permissions',
    label: 'The "SMS → Gmail" applet is connected and ON',
    detail: 'Open IFTTT → My Applets → confirm the applet toggle is on with no red warning.',
  },
  {
    id: 'sms-inbox',
    group: 'SMS permissions',
    label: 'MoMo SMS still land in the default Messages app',
    detail: 'A third-party SMS app or spam filter can hide MTN/Airtel receipts from IFTTT.',
  },
  {
    id: 'sms-storage',
    group: 'SMS permissions',
    label: 'Inbox is not full and phone storage is available',
    detail: 'Delete old SMS. A full inbox silently drops new messages on some handsets.',
  },
];

const RESYNC_STEPS = [
  'Confirm the merchant phone is unlocked, charged and online.',
  'Open IFTTT → My Applets → open the "SMS → Gmail" applet.',
  'Toggle the applet OFF, wait 10 seconds, then toggle it back ON.',
  'If prompted, re-grant the SMS permission and re-sign in to the Gmail account.',
  'Force-stop IFTTT (Settings → Apps → IFTTT → Force stop), then reopen it once.',
  'Send a test SMS to the merchant SIM containing the word "received" and an amount, e.g. "TEST123 You have received UGX 100 from RESYNC TEST".',
  'Wait up to 2 minutes, then refresh the IFTTT diagnostics panel on this dashboard.',
  'A new row should appear in the recent forwarded actions list. If it does not, the forwarder is still down — escalate using the MoMo feed runbook.',
];

/**
 * Guided merchant-phone health checklist for the SMS → Gmail forwarder,
 * plus an on-demand "resync test" instruction sheet FinOps can run through
 * with whoever is holding the phone.
 */
export function MerchantPhoneChecklist() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [resyncOpen, setResyncOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setChecked(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const persist = useCallback((next: Record<string, boolean>) => {
    setChecked(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }, []);

  const doneCount = ITEMS.filter((i) => checked[i.id]).length;
  const allDone = doneCount === ITEMS.length;

  const copySteps = async () => {
    const text = [
      'Welile — merchant phone resync test',
      '',
      ...RESYNC_STEPS.map((s, i) => `${i + 1}. ${s}`),
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success('Resync instructions copied');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy — select the steps manually');
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" />
            Merchant phone checklist
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={allDone ? 'default' : 'secondary'} className="text-[10px]">
              {doneCount}/{ITEMS.length} checked
            </Badge>
            <Button size="sm" className="h-7 text-xs" onClick={() => setResyncOpen(true)}>
              <PlayCircle className="h-3.5 w-3.5 mr-1.5" />
              Resync test
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => persist({})}
              disabled={doneCount === 0}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Work through this with whoever is holding the merchant phone when the MoMo feed goes
          silent.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {GROUPS.map(({ name, icon: Icon }) => (
          <div key={name} className="space-y-2">
            <p className="text-xs font-semibold flex items-center gap-1.5">
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              {name}
            </p>
            <div className="space-y-2 pl-1">
              {ITEMS.filter((i) => i.group === name).map((item) => (
                <label
                  key={item.id}
                  htmlFor={item.id}
                  className="flex items-start gap-2.5 rounded-lg border border-border p-2.5 cursor-pointer hover:bg-muted/40 transition-colors"
                >
                  <Checkbox
                    id={item.id}
                    checked={!!checked[item.id]}
                    onCheckedChange={(v) => persist({ ...checked, [item.id]: v === true })}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span
                      className={`block text-xs font-medium ${
                        checked[item.id] ? 'line-through text-muted-foreground' : ''
                      }`}
                    >
                      {item.label}
                    </span>
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      {item.detail}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </CardContent>

      <Dialog open={resyncOpen} onOpenChange={setResyncOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Resync test instructions</DialogTitle>
            <DialogDescription>
              Read these out to the phone holder, then watch the IFTTT diagnostics panel for a new
              forwarded row.
            </DialogDescription>
          </DialogHeader>
          <ol className="space-y-2 list-decimal pl-5">
            {RESYNC_STEPS.map((s, i) => (
              <li key={i} className="text-sm text-muted-foreground">
                {s}
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2 pt-2">
            <Button size="sm" variant="outline" className="text-xs" onClick={copySteps}>
              {copied ? (
                <Check className="h-3.5 w-3.5 mr-1.5" />
              ) : (
                <Copy className="h-3.5 w-3.5 mr-1.5" />
              )}
              Copy steps
            </Button>
            <Button asChild size="sm" variant="ghost" className="text-xs">
              <a href="/MOMO_FEED_RUNBOOK.md" target="_blank" rel="noopener noreferrer">
                Open runbook
              </a>
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}