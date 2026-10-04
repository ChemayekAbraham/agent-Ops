import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Bike,
  Loader2,
  Hash,
  MapPin,
  Battery,
  FileText,
  Save,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import {
  updateBikeLeaseAsset,
  LOGBOOK_STATUS_LABEL,
  type BikeLeaseRecord,
} from '@/hooks/useBikeLeases';

interface Props {
  lease: BikeLeaseRecord | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess?: () => void;
}

const LOGBOOK_OPTIONS = Object.entries(LOGBOOK_STATUS_LABEL) as [string, string][];

/**
 * Dialog for Agent Ops / staff to record a bike's physical asset details
 * after handover: plate number, chassis number, battery serial, GPS tracker
 * ID, and logbook custody status. All edits go through the audited
 * `update_bike_lease_asset` RPC.
 */
export function BikeAssetDetailsDialog({ lease, open, onOpenChange, onSuccess }: Props) {
  const queryClient = useQueryClient();

  const [plateNumber, setPlateNumber] = useState('');
  const [chassisNumber, setChassisNumber] = useState('');
  const [batterySerial, setBatterySerial] = useState('');
  const [gpsTrackerId, setGpsTrackerId] = useState('');
  const [logbookStatus, setLogbookStatus] = useState('');

  // Sync local state when a new lease is opened
  const [lastLeaseId, setLastLeaseId] = useState<string | null>(null);
  if (lease && lease.lease_id !== lastLeaseId) {
    setLastLeaseId(lease.lease_id);
    setPlateNumber(lease.plate_number || '');
    setChassisNumber(lease.chassis_number || '');
    setBatterySerial(lease.battery_serial || '');
    setGpsTrackerId(lease.gps_tracker_id || '');
    setLogbookStatus(lease.logbook_status || 'held_by_welile');
  }

  const hasChanges =
    (plateNumber.trim() !== (lease?.plate_number || '')) ||
    (chassisNumber.trim() !== (lease?.chassis_number || '')) ||
    (batterySerial.trim() !== (lease?.battery_serial || '')) ||
    (gpsTrackerId.trim() !== (lease?.gps_tracker_id || '')) ||
    (logbookStatus !== (lease?.logbook_status || 'held_by_welile'));

  const save = useMutation({
    mutationFn: async () => {
      if (!lease) throw new Error('No lease selected');
      const details: Record<string, string> = {};
      if (plateNumber.trim()) details.plate_number = plateNumber.trim();
      if (chassisNumber.trim()) details.chassis_number = chassisNumber.trim();
      if (batterySerial.trim()) details.battery_serial = batterySerial.trim();
      if (gpsTrackerId.trim()) details.gps_tracker_id = gpsTrackerId.trim();
      if (logbookStatus) details.logbook_status = logbookStatus;
      return updateBikeLeaseAsset(lease.lease_id, details);
    },
    onSuccess: () => {
      toast.success('Bike asset details saved and audit-logged.');
      queryClient.invalidateQueries({ queryKey: ['bike-lease-queue'] });
      queryClient.invalidateQueries({ queryKey: ['my-bike-lease-orders'] });
      onOpenChange(false);
      onSuccess?.();
    },
    onError: (e: any) => toast.error(e.message || 'Could not save asset details'),
  });

  if (!lease) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] sm:w-full sm:max-w-md max-h-[90dvh] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Bike className="h-4 w-4 text-primary" /> Bike Asset Details
          </DialogTitle>
          <DialogDescription className="text-xs">
            Record or update the physical asset identifiers for{' '}
            <span className="font-semibold text-foreground">{lease.client_name || 'this agent'}</span>'s{' '}
            <span className="font-semibold text-foreground">{lease.model_type || 'Spiro bike'}</span>.
            All changes are audit-logged with old and new values.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3.5">
          {/* Current status badge */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground font-medium">Current logbook:</span>
            <Badge variant="outline" className="text-[10px] font-semibold px-2 py-0.5 bg-indigo-500/15 text-indigo-600 border-indigo-500/30">
              {LOGBOOK_STATUS_LABEL[lease.logbook_status] || lease.logbook_status}
            </Badge>
          </div>

          {/* Plate Number */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <Hash className="h-3 w-3 text-muted-foreground" /> Plate Number
            </Label>
            <Input
              placeholder="e.g. UBJ 123A"
              value={plateNumber}
              onChange={(e) => setPlateNumber(e.target.value.toUpperCase())}
              className="h-9 text-sm font-mono"
            />
          </div>

          {/* Chassis Number */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <FileText className="h-3 w-3 text-muted-foreground" /> Chassis Number
            </Label>
            <Input
              placeholder="e.g. LAEPCJ1A1PB012345"
              value={chassisNumber}
              onChange={(e) => setChassisNumber(e.target.value.toUpperCase())}
              className="h-9 text-sm font-mono"
            />
          </div>

          {/* Battery Serial */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <Battery className="h-3 w-3 text-muted-foreground" /> Battery Serial
            </Label>
            <Input
              placeholder="e.g. BAT-2026-00123"
              value={batterySerial}
              onChange={(e) => setBatterySerial(e.target.value.toUpperCase())}
              className="h-9 text-sm font-mono"
            />
            <p className="text-[10px] text-muted-foreground">
              Primary battery identifier. Record both serials here separated by a comma if dual-battery.
            </p>
          </div>

          {/* GPS Tracker ID */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <MapPin className="h-3 w-3 text-muted-foreground" /> GPS Tracker ID
            </Label>
            <Input
              placeholder="e.g. GPS-SP-00456"
              value={gpsTrackerId}
              onChange={(e) => setGpsTrackerId(e.target.value.toUpperCase())}
              className="h-9 text-sm font-mono"
            />
          </div>

          {/* Logbook Custody Status */}
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1.5">
              <FileText className="h-3 w-3 text-muted-foreground" /> Logbook Custody Status
            </Label>
            <Select value={logbookStatus} onValueChange={setLogbookStatus}>
              <SelectTrigger className="h-9 text-sm">
                <SelectValue placeholder="Select custody status" />
              </SelectTrigger>
              <SelectContent>
                {LOGBOOK_OPTIONS.map(([value, label]) => (
                  <SelectItem key={value} value={value} className="text-sm">
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter className="gap-2 pt-2">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || !hasChanges}
          >
            {save.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
            ) : (
              <Save className="h-4 w-4 mr-1.5" />
            )}
            {save.isPending ? 'Saving…' : 'Save Asset Details'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
