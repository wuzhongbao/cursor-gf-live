/**
 * Smoke test: start EventServer + StateMachine, POST fake hook events.
 * Run: node scripts/smoke-test.mjs
 */
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const { EventServer } = require(path.join(root, 'out', 'eventServer.js'));
const { StateMachine } = require(path.join(root, 'out', 'stateMachine.js'));

const machine = new StateMachine({
  pack: 'dark-cyber',
  port: 39218,
  idleTimeoutMs: 30000,
  doneHoldMs: 500,
});

const seen = [];
machine.subscribe((s) => seen.push(s.state));

const server = new EventServer(39218, (eventName, payload) => {
  machine.ingestHookEvent(eventName, payload);
});

await server.start();

async function post(event) {
  const body = JSON.stringify({ hook_event_name: event });
  await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 39218,
        path: '/event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

await post('beforeSubmitPrompt');
await post('preToolUse');
await post('afterAgentResponse');
await post('stop');
await new Promise((r) => setTimeout(r, 700));

await server.stop();
machine.dispose();

const expectedFlow = ['idle', 'listening', 'working', 'speaking', 'done', 'idle'];
const ok = expectedFlow.every((s, i) => seen[i] === s);
console.log('states:', seen.join(' -> '));
if (!ok) {
  console.error('FAIL expected', expectedFlow.join(' -> '));
  process.exit(1);
}
console.log('PASS');
