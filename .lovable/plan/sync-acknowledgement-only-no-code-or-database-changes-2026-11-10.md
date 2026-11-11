Sync acknowledgement only. No code or database changes.

- Local copy is at 2edb782386 with all four commits present, including the new passBlock.ts, callOnFile.ts and AwaitingRelease.tsx files.
- Future desk edits keep these rules: desks never write rent requests directly, Transfer runs ops_transfer_pipeline_request_agent and then pipeline_record_review 'pass', an answered call already on file turns Pass on, and server errors show as they are.
- The listed desk files and the dev-only /__e2e/desk-review route will not be reverted.
