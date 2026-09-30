# Architecture Decisions

- Requisition approval errors are normalized only in the client; server authorization remains the sole permission authority.
- Four-part repayment validation reconciles Returns + Agent Commission + Platform Fee to Access Fee + Registration Fee, because those two stored fee components form the approved Platform Fee pool.
- CFO 7-day reporting labels and day buckets use Kampala (EAT, UTC+3) calendar days through `src/lib/kampalaDays.ts`, because the reporting RPCs (`get_cfo_seven_day_lines`, `get_*_predictive_forecast`) anchor "today" to Africa/Kampala; browser-local dates shifted the cards by a day.
- Agent Ops opens on 14 business-area entry panels, while all legacy views remain reachable through the collapsible desktop sections menu or mobile sections menu, so reorganizing the landing view never removes management data.
