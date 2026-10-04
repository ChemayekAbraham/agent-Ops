import { useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Search, Loader2, UserPlus, Building2, Users, Smartphone, SmartphoneNfc, Phone, Check } from 'lucide-react';

type PersonType = 'landlord' | 'agent';

interface Props {
  open: boolean;
  onClose: () => void;
  listingId: string;
  listingTitle: string;
  personType: PersonType;
  onSaved: () => void;
}

interface SearchResult {
  id: string;
  name: string;
  phone: string;
  has_smartphone?: boolean | null;
}

export function AssignPersonDialog({ open, onClose, listingId, listingTitle, personType, onSaved }: Props) {
  const { user } = useAuth();
  const [mode, setMode] = useState<'search' | 'create'>('search');
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [saving, setSaving] = useState(false);
  const [auditReason, setAuditReason] = useState('');

  // Create new landlord fields
  const [newName, setNewName] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [newHasSmartphone, setNewHasSmartphone] = useState(false);

  const resetState = () => {
    setMode('search');
    setQuery('');
    setResults([]);
    setAuditReason('');
    setNewName('');
    setNewPhone('');
    setNewHasSmartphone(false);
  };

  const handleSearch = async () => {
    if (!query.trim() || query.trim().length < 2) return;
    setSearching(true);
    try {
      if (personType === 'landlord') {
        // Route through the trigram-indexed RPC — plain OR-ILIKE forces a
        // seq scan on landlords and was the #1 DB CPU offender.
        const { data } = await supabase.rpc('search_landlords_fuzzy', {
          p_query: query.trim(),
          p_limit: 10,
          p_threshold: 0.15,
        });
        // has_smartphone isn't returned by the RPC; hydrate it in one small lookup only for the matched IDs.
        const ids = (data || []).map((d: any) => d.id);
        let smartMap = new Map<string, boolean | null>();
        if (ids.length) {
          const { data: extras } = await supabase
            .from('landlords')
            .select('id, has_smartphone')
            .in('id', ids);
          smartMap = new Map((extras || []).map((e: any) => [e.id, e.has_smartphone]));
        }
        setResults(
          (data || []).map((d: any) => ({
            id: d.id,
            name: d.name,
            phone: d.phone,
            has_smartphone: smartMap.get(d.id) ?? null,
          })),
        );
      } else {
        const { data } = await supabase.from('profiles')
          .select('id, full_name, phone')
          .or(`full_name.ilike.%${query.trim()}%,phone.ilike.%${query.trim()}%`)
          .limit(10);
        setResults((data || []).map(d => ({ id: d.id, name: d.full_name || 'Unknown', phone: d.phone || '' })));
      }
    } catch {
      toast.error('Search failed');
    } finally {
      setSearching(false);
    }
  };

  const handleAssign = async (person: SearchResult) => {
    if (!user || auditReason.trim().length < 10) {
      toast.error('Please provide an audit reason (min 10 characters)');
      return;
    }
    setSaving(true);
    try {
      const updateField = personType === 'landlord' ? 'landlord_id' : 'agent_id';
      const { error } = await supabase.from('house_listings')
        .update({ [updateField]: person.id })
        .eq('id', listingId);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: `${personType}_assigned_to_listing`,
        table_name: 'house_listings',
        record_id: listingId,
        metadata: {
          [`${personType}_id`]: person.id,
          [`${personType}_name`]: person.name,
          listing_title: listingTitle,
          reason: auditReason.trim(),
          editor_role: 'landlord_ops',
        },
      });

      toast.success(`${personType === 'landlord' ? 'Landlord' : 'Agent'} assigned successfully`);
      onSaved();
      onClose();
      resetState();
    } catch (err: any) {
      toast.error(err.message || 'Failed to assign');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAndAssign = async () => {
    if (!user) return;
    if (!newName.trim() || !newPhone.trim()) {
      toast.error('Name and phone are required');
      return;
    }
    if (auditReason.trim().length < 10) {
      toast.error('Please provide an audit reason (min 10 characters)');
      return;
    }
    if (personType !== 'landlord') {
      toast.error('Only new landlords can be created from here');
      return;
    }
    setSaving(true);
    try {
      const { data: newLandlord, error: createError } = await supabase.from('landlords')
        .insert({
          name: newName.trim(),
          phone: newPhone.trim(),
          property_address: 'Pending',
          has_smartphone: newHasSmartphone,
          registered_by: user.id,
        })
        .select('id, name, phone')
        .single();
      if (createError) throw createError;

      const { error: linkError } = await supabase.from('house_listings')
        .update({ landlord_id: newLandlord.id, landlord_has_smartphone: newHasSmartphone })
        .eq('id', listingId);
      if (linkError) throw linkError;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'landlord_created_and_assigned',
        table_name: 'house_listings',
        record_id: listingId,
        metadata: {
          landlord_id: newLandlord.id,
          landlord_name: newLandlord.name,
          has_smartphone: newHasSmartphone,
          listing_title: listingTitle,
          reason: auditReason.trim(),
          editor_role: 'landlord_ops',
        },
      });

      toast.success('Landlord created and assigned!');
      onSaved();
      onClose();
      resetState();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create landlord');
    } finally {
      setSaving(false);
    }
  };

  const icon = personType === 'landlord' ? Building2 : Users;
  const Icon = icon;
  const label = personType === 'landlord' ? 'Landlord' : 'Agent';

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); resetState(); } }}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Icon className="h-4 w-4 text-primary" />
            Assign {label} to Listing
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground truncate">📍 {listingTitle}</p>

        {/* Mode Tabs */}
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          <button
            onClick={() => setMode('search')}
            className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-colors ${mode === 'search' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
          >
            <Search className="h-3 w-3 inline mr-1" />Search Existing
          </button>
          {personType === 'landlord' && (
            <button
              onClick={() => setMode('create')}
              className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-colors ${mode === 'create' ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
            >
              <UserPlus className="h-3 w-3 inline mr-1" />Register New
            </button>
          )}
        </div>

        {mode === 'search' && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder={`Search ${label.toLowerCase()} by name or phone...`}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                className="flex-1"
              />
              <Button size="sm" onClick={handleSearch} disabled={searching || query.trim().length < 2}>
                {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
              </Button>
            </div>

            {results.length > 0 && (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {results.map(r => (
                  <div key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-border p-2">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{r.name}</p>
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Phone className="h-2.5 w-2.5" />{r.phone}
                        {r.has_smartphone != null && (
                          <span className="ml-1">
                            {r.has_smartphone
                              ? <SmartphoneNfc className="h-3 w-3 text-green-600 inline" />
                              : <Smartphone className="h-3 w-3 text-orange-500 inline" />}
                          </span>
                        )}
                      </p>
                    </div>
                    <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => handleAssign(r)} disabled={saving || auditReason.trim().length < 10}>
                      <Check className="h-3 w-3 mr-1" />Assign
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {results.length === 0 && query.trim().length >= 2 && !searching && (
              <p className="text-xs text-muted-foreground text-center py-4">No results found. {personType === 'landlord' && 'Try "Register New" tab.'}</p>
            )}
          </div>
        )}

        {mode === 'create' && personType === 'landlord' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Name *</Label>
                <Input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Landlord name" />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone *</Label>
                <Input value={newPhone} onChange={e => setNewPhone(e.target.value)} placeholder="07XXXXXXXX" />
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2">
              <Switch checked={newHasSmartphone} onCheckedChange={setNewHasSmartphone} />
              <Label className="text-xs flex items-center gap-1.5">
                {newHasSmartphone
                  ? <><SmartphoneNfc className="h-3.5 w-3.5 text-green-600" /> Has Smartphone</>
                  : <><Smartphone className="h-3.5 w-3.5 text-orange-500" /> No Smartphone</>}
              </Label>
            </div>
          </div>
        )}

        {/* Audit Reason — always required */}
        <div className="space-y-1">
          <Label className="text-xs font-semibold">Audit Reason *</Label>
          <Textarea
            value={auditReason}
            onChange={e => setAuditReason(e.target.value)}
            placeholder="Why are you assigning this person? (min 10 chars)"
            className="min-h-[60px] text-xs"
          />
          {auditReason.trim().length > 0 && auditReason.trim().length < 10 && (
            <p className="text-[10px] text-destructive">{10 - auditReason.trim().length} more characters needed</p>
          )}
        </div>

        {mode === 'create' && personType === 'landlord' && (
          <Button onClick={handleCreateAndAssign} disabled={saving || !newName.trim() || !newPhone.trim() || auditReason.trim().length < 10} className="w-full">
            {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <UserPlus className="h-4 w-4 mr-2" />}
            Register & Assign Landlord
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
