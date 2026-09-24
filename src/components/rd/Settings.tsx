import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { db, useCurrentUserId, useRdMe, useRdMutation, useSettings } from './useRd';
import { useProducts, VALUES, VALUE_LABEL } from './values';

const PH = 'Write what this value means for the work R&D chooses to do.';

export function Settings() {
  const { data: me } = useRdMe();
  const { data: settings } = useSettings();
  const { data: uid } = useCurrentUserId();
  const { data: products = [] } = useProducts();
  const [vals, setVals] = useState<Record<string, string>>({ hope: '', faith: '', love: '' });
  const [newName, setNewName] = useState('');

  useEffect(() => {
    if (settings) setVals({ hope: settings.value_hope ?? '', faith: settings.value_faith ?? '', love: settings.value_love ?? '' });
  }, [settings]);

  const saveVals = useRdMutation(async () => {
    const changed: Record<string, any> = {};
    VALUES.forEach((v) => { if ((settings?.[`value_${v}`] ?? '') !== vals[v]) changed[`value_${v}`] = vals[v]; });
    if (!Object.keys(changed).length) return null;
    return db.from('rd_settings').update({ ...changed, updated_by: uid }).eq('id', settings?.id);
  }, 'Values saved');
  const addProduct = useRdMutation(async (name: string) => db.from('rd_products').insert({ name }), 'Product added');
  const toggle = useRdMutation(async (a: { id: string; active: boolean }) =>
    db.from('rd_products').update({ active: a.active }).eq('id', a.id), 'Product updated');

  if (!me?.is_lead) return <p className="text-sm text-muted-foreground">Settings are available to the R&amp;D lead only.</p>;

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Company values</h2>
        {VALUES.map((v) => (
          <div key={v}>
            <Label>{VALUE_LABEL[v]}</Label>
            <Textarea rows={2} maxLength={300} placeholder={PH} value={vals[v]} onChange={(e) => setVals({ ...vals, [v]: e.target.value })} />
            <p className="mt-1 text-right text-[11px] text-muted-foreground">{vals[v].length}/300</p>
          </div>
        ))}
        <Button size="sm" disabled={saveVals.isPending} onClick={() => saveVals.mutate(undefined)}>Save values</Button>
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Products</h2>
        <div className="flex gap-2">
          <Input maxLength={60} placeholder="Product name" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Button size="sm" disabled={!newName.trim() || addProduct.isPending}
            onClick={() => addProduct.mutate(newName.trim(), { onSuccess: () => setNewName('') })}>Add</Button>
        </div>
        {products.length === 0 ? (
          <p className="text-sm text-muted-foreground">No products yet. Add the first product R&amp;D missions serve.</p>
        ) : products.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-2 border-b border-border py-2 last:border-0">
            <span className="text-sm">{p.name}</span>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{p.active ? 'Active' : 'Inactive'}</span>
              <Switch checked={p.active} disabled={toggle.isPending} onCheckedChange={(c) => toggle.mutate({ id: p.id, active: c })} />
            </div>
          </div>
        ))}
      </Card>
    </div>
  );
}
