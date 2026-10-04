// PostToolUse hook: when a docs/HANDOVER file (other than the map itself) is
// written, remind Claude that architecture-map.html must be updated too.
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let file = '';
  try {
    const input = JSON.parse(raw);
    file = input.tool_input?.file_path || input.tool_response?.filePath || '';
  } catch {
    return;
  }
  const norm = file.replace(/\\/g, '/');
  if (!/\/docs\/HANDOVER\//i.test(norm) || /architecture-map\.html$/i.test(norm)) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        'Standing rule: a docs/HANDOVER change must also update docs/HANDOVER/architecture-map.html ' +
        '(HANDOVER_CHAPTERS / NODE_DATA / SVG labels) in the same commit. Verify any figure against prod ' +
        'first. If this change genuinely affects nothing on the map, say so explicitly.',
    },
  }));
});
