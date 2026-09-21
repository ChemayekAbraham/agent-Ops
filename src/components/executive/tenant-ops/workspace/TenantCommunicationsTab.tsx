import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { MessageSquare, Phone, Save } from 'lucide-react';
import {
  buildEligibilityPreview,
  useSaveSupportContact,
  useTenantCommunications,
  useTenantPaymentMessageFigures,
  type SupportContact,
} from '@/hooks/useTenantCommunications';
import { useTenantTopupEligibility } from '@/hooks/useTenantTopupEligibility';

function ContactRow({ contact }: { contact: SupportContact }) {
  const save = useSaveSupportContact();
  const [label, setLabel] = useState(contact.label);
  const [phone, setPhone] = useState(contact.phone);

  const dirty = label !== contact.label || phone !== contact.phone;

  const onSave = async () => {
    try {
      await save.mutateAsync({
        id: contact.id,
        label,
        phone,
        sort_order: contact.sort_order,
        active: contact.active,
      });
      toast.success('Customer care number updated');
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not save the number');
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-3">
      <div className="min-w-[180px] flex-1">
        <Label className="text-xs text-muted-foreground">Name</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="min-w-[160px] flex-1">
        <Label className="text-xs text-muted-foreground">Number</Label>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
      </div>
      <Button size="sm" onClick={onSave} disabled={!dirty || save.isPending}>
        <Save className="mr-1 h-3.5 w-3.5" />
        Save
      </Button>
      {!contact.active && <Badge variant="outline">Not in use</Badge>}
    </div>
  );
}

function AddContact() {
  const save = useSaveSupportContact();
  const [label, setLabel] = useState('');
  const [phone, setPhone] = useState('');

  const onAdd = async () => {
    try {
      await save.mutateAsync({ id: null, label, phone, sort_order: 99, active: true });
      setLabel('');
      setPhone('');
      toast.success('Customer care number added');
    } catch (err: any) {
      toast.error(err?.message ?? 'Could not add the number');
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-dashed p-3">
      <div className="min-w-[180px] flex-1">
        <Label className="text-xs text-muted-foreground">Name</Label>
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Welile Customer Care" />
      </div>
      <div className="min-w-[160px] flex-1">
        <Label className="text-xs text-muted-foreground">Number</Label>
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+256..." />
      </div>
      <Button size="sm" variant="outline" onClick={onAdd} disabled={!label.trim() || !phone.trim() || save.isPending}>
        Add number
      </Button>
    </div>
  );
}

export default function TenantCommunicationsTab() {
  const { data, isLoading } = useTenantCommunications(50);
  const [search, setSearch] = useState('');
  const [tenantId, setTenantId] = useState<string | null>(null);

  const lookup = useTenantTopupEligibility({
    search: search.trim().length >= 3 ? search.trim() : undefined,
    limit: 8,
    offset: 0,
  });
  const figures = useTenantPaymentMessageFigures(tenantId);

  const matches = useMemo(() => (search.trim().length >= 3 ? lookup.data?.rows ?? [] : []), [
    lookup.data,
    search,
  ]);

  const previewTail = useMemo(
    () =>
      buildEligibilityPreview(
        figures.data,
        data?.support_contacts ?? [],
        data?.channels ?? [],
      ),
    [figures.data, data],
  );

  const sentCounts = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of data?.totals ?? []) {
      if (t.status !== 'sent') continue;
      out.set(t.event_key, (out.get(t.event_key) ?? 0) + Number(t.count || 0));
    }
    return out;
  }, [data]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Every successful tenant payment already triggers a confirmation message. Those messages now
        also state, in exact shillings, how much has been paid, what remains, what rent the tenant has
        qualified for and how much more to pay for the next level — plus the pay codes and care
        numbers below. One message per payment day; nothing is sent twice.
      </p>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <MessageSquare className="h-4 w-4 text-primary" />
          Live messages
        </h3>
        <div className="space-y-2">
          {(data?.templates ?? []).map((t) => (
            <div key={t.event_key} className="rounded-lg border bg-card p-3">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{t.label ?? t.event_key}</span>
                <Badge variant={t.active ? 'default' : 'outline'}>{t.active ? 'In use' : 'Off'}</Badge>
                <span className="text-xs text-muted-foreground">
                  {sentCounts.get(t.event_key) ?? 0} sent in the last 7 days
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {t.body_template}
              </p>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Preview a tenant's message</h3>
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setTenantId(null);
          }}
          placeholder="Search a tenant by name or phone"
          className="max-w-sm"
        />
        {matches.length > 0 && !tenantId && (
          <div className="mt-2 flex flex-wrap gap-2">
            {matches.map((row) => (
              <Button
                key={row.tenant_id}
                size="sm"
                variant="outline"
                onClick={() => setTenantId(row.tenant_id)}
              >
                {row.tenant_name ?? 'Unnamed'} · {row.tenant_phone ?? 'no phone'}
              </Button>
            ))}
          </div>
        )}
        {tenantId && (
          <div className="mt-3 rounded-lg border bg-muted/40 p-3 text-sm">
            {figures.isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : previewTail ? (
              <p className="whitespace-pre-wrap">{previewTail}</p>
            ) : (
              <p className="text-muted-foreground">
                This tenant has no active Rent Plan figures to quote yet.
              </p>
            )}
          </div>
        )}
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Payment codes</h3>
        <div className="flex flex-wrap gap-2">
          {(data?.channels ?? []).map((c) => (
            <Badge key={c.provider} variant="outline" className="text-sm">
              {c.provider}: {c.merchant_code}
            </Badge>
          ))}
        </div>
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Phone className="h-4 w-4 text-primary" />
          Customer care numbers in messages
        </h3>
        <div className="space-y-2">
          {(data?.support_contacts ?? []).map((c) => (
            <ContactRow key={c.id} contact={c} />
          ))}
          <AddContact />
        </div>
      </div>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Recent payment messages</h3>
        <div className="max-h-80 overflow-auto rounded-lg border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="p-2">When</th>
                <th className="p-2">Tenant</th>
                <th className="p-2">Message</th>
                <th className="p-2">Channel</th>
                <th className="p-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {(data?.recent ?? []).map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="p-2 whitespace-nowrap">
                    {new Date(r.created_at).toLocaleString()}
                  </td>
                  <td className="p-2">{r.tenant_name ?? r.tenant_id.slice(0, 8)}</td>
                  <td className="p-2">{r.event_key}</td>
                  <td className="p-2">{r.channel}</td>
                  <td className="p-2">
                    {r.status === 'sent' ? 'Sent' : r.status === 'failed' ? 'Failed' : `Skipped${r.skip_reason ? ` (${r.skip_reason})` : ''}`}
                  </td>
                </tr>
              ))}
              {(data?.recent ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="p-3 text-center text-muted-foreground">
                    No payment messages recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
