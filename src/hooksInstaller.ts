import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const GF_LIVE_HOOK_MARKER = 'cursor-gf-live';

const HOOK_EVENTS = [
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
] as const;

function hooksJsonPath(): string {
  return path.join(os.homedir(), '.cursor', 'hooks.json');
}

function bridgeDir(): string {
  return path.join(os.homedir(), '.cursor', 'gf-live');
}

function bridgeScriptPath(): string {
  return path.join(bridgeDir(), 'gf-live-bridge.mjs');
}

function portFilePath(): string {
  return path.join(bridgeDir(), 'port');
}

export function writeBridgePort(port: number): void {
  const dir = bridgeDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(portFilePath(), String(port), 'utf8');
}

export function isHooksInstalled(): boolean {
  const p = hooksJsonPath();
  if (!fs.existsSync(p)) {
    return false;
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw.includes('gf-live-bridge') || raw.includes(GF_LIVE_HOOK_MARKER);
  } catch {
    return false;
  }
}

export async function installHooks(
  extensionPath: string,
  port: number
): Promise<void> {
  const dir = bridgeDir();
  fs.mkdirSync(dir, { recursive: true });

  const bundledBridge = path.join(extensionPath, 'bridge', 'gf-live-bridge.mjs');
  if (!fs.existsSync(bundledBridge)) {
    throw new Error(`Bridge script missing: ${bundledBridge}`);
  }
  fs.copyFileSync(bundledBridge, bridgeScriptPath());
  writeBridgePort(port);

  const cursorDir = path.join(os.homedir(), '.cursor');
  fs.mkdirSync(cursorDir, { recursive: true });

  const hooksPath = hooksJsonPath();
  let doc: { version: number; hooks: Record<string, unknown[]> } = {
    version: 1,
    hooks: {},
  };

  if (fs.existsSync(hooksPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
        version?: number;
        hooks?: Record<string, unknown[]>;
      };
      doc = {
        version: existing.version ?? 1,
        hooks: existing.hooks ?? {},
      };
    } catch {
      // backup corrupt file
      fs.copyFileSync(hooksPath, `${hooksPath}.bak-gf-live`);
    }
  }

  // Remove previous gf-live entries first
  stripGfLiveEntries(doc.hooks);

  for (const event of HOOK_EVENTS) {
    const list = Array.isArray(doc.hooks[event]) ? doc.hooks[event] : [];
    // Pass event name as argv so we never depend on stdin field names.
    list.push({
      command: buildBridgeCommand(bridgeScriptPath(), event),
    });
    doc.hooks[event] = list;
  }

  fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

export async function uninstallHooks(): Promise<void> {
  const hooksPath = hooksJsonPath();
  if (!fs.existsSync(hooksPath)) {
    return;
  }

  let doc: { version: number; hooks: Record<string, unknown[]> };
  try {
    doc = JSON.parse(fs.readFileSync(hooksPath, 'utf8')) as {
      version: number;
      hooks: Record<string, unknown[]>;
    };
  } catch {
    return;
  }

  if (!doc.hooks) {
    return;
  }

  stripGfLiveEntries(doc.hooks);

  // Drop empty arrays
  for (const key of Object.keys(doc.hooks)) {
    if (Array.isArray(doc.hooks[key]) && doc.hooks[key].length === 0) {
      delete doc.hooks[key];
    }
  }

  fs.writeFileSync(hooksPath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

function stripGfLiveEntries(hooks: Record<string, unknown[]>): void {
  for (const key of Object.keys(hooks)) {
    const list = hooks[key];
    if (!Array.isArray(list)) {
      continue;
    }
    hooks[key] = list.filter((entry) => {
      if (!entry || typeof entry !== 'object') {
        return true;
      }
      const obj = entry as Record<string, unknown>;
      if (obj[GF_LIVE_HOOK_MARKER]) {
        return false;
      }
      if (
        typeof obj.command === 'string' &&
        obj.command.includes('gf-live-bridge')
      ) {
        return false;
      }
      return true;
    });
  }
}

function buildBridgeCommand(scriptPath: string, eventName?: string): string {
  const args = eventName ? ` "${eventName}"` : '';
  return `node "${scriptPath}"${args}`;
}

export async function openCharacterFolder(
  extensionPath: string
): Promise<void> {
  const folder = path.join(extensionPath, 'media', 'characters');
  await vscode.env.openExternal(vscode.Uri.file(folder));
}
