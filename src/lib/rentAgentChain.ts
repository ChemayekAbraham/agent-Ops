// Types and small pure helpers for the agent chain of a rent request (rent_request_agent_chain).
//
// The server decides who the registering agent, the main (parent) agent and the assigned agent are, and which phone belongs to which person. This file
// only types the answer and turns it into the labelled lines a card shows. A phone is always carried with the name it belongs to.

export const CHAIN_BATCH_LIMIT = 200;

export interface ChainPerson {
  id: string;
  name: string;
  phone: string | null;
}

export interface AgentChain {
  request_id: string;
  registering: ChainPerson | null;
  is_verified_subagent: boolean;
  parent: ChainPerson | null;
  assigned: ChainPerson | null;
  assigned_differs: boolean;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

function person(id: unknown, name: unknown, phone: unknown): ChainPerson | null {
  const i = str(id);
  if (!i) return null;
  return { id: i, name: str(name) ?? 'Unnamed agent', phone: str(phone) };
}

export function normalizeAgentChain(raw: unknown): AgentChain[] {
  return (Array.isArray(raw) ? raw : []).map((x) => {
    const r = obj(x);
    const parent = person(r.parent_agent_id, r.parent_agent_name, r.parent_agent_phone);
    return {
      request_id: String(r.request_id ?? ''),
      registering: person(r.registering_agent_id, r.registering_agent_name, r.registering_agent_phone),
      // a main agent is shown only for a verified link; the server returns the parent only then
      is_verified_subagent: r.is_verified_subagent === true && parent != null,
      parent: r.is_verified_subagent === true ? parent : null,
      assigned: person(r.assigned_agent_id, r.assigned_agent_name, r.assigned_agent_phone),
      assigned_differs: r.assigned_differs === true,
    };
  });
}

export type ChainRole = 'Sub-agent' | 'Main agent' | 'Agent' | 'Assigned agent';
export interface ChainLine { role: ChainRole; person: ChainPerson }

/**
 * The lines a card and its Details dialog show, from the server's answer:
 *  - a verified main agent exists: "Sub-agent" (the registering agent) and "Main agent" (the parent);
 *  - otherwise one "Agent" line (the registering agent);
 *  - an assigned agent who is a different person: a third line "Assigned agent".
 * With no answer (still loading, or it failed) the caller's own registering-agent fallback is shown as the single "Agent" line, with its own phone.
 */
export function agentChainLines(chain: AgentChain | null | undefined, fallback?: ChainPerson | null): ChainLine[] {
  if (!chain || !chain.registering) return fallback ? [{ role: 'Agent', person: fallback }] : [];
  const lines: ChainLine[] = chain.is_verified_subagent && chain.parent
    ? [{ role: 'Sub-agent', person: chain.registering }, { role: 'Main agent', person: chain.parent }]
    : [{ role: 'Agent', person: chain.registering }];
  if (chain.assigned_differs && chain.assigned) lines.push({ role: 'Assigned agent', person: chain.assigned });
  return lines;
}

/** Digits for a wa.me link, Uganda by default (the same rule the pipeline cards already use). */
export function whatsAppNumber(phone: string | null | undefined): string {
  if (!phone) return '';
  let clean = phone.replace(/\D/g, '');
  if (!clean) return '';
  if (clean.startsWith('0')) clean = `256${clean.slice(1)}`;
  if (!clean.startsWith('256')) clean = `256${clean}`;
  return clean;
}

export function chainIdsKey(ids: string[]): string {
  const sorted = [...new Set(ids)].sort();
  let h = 0x811c9dc5;
  for (const id of sorted) {
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${sorted.length}:${h.toString(16)}`;
}
