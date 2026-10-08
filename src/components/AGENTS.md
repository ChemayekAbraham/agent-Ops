# Component decisions

- Agent Ops opens on 14 business-area entry panels, while all legacy views remain reachable through the collapsible desktop sections menu or mobile sections menu, so reorganizing the landing view never removes management data.
- CFO bulk rent payments use a local selection-only review screen and revalidate every selected request before the existing payment function is called, so opening bulk review can never move money or change workflow state.

- Agent elite ranks (top 4: diamond/platinum/gold/silver) live only in `agent_elite_ranks`, fully rebuilt nightly by `refresh_agent_elite_ranks()`, so an agent who drops out reverts to normal on the next refresh; the Service Centre skip for rank 1 is checked in `route_rent_request_service_center`.
- Bike lease CFO release (`cfo_disburse_bike_lease`) credits the supplier assigned via `assign_bike_lease_supplier` (`merchandise_sales.supplier_id`), never the leasing agent, and refuses without one; the agent stays leaseholder on the recovery plan, so the agent can't be withdrawn by the agent or lock their commission.
