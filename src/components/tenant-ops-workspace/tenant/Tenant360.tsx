/**
 * Tenant360 — one screen per tenant, opened from any list in the Tenant Ops
 * Workspace tab. Every block fetches independently (its own React Query
 * hook), so a slow or failing block never blocks the position card or any
 * other block from rendering.
 */
import PositionCard from './PositionCard';
import ScheduleLedger from './ScheduleLedger';
import { TenantBriefBlock } from './blocks/TenantBriefBlock';
import { TenantHeaderBlock } from './blocks/TenantHeaderBlock';
import { MoneyPipelineBlock } from './blocks/MoneyPipelineBlock';
import { PlaceBlock } from './blocks/PlaceBlock';
import { AgentBlock } from './blocks/AgentBlock';
import { ContactHistoryBlock } from './blocks/ContactHistoryBlock';
import { RentAccessLimitBlock } from './blocks/RentAccessLimitBlock';
import { RiskBlock } from './blocks/RiskBlock';
import { ActionsRow } from './blocks/ActionsRow';

export interface Tenant360Props {
  rentRequestId: string;
}

export default function Tenant360({ rentRequestId }: Tenant360Props) {
  return (
    <div className="space-y-4">
      <TenantBriefBlock rentRequestId={rentRequestId} />
      <TenantHeaderBlock rentRequestId={rentRequestId} />
      <PositionCard rentRequestId={rentRequestId} />
      <ScheduleLedger rentRequestId={rentRequestId} />
      <MoneyPipelineBlock rentRequestId={rentRequestId} />
      <PlaceBlock rentRequestId={rentRequestId} />
      <AgentBlock rentRequestId={rentRequestId} />
      <ContactHistoryBlock />
      <RentAccessLimitBlock rentRequestId={rentRequestId} />
      <RiskBlock rentRequestId={rentRequestId} />
      <ActionsRow rentRequestId={rentRequestId} />
    </div>
  );
}
