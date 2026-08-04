#!/usr/bin/env node
/**
 * Cursor GF Live hook bridge.
 * Usage: node gf-live-bridge.mjs <hookEventName>
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

const DEFAULT_PORT = 39217;
const DEBUG_DIR = path.join(os.homedir(), '.cursor', 'gf-live');

function readPort() {
  try {
    const p = path.join(DEBUG_DIR, 'port');
    if (fs.existsSync(p)) {
      const n = Number(String(fs.readFileSync(p, 'utf8')).trim());
      if (Number.isFinite(n) && n > 0) {
        return n;
      }
    }
  } catch {
    // ignore
  }
  return DEFAULT_PORT;
}

/** Decode hook stdin as UTF-8 (with BOM / UTF-16 heuristics). */
function decodeStdinBuffer(buf) {
  if (!buf || !buf.length) {
    return '';
  }
  // UTF-8 BOM
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.slice(3).toString('utf8');
  }
  // UTF-16 LE BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.slice(2).toString('utf16le');
  }
  // UTF-16 BE BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return buf.slice(2).swap16().toString('utf16le');
  }
  // Heuristic: lots of NUL bytes → UTF-16LE without BOM
  let nuls = 0;
  const sample = Math.min(buf.length, 64);
  for (let i = 0; i < sample; i++) {
    if (buf[i] === 0) nuls++;
  }
  if (nuls >= sample / 4) {
    return buf.toString('utf16le');
  }
  return buf.toString('utf8');
}

function readStdin() {
  return new Promise((resolve) => {
    try {
      if (!process.stdin.isTTY) {
        const buf = fs.readFileSync(0);
        if (buf && buf.length) {
          resolve(decodeStdinBuffer(buf));
          return;
        }
      }
    } catch {
      // fall through
    }

    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(decodeStdinBuffer(Buffer.concat(chunks)));
    };
    process.stdin.on('data', (c) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'));
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 2000);
  });
}

function parsePayload(raw) {
  const cleaned = String(raw || '')
    .replace(/^\uFEFF/, '')
    .trim();
  if (!cleaned) {
    return {};
  }

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        // ignore
      }
    }
    return { raw: cleaned.slice(0, 4000), parseError: true };
  }
}

function extractEventName(payload, argvEvent) {
  const candidates = [
    argvEvent,
    payload.hook_event_name,
    payload.hookEventName,
    payload.event_name,
    payload.eventName,
    payload.event,
    payload.name,
    process.env.CURSOR_HOOK_EVENT,
    process.env.HOOK_EVENT_NAME,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      return c.trim();
    }
  }
  return 'unknown';
}

function postJson(port, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/event',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': data.length,
        },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.write(data);
    req.end();
  });
}

async function main() {
  const argvEvent = process.argv.slice(2).find((a) => a && !a.startsWith('-'));
  const raw = await readStdin();
  const payload = parsePayload(raw);
  const hook_event_name = extractEventName(payload, argvEvent);
  const body = {
    ...payload,
    hook_event_name,
  };

  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const textPreview =
      typeof payload.text === 'string'
        ? payload.text.slice(0, 120)
        : undefined;
    fs.writeFileSync(
      path.join(DEBUG_DIR, 'last-hook.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          argv: process.argv.slice(2),
          hook_event_name,
          keys: Object.keys(payload),
          stdinLength: raw.length,
          parseError: Boolean(payload.parseError),
          hasText: typeof payload.text === 'string',
          textPreview,
          textIsChinese:
            typeof payload.text === 'string' &&
            /[\u4e00-\u9fff]/.test(payload.text),
        },
        null,
        2
      ),
      'utf8'
    );
    fs.writeFileSync(
      path.join(DEBUG_DIR, 'last-hook-raw.txt'),
      String(raw || '').slice(0, 8000),
      'utf8'
    );
  } catch {
    // ignore
  }

  const port = readPort();
  await postJson(port, body);
  process.stdout.write('{}\n');
  process.exit(0);
}

main().catch(() => {
  try {
    process.stdout.write('{}\n');
  } catch {
    // ignore
  }
  process.exit(0);
});
