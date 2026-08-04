export type GfState =
  | 'idle'
  | 'listening'
  | 'speaking'
  | 'working'
  | 'approval'
  | 'done';

export type CharacterPack = 'dark-cyber' | 'warm-white';

export const STATES: GfState[] = [
  'idle',
  'listening',
  'speaking',
  'working',
  'approval',
  'done',
];

export const STATE_LABELS: Record<GfState, string> = {
  idle: 'IDLE · 待机中',
  listening: 'LISTENING · 正在听你说',
  speaking: 'SPEAKING · 正在说明',
  working: 'WORKING · 正在改代码',
  approval: 'APPROVAL · 等待你确认',
  done: 'DONE · 这一轮完成了',
};

export interface StateSnapshot {
  state: GfState;
  pack: CharacterPack;
  manual: boolean;
  label: string;
  lastEvent?: string;
  hooksConnected: boolean;
  hooksInstalled: boolean;
  port: number;
}

type Listener = (snapshot: StateSnapshot) => void;

export class StateMachine {
  private state: GfState = 'idle';
  private pack: CharacterPack;
  private manual = false;
  private lastEvent?: string;
  private hooksConnected = false;
  private hooksInstalled = false;
  private port: number;
  private idleTimeoutMs: number;
  private doneHoldMs: number;
  private idleTimer?: NodeJS.Timeout;
  private doneTimer?: NodeJS.Timeout;
  private readonly listeners = new Set<Listener>();

  constructor(opts: {
    pack: CharacterPack;
    port: number;
    idleTimeoutMs: number;
    doneHoldMs: number;
  }) {
    this.pack = opts.pack;
    this.port = opts.port;
    this.idleTimeoutMs = opts.idleTimeoutMs;
    this.doneHoldMs = opts.doneHoldMs;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): StateSnapshot {
    return {
      state: this.state,
      pack: this.pack,
      manual: this.manual,
      label: STATE_LABELS[this.state],
      lastEvent: this.lastEvent,
      hooksConnected: this.hooksConnected,
      hooksInstalled: this.hooksInstalled,
      port: this.port,
    };
  }

  updateConfig(opts: {
    port?: number;
    idleTimeoutMs?: number;
    doneHoldMs?: number;
  }): void {
    if (opts.port !== undefined) {
      this.port = opts.port;
    }
    if (opts.idleTimeoutMs !== undefined) {
      this.idleTimeoutMs = opts.idleTimeoutMs;
    }
    if (opts.doneHoldMs !== undefined) {
      this.doneHoldMs = opts.doneHoldMs;
    }
    this.emit();
  }

  setHooksInstalled(installed: boolean): void {
    this.hooksInstalled = installed;
    this.emit();
  }

  setHooksConnected(connected: boolean): void {
    this.hooksConnected = connected;
    this.emit();
  }

  setPack(pack: CharacterPack): void {
    this.pack = pack;
    this.emit();
  }

  setManualState(state: GfState): void {
    this.clearTimers();
    this.manual = true;
    this.state = state;
    this.lastEvent = 'manual';
    this.emit();
  }

  clearManual(): void {
    this.manual = false;
    this.lastEvent = 'auto-resume';
    this.emit();
  }

  /**
   * Map a Cursor hook event name (and optional payload hints) into a GF state.
   */
  ingestHookEvent(eventName: string, payload?: Record<string, unknown>): void {
    if (this.manual) {
      this.lastEvent = `${eventName} (ignored:manual)`;
      this.emit();
      return;
    }

    const next = mapHookEvent(eventName, payload);
    this.lastEvent = eventName;
    this.applyAutoState(next);
  }

  private applyAutoState(next: GfState): void {
    this.clearTimers();

    // Latest event wins so tool→response transitions (working→speaking) remain visible.
    this.state = next;
    this.emit();

    if (next === 'done') {
      this.doneTimer = setTimeout(() => {
        if (!this.manual) {
          this.state = 'idle';
          this.lastEvent = 'done-timeout';
          this.emit();
        }
      }, this.doneHoldMs);
      return;
    }

    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    if (this.manual || this.state === 'idle' || this.state === 'done') {
      return;
    }
    this.idleTimer = setTimeout(() => {
      if (!this.manual && this.state !== 'done') {
        this.state = 'idle';
        this.lastEvent = 'idle-timeout';
        this.emit();
      }
    }, this.idleTimeoutMs);
  }

  private clearTimers(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.doneTimer) {
      clearTimeout(this.doneTimer);
      this.doneTimer = undefined;
    }
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) {
      listener(snap);
    }
  }

  dispose(): void {
    this.clearTimers();
    this.listeners.clear();
  }
}

export function mapHookEvent(
  eventName: string,
  payload?: Record<string, unknown>
): GfState {
  const name = (eventName || '').trim();

  if (
    name === 'beforeSubmitPrompt' ||
    name === 'sessionStart' ||
    name === 'UserPromptSubmit'
  ) {
    return 'listening';
  }

  if (name === 'afterAgentThought' || name === 'afterAgentResponse') {
    return 'speaking';
  }

  if (
    name === 'preToolUse' ||
    name === 'postToolUse' ||
    name === 'afterFileEdit' ||
    name === 'beforeShellExecution' ||
    name === 'afterShellExecution' ||
    name === 'beforeMCPExecution' ||
    name === 'afterMCPExecution' ||
    name === 'beforeReadFile' ||
    name === 'subagentStart'
  ) {
    if (looksLikeApproval(payload)) {
      return 'approval';
    }
    return 'working';
  }

  if (name === 'stop' || name === 'sessionEnd' || name === 'subagentStop') {
    return 'done';
  }

  // Unknown events: ignore rather than forcing listening forever
  return 'idle';
}

function looksLikeApproval(payload?: Record<string, unknown>): boolean {
  if (!payload) {
    return false;
  }
  const blob = JSON.stringify(payload).toLowerCase();
  return (
    blob.includes('permission') ||
    blob.includes('"ask"') ||
    blob.includes('approval') ||
    blob.includes('awaiting')
  );
}
