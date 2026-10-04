---
name: Advance On-Demand Evaluation
description: Every agent who requests an advance gets a full potential evaluation in the Agent Ops review dialog, even if they aren't in the qualifying-agent set
type: feature
---
When Agent Ops opens an advance request (`AdvanceRequestsQueue` → `EvaluationDialog`), the agent must always have an evaluation so they can be vetted properly.

- The ranked map `useAgentPotentialMap` (RPC `get_agent_advance_potential`) only contains **qualifying agents** (`agent_ops_qualifying_agent_ids()`). Many requesters aren't qualifying yet.
- For any requester missing from the map, the dialog fetches RPC **`get_agent_advance_potential_for(_agent_id uuid)`** on demand. It mirrors `get_agent_advance_potential`'s scoring EXACTLY but for one agent and is NOT restricted to the qualifying set. Returns an extra `is_qualifying` boolean.
- Shows: houses listed, direct/active/grand sub-agents, rent collected + collections count, rent requests posted, repayment rate / likelihood, advances taken, outstanding, potential score, suggested amount and current limit — plus wallet snapshot + recent `agent_earnings`.
- A sky "Generated evaluation" banner appears when the score was built on demand (agent hasn't met full criteria).
- Keep `get_agent_advance_potential_for` scoring in sync with `get_agent_advance_potential` if the model changes.
