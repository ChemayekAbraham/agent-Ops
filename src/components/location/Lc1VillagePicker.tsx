/**
 * Dataset-backed LC1 village capture.
 *
 * Thin wrapper over the shared `UgLocationPicker` for the many forms that only
 * store the LC1 village NAME as a string. The selection itself always resolves
 * to an official `ug_villages` row, so the stored name is canonical and the
 * full administrative chain is available to callers that want it.
 */
import { useState } from 'react';
import { UgLocationPicker } from '@/components/location/UgLocationPicker';
import type { UgLocationSelection } from '@/hooks/useUgLocations';

interface Props {
  /** Current stored village name (may be a legacy free-typed value). */
  value: string;
  onChange: (villageName: string, selection: UgLocationSelection | null) => void;
  label?: string;
  required?: boolean;
  error?: string | null;
  className?: string;
  /** Limit village search to this district when the form already knows it. */
  districtName?: string | null;
}

export function Lc1VillagePicker({
  value, onChange, label = 'Village / Zone', required, error, className, districtName,
}: Props) {
  const [selection, setSelection] = useState<UgLocationSelection | null>(null);

  return (
    <div className={className}>
      <UgLocationPicker
        label={label}
        required={required}
        error={error}
        districtName={districtName}
        value={selection}
        onChange={(sel) => {
          setSelection(sel);
          onChange(sel?.village ?? '', sel);
        }}
      />
      {!selection && value.trim() && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Saved earlier: <span className="font-medium">{value}</span> — pick the official village to confirm it.
        </p>
      )}
    </div>
  );
}

export default Lc1VillagePicker;
