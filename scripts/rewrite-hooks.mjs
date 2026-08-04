import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const p = path.join(os.homedir(), '.cursor', 'hooks.json');
const script = path.join(os.homedir(), '.cursor', 'gf-live', 'gf-live-bridge.mjs');
const events = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'afterAgentThought',
  'afterAgentResponse',
  'preToolUse',
  'postToolUse',
  'afterFileEdit',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'subagentStart',
  'subagentStop',
  'stop',
];

let doc = { version: 1, hooks: {} };
if (fs.existsSync(p)) {
  try {
    doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    // keep empty
  }
}
doc.hooks = doc.hooks || {};

for (const k of Object.keys(doc.hooks)) {
  doc.hooks[k] = (doc.hooks[k] || []).filter(
    (e) => !(e && e.command && String(e.command).includes('gf-live-bridge'))
  );
  if (!doc.hooks[k].length) {
    delete doc.hooks[k];
  }
}

for (const ev of events) {
  doc.hooks[ev] = doc.hooks[ev] || [];
  doc.hooks[ev].push({
    command: `node "${script}" ${ev}`,
  });
}

fs.writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
console.log('rewrote', p);
console.log('sample:', doc.hooks.afterAgentResponse[0].command);
