import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DEFAULT_NEURAL_VOICE, NEURAL_VOICES } from './edgeTts';
import { estimateSpeechMs } from './speechText';
import {
  CharacterPack,
  GfState,
  STATE_LABELS,
  STATES,
  StateMachine,
  StateSnapshot,
} from './stateMachine';

export interface VoiceSettings {
  enabled: boolean;
  rate: number;
  pitch: number;
  maxChars: number;
  voiceId: string;
}

export class GfLivePanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gfLive.panel';

  private view?: vscode.WebviewView;
  private readonly extensionUri: vscode.Uri;
  private readonly audioDir: vscode.Uri;
  private readonly machine: StateMachine;
  private unsub?: () => void;
  private voice: VoiceSettings = {
    enabled: true,
    rate: 1.05,
    pitch: 1.08,
    maxChars: 360,
    voiceId: DEFAULT_NEURAL_VOICE,
  };
  private speakHandler?: (text: string, force: boolean) => Promise<void>;

  constructor(
    extensionUri: vscode.Uri,
    audioDir: vscode.Uri,
    machine: StateMachine
  ) {
    this.extensionUri = extensionUri;
    this.audioDir = audioDir;
    this.machine = machine;
  }

  setSpeakHandler(handler: (text: string, force: boolean) => Promise<void>): void {
    this.speakHandler = handler;
  }

  setVoiceSettings(voice: VoiceSettings): void {
    this.voice = voice;
    this.postVoiceSettings();
  }

  getVoiceSettings(): VoiceSettings {
    return { ...this.voice };
  }

  async speak(text: string, force = false): Promise<void> {
    if (!force && !this.voice.enabled) {
      return;
    }
    const cleaned = (text || '').trim();
    if (!cleaned) {
      return;
    }
    if (this.speakHandler) {
      await this.speakHandler(cleaned, force);
      return;
    }
    this.speakSystemFallback(cleaned, force);
  }

  playAudioFile(filePath: string): void {
    if (!this.view) {
      return;
    }
    const fileUri = vscode.Uri.file(filePath);
    const playUri = this.view.webview.asWebviewUri(fileUri).toString();
    this.view.webview.postMessage({
      type: 'playAudio',
      url: playUri,
    });
  }

  /** Karaoke-style reply caption over the character (official Object Live vibe). */
  showCaption(text: string, durationMs?: number): void {
    if (!this.view) {
      return;
    }
    const cleaned = (text || '').trim();
    if (!cleaned) {
      return;
    }
    this.view.webview.postMessage({
      type: 'showCaption',
      text: cleaned,
      durationMs: durationMs && durationMs > 0 ? durationMs : estimateSpeechMs(cleaned, this.voice.rate),
    });
  }

  clearCaption(): void {
    this.view?.webview.postMessage({ type: 'clearCaption' });
  }

  speakSystemFallback(text: string, force = false): void {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({
      type: 'speak',
      text,
      rate: this.voice.rate,
      pitch: this.voice.pitch,
      force,
    });
  }

  stopSpeaking(): void {
    this.clearCaption();
    this.view?.webview.postMessage({ type: 'stopSpeak' });
  }

  postVoiceStatus(text: string): void {
    this.view?.webview.postMessage({
      type: 'voiceStatus',
      text,
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media'),
        this.audioDir,
      ],
    };

    try {
      webview.html = this.renderHtml(webview, this.machine.snapshot());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.html = `<!DOCTYPE html><html><body style="background:#1e1e1e;color:#fff;font-family:sans-serif;padding:16px">
        <h2>GF Live</h2>
        <p>面板渲染失败：${message}</p>
        <p>请执行 Developer: Toggle Developer Tools 查看扩展宿主日志。</p>
      </body></html>`;
      void vscode.window.showErrorMessage(`GF Live 面板渲染失败: ${message}`);
      return;
    }

    this.unsub?.();
    this.unsub = this.machine.subscribe((snap) => this.postSnapshot(snap));

    webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object') {
        return;
      }
      const type = (msg as { type?: string }).type;
      if (type === 'setState') {
        const state = (msg as { state?: string }).state as GfState;
        if (STATES.includes(state)) {
          this.machine.setManualState(state);
          if (state === 'speaking') {
            void this.speak('嗯，我来跟你说一下。', true);
          } else {
            this.stopSpeaking();
          }
        }
      } else if (type === 'clearManual') {
        this.machine.clearManual();
      } else if (type === 'setPack') {
        const pack = (msg as { pack?: string }).pack as CharacterPack;
        if (pack === 'dark-cyber' || pack === 'warm-white') {
          this.machine.setPack(pack);
          await vscode.workspace
            .getConfiguration('gfLive')
            .update('defaultPack', pack, vscode.ConfigurationTarget.Global);
        }
      } else if (type === 'installHooks') {
        await vscode.commands.executeCommand('gfLive.installHooks');
      } else if (type === 'setVoiceEnabled') {
        const enabled = Boolean((msg as { enabled?: boolean }).enabled);
        this.voice.enabled = enabled;
        await vscode.workspace
          .getConfiguration('gfLive')
          .update('voiceEnabled', enabled, vscode.ConfigurationTarget.Global);
        if (!enabled) {
          this.stopSpeaking();
        }
      } else if (type === 'setVoiceId') {
        const voiceId = String((msg as { voiceId?: string }).voiceId || '');
        if (NEURAL_VOICES.some((v) => v.id === voiceId)) {
          this.voice.voiceId = voiceId;
          await vscode.workspace
            .getConfiguration('gfLive')
            .update('voiceId', voiceId, vscode.ConfigurationTarget.Global);
        }
      } else if (type === 'testVoice') {
        const label =
          NEURAL_VOICES.find((v) => v.id === this.voice.voiceId)?.label ||
          '晓晓';
        void this.speak(
          `你好呀，我是 GF Live。现在用的是${label.split('·')[0].trim()}的声音，好听吗？`,
          true
        );
        this.machine.setManualState('speaking');
      } else if (type === 'speechStarted') {
        if (!this.machine.snapshot().manual) {
          this.machine.ingestHookEvent('afterAgentResponse', {
            hook_event_name: 'afterAgentResponse',
          });
        }
      } else if (type === 'ready') {
        this.postSnapshot(this.machine.snapshot());
        this.postVoiceSettings();
      }
    });
  }

  dispose(): void {
    this.unsub?.();
  }

  private postVoiceSettings(): void {
    this.view?.webview.postMessage({
      type: 'voiceSettings',
      voice: this.voice,
      voices: NEURAL_VOICES,
    });
  }

  private postSnapshot(snap: StateSnapshot): void {
    if (!this.view) {
      return;
    }
    const webview = this.view.webview;
    const media = this.assetMap(webview, snap.pack);
    const posters = this.posterMap(webview, snap.pack);
    const variants = this.variantMap(webview, snap.pack, media);
    webview.postMessage({
      type: 'snapshot',
      snapshot: snap,
      media,
      posters,
      variants,
      labels: STATE_LABELS,
      states: STATES,
    });
  }

  private assetMap(
    webview: vscode.Webview,
    pack: CharacterPack
  ): Record<GfState, string> {
    const out = {} as Record<GfState, string>;
    for (const state of STATES) {
      const base = vscode.Uri.joinPath(
        this.extensionUri,
        'media',
        'characters',
        pack
      );
      // Prefer real video loops (silky 30fps+) over GIF/still.
      const candidates = [
        `${state}.mp4`,
        `${state}.webm`,
        `${state}.gif`,
        `${state}.webp`,
        `${state}.png`,
      ];
      let chosen = vscode.Uri.joinPath(base, `${state}.png`);
      for (const name of candidates) {
        const candidate = vscode.Uri.joinPath(base, name);
        if (fs.existsSync(candidate.fsPath)) {
          chosen = candidate;
          break;
        }
      }
      out[state] = webview.asWebviewUri(chosen).toString();
    }
    return out;
  }

  /** Still posters used when video decode/autoplay fails in the webview. */
  private posterMap(
    webview: vscode.Webview,
    pack: CharacterPack
  ): Partial<Record<GfState, string>> {
    const out: Partial<Record<GfState, string>> = {};
    const base = vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      'characters',
      pack
    );
    for (const state of STATES) {
      for (const name of [`${state}.webp`, `${state}.png`]) {
        const candidate = vscode.Uri.joinPath(base, name);
        if (fs.existsSync(candidate.fsPath)) {
          out[state] = webview.asWebviewUri(candidate).toString();
          break;
        }
      }
    }
    return out;
  }

  /**
   * Official-style expression pools.
   * Speaking stays locked to one stable clip (CodexGF: speaking-neutral) so
   * TTS + captions are not interrupted by pose jumps mid-reply.
   */
  private variantMap(
    webview: vscode.Webview,
    pack: CharacterPack,
    primary: Record<GfState, string>
  ): Partial<Record<GfState, string[]>> {
    const base = vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      'characters',
      pack
    );
    const variantsDir = vscode.Uri.joinPath(base, 'variants');
    const poolsPath = path.join(variantsDir.fsPath, 'pools.json');
    let pools: Partial<Record<GfState, string[]>> = {};
    try {
      if (fs.existsSync(poolsPath)) {
        const raw = fs
          .readFileSync(poolsPath, 'utf8')
          .replace(/^\uFEFF/, '');
        pools = JSON.parse(raw) as Partial<Record<GfState, string[]>>;
      }
    } catch {
      pools = {};
    }

    const out: Partial<Record<GfState, string[]>> = {};
    for (const state of STATES) {
      const names = pools[state] || [];
      const urls: string[] = [];
      for (const name of names) {
        const candidate = vscode.Uri.joinPath(variantsDir, name);
        if (fs.existsSync(candidate.fsPath)) {
          urls.push(webview.asWebviewUri(candidate).toString());
        }
      }
      // Do not mix primary speaking.mp4 into a locked neutral pool.
      if (
        primary[state] &&
        !urls.includes(primary[state]) &&
        !(state === 'speaking' && urls.length > 0)
      ) {
        urls.unshift(primary[state]);
      }
      if (urls.length) {
        out[state] = urls;
      }
    }
    return out;
  }

  private renderHtml(webview: vscode.Webview, snap: StateSnapshot): string {
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: blob:`,
      `media-src ${webview.cspSource} data: blob:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
    ].join('; ');

    const media = this.assetMap(webview, snap.pack);
    const posters = this.posterMap(webview, snap.pack);
    const variants = this.variantMap(webview, snap.pack, media);
    const mediaJson = JSON.stringify(media);
    const postersJson = JSON.stringify(posters);
    const variantsJson = JSON.stringify(variants);
    const labelsJson = JSON.stringify(STATE_LABELS);
    const statesJson = JSON.stringify(STATES);
    const snapJson = JSON.stringify(snap);
    const voiceJson = JSON.stringify(this.voice);
    const voicesJson = JSON.stringify(NEURAL_VOICES);

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GF Live</title>
  <style>
    :root {
      --bg: var(--vscode-sideBar-background, #1e1e1e);
      --fg: var(--vscode-foreground, #ddd);
      --muted: var(--vscode-descriptionForeground, #999);
      --accent: var(--vscode-focusBorder, #3b82f6);
      --panel: var(--vscode-editorWidget-background, #252526);
      --border: var(--vscode-panel-border, #333);
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; height: 100%;
      background: var(--bg); color: var(--fg);
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: 12px;
    }
    .wrap { display: flex; flex-direction: column; height: 100%; padding: 10px; gap: 10px; }
    .title {
      font-size: 13px; font-weight: 700; letter-spacing: 0.08em;
      color: var(--fg); opacity: 0.9;
    }
    .viewport {
      position: relative; flex: 1 1 auto; min-height: 220px;
      border-radius: 10px; overflow: hidden; background: #05070a; border: 1px solid var(--border);
    }
    .placeholder {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      color: #9ca3af; font-size: 13px; z-index: 0;
    }
    .viewport img, .viewport video {
      position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
      opacity: 0; transition: opacity 220ms ease; z-index: 1; background: #05070a;
    }
    .viewport img.visible, .viewport video.visible { opacity: 1; }
    .viewport video { pointer-events: none; }
    .caption {
      position: absolute; left: 10px; right: 10px; bottom: 12px; z-index: 5;
      pointer-events: none; text-align: left; max-height: 42%; overflow: hidden;
      font-size: 15px; line-height: 1.55; font-weight: 600; letter-spacing: 0.02em;
      text-shadow: 0 1px 2px rgba(0,0,0,0.85), 0 0 12px rgba(0,0,0,0.45);
      opacity: 0; transform: translateY(6px); transition: opacity 180ms ease, transform 180ms ease;
    }
    .caption.visible { opacity: 1; transform: translateY(0); }
    .caption .cap-char { color: rgba(255,255,255,0.88); }
    .caption .cap-char.lit { color: #ffe566; }
    .caption .cap-char.cur {
      color: #fff3a0;
      text-shadow: 0 0 10px rgba(255,229,102,0.55), 0 1px 2px rgba(0,0,0,0.85);
    }
    .status { display: flex; flex-direction: column; gap: 6px; }
    .status-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .badge { font-weight: 600; letter-spacing: 0.02em; }
    .manual-tag { color: var(--accent); font-size: 11px; }
    .pills { display: flex; flex-wrap: wrap; gap: 4px; }
    button.pill, button.action, select.pack, select.voice {
      appearance: none; border: 1px solid var(--border); background: var(--panel);
      color: var(--fg); border-radius: 999px; padding: 4px 8px; cursor: pointer; font-size: 11px;
    }
    select.pack, select.voice { border-radius: 6px; max-width: 100%; }
    button.pill.active { border-color: var(--accent); color: var(--accent); }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .voice-bar {
      padding: 8px; border: 1px solid var(--border); border-radius: 8px;
      background: var(--panel); display: flex; flex-direction: column; gap: 6px;
    }
    .footer {
      color: var(--muted); font-size: 11px; border-top: 1px solid var(--border);
      padding-top: 8px; display: flex; flex-direction: column; gap: 6px;
    }
    .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; background: #666; }
    .dot.ok { background: #22c55e; }
    .dot.warn { background: #f59e0b; }
    .dot.bad { background: #ef4444; }
    label.check { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
    audio { display: none; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="title">GF LIVE</div>
    <div class="viewport" id="viewport">
      <div class="placeholder" id="placeholder">角色加载中…</div>
      <video id="vidA" muted playsinline loop preload="auto"></video>
      <video id="vidB" muted playsinline loop preload="auto"></video>
      <img id="imgA" alt="character" />
      <img id="imgB" alt="character" />
      <div class="caption" id="caption" aria-live="polite"></div>
    </div>
    <div class="status">
      <div class="status-line">
        <div class="badge" id="label">IDLE · 待机中</div>
        <div class="manual-tag" id="manualTag" hidden>手动</div>
      </div>
      <div class="voice-bar">
        <div class="row">
          <label class="check"><input type="checkbox" id="voiceToggle" checked /> 语音朗读</label>
          <button class="action" id="testVoiceBtn" type="button">试听美女音</button>
        </div>
        <select class="voice" id="voiceSel" title="音色"></select>
      </div>
      <div class="pills" id="pills"></div>
      <div class="row">
        <select class="pack" id="pack" title="角色包">
          <option value="dark-cyber">深色赛博</option>
          <option value="warm-white">暖白女友</option>
        </select>
        <button class="action" id="autoBtn" type="button">恢复自动</button>
      </div>
    </div>
    <div class="footer">
      <div id="hooksLine"><span class="dot" id="dot"></span><span id="hooksText">检测中…</span></div>
      <div class="row">
        <button class="action" id="installBtn" type="button">安装 / 修复 Hooks</button>
      </div>
      <div id="eventLine" style="opacity:0.75"></div>
      <div id="voiceLine" style="opacity:0.75"></div>
    </div>
  </div>
  <audio id="player"></audio>
  <script>
    const vscode = acquireVsCodeApi();
    const STATES = ${statesJson};
    const LABELS = ${labelsJson};
    let media = ${mediaJson};
    let posters = ${postersJson};
    let variants = ${variantsJson};
    let snap = ${snapJson};
    let voice = ${voiceJson};
    let voices = ${voicesJson};
    let useA = true;
    let currentUtterance = null;
    let mediaIsVideo = false;
    let lastPickedUrl = '';
    let videoWatchdog = null;

    const imgA = document.getElementById('imgA');
    const imgB = document.getElementById('imgB');
    const vidA = document.getElementById('vidA');
    const vidB = document.getElementById('vidB');
    const placeholder = document.getElementById('placeholder');
    const labelEl = document.getElementById('label');
    const manualTag = document.getElementById('manualTag');
    const pills = document.getElementById('pills');
    const packSel = document.getElementById('pack');
    const autoBtn = document.getElementById('autoBtn');
    const installBtn = document.getElementById('installBtn');
    const hooksText = document.getElementById('hooksText');
    const eventLine = document.getElementById('eventLine');
    const voiceLine = document.getElementById('voiceLine');
    const voiceToggle = document.getElementById('voiceToggle');
    const testVoiceBtn = document.getElementById('testVoiceBtn');
    const voiceSel = document.getElementById('voiceSel');
    const player = document.getElementById('player');
    const dot = document.getElementById('dot');
    const captionEl = document.getElementById('caption');
    let captionTimer = null;
    let captionRaf = 0;

    function clearCaption() {
      if (captionTimer) { clearTimeout(captionTimer); captionTimer = null; }
      if (captionRaf) { cancelAnimationFrame(captionRaf); captionRaf = 0; }
      if (captionEl) {
        captionEl.classList.remove('visible');
        captionEl.innerHTML = '';
      }
    }

    function showCaption(text, durationMs) {
      clearCaption();
      if (!captionEl || !text) return;
      // Keep speaking clip stable (CodexGF style); captions track TTS only.
      const chars = Array.from(String(text));
      captionEl.innerHTML = chars.map((ch) => {
        const safe = ch === ' ' ? '&nbsp;' : ch
          .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        return '<span class="cap-char">' + safe + '</span>';
      }).join('');
      captionEl.classList.add('visible');
      const spans = captionEl.querySelectorAll('.cap-char');
      const total = Math.max(1, spans.length);
      const dur = Math.max(900, Number(durationMs) || (total * 200));
      const started = performance.now();
      function tick(now) {
        const p = Math.min(1, (now - started) / dur);
        const litCount = Math.floor(p * total);
        spans.forEach((el, i) => {
          el.classList.toggle('lit', i < litCount);
          el.classList.toggle('cur', i === litCount && p < 1);
        });
        if (p < 1) {
          captionRaf = requestAnimationFrame(tick);
        } else {
          spans.forEach((el) => { el.classList.add('lit'); el.classList.remove('cur'); });
          captionTimer = setTimeout(() => clearCaption(), 900);
        }
      }
      captionRaf = requestAnimationFrame(tick);
    }

    function fillVoices() {
      voiceSel.innerHTML = '';
      for (const v of voices) {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = v.label;
        voiceSel.appendChild(opt);
      }
      voiceSel.value = (voice && voice.voiceId) || voices[0].id;
    }

    function buildPills() {
      pills.innerHTML = '';
      for (const s of STATES) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'pill' + (snap.state === s ? ' active' : '');
        b.textContent = s;
        b.addEventListener('click', () => vscode.postMessage({ type: 'setState', state: s }));
        pills.appendChild(b);
      }
    }

    function isVideoUrl(url) {
      const u = String(url || '').toLowerCase();
      return u.includes('.webm') || u.includes('.mp4') || u.includes('.mov');
    }

    function hideAllMedia() {
      [imgA, imgB, vidA, vidB].forEach((el) => {
        el.classList.remove('visible');
        if (el.tagName === 'VIDEO') {
          try { el.pause(); } catch (e) {}
        }
      });
    }

    function pickUrl(state, preferFresh) {
      const pool = (variants && variants[state]) || [];
      const fallback = (media && media[state]) || (media && media.idle) || '';
      if (!pool.length) return fallback;
      if (pool.length === 1) return pool[0];
      let url = pool[Math.floor(Math.random() * pool.length)];
      if (preferFresh && pool.length > 1) {
        let guard = 0;
        while (url === lastPickedUrl && guard++ < 6) {
          url = pool[Math.floor(Math.random() * pool.length)];
        }
      }
      lastPickedUrl = url;
      return url || fallback;
    }

    function showVideo(url, soft, posterUrl) {
      const incoming = useA ? vidB : vidA;
      const outgoing = useA ? vidA : vidB;
      let settled = false;
      if (videoWatchdog) { clearTimeout(videoWatchdog); videoWatchdog = null; }
      const finish = () => {
        if (settled) return;
        settled = true;
        if (videoWatchdog) { clearTimeout(videoWatchdog); videoWatchdog = null; }
        placeholder.style.display = 'none';
        incoming.classList.add('visible');
        outgoing.classList.remove('visible');
        try { outgoing.pause(); } catch (e) {}
        incoming.muted = true;
        incoming.playsInline = true;
        incoming.loop = true;
        incoming.play().catch(() => {});
        useA = !useA;
      };
      const failToPoster = () => {
        if (settled) return;
        if (posterUrl) {
          settled = true;
          if (videoWatchdog) { clearTimeout(videoWatchdog); videoWatchdog = null; }
          try { incoming.pause(); } catch (e) {}
          incoming.classList.remove('visible');
          showImage(posterUrl, snap && snap.state ? snap.state : 'idle');
          return;
        }
        placeholder.textContent = '视频加载失败';
        placeholder.style.display = 'flex';
      };
      incoming.onloadeddata = finish;
      incoming.oncanplay = finish;
      incoming.onerror = failToPoster;
      videoWatchdog = setTimeout(() => {
        if (!settled) failToPoster();
      }, 2000);
      if (!soft && incoming.src === url && incoming.readyState >= 2) {
        finish();
        return;
      }
      incoming.src = url;
      incoming.load();
    }

    function showImage(url, state) {
      const incoming = useA ? imgB : imgA;
      const outgoing = useA ? imgA : imgB;
      incoming.onload = () => {
        placeholder.style.display = 'none';
        incoming.classList.add('visible');
        outgoing.classList.remove('visible');
        useA = !useA;
      };
      incoming.onerror = () => {
        if (state !== 'idle' && (posters.idle || media.idle)) {
          incoming.src = posters.idle || media.idle;
          return;
        }
        placeholder.textContent = '角色资源缺失';
        placeholder.style.display = 'flex';
      };
      if (incoming.src === url) {
        placeholder.style.display = 'none';
        incoming.classList.add('visible');
        outgoing.classList.remove('visible');
        return;
      }
      incoming.src = url;
    }

    function showMedia(state) {
      const url = pickUrl(state, true);
      const posterUrl = (posters && posters[state]) || (posters && posters.idle) || '';
      if (!url) {
        if (posterUrl) showImage(posterUrl, state);
        else {
          placeholder.textContent = '角色资源缺失';
          placeholder.style.display = 'flex';
        }
        return;
      }
      const nextIsVideo = isVideoUrl(url);
      if (nextIsVideo !== mediaIsVideo) {
        hideAllMedia();
        mediaIsVideo = nextIsVideo;
      }
      if (nextIsVideo) {
        imgA.classList.remove('visible');
        imgB.classList.remove('visible');
        // Speaking: one stable looping clip (CodexGF). Other states may rotate via pool.
        showVideo(url, false, posterUrl);
      } else {
        try { vidA.pause(); vidB.pause(); } catch (e) {}
        vidA.classList.remove('visible');
        vidB.classList.remove('visible');
        showImage(url, state);
      }
    }

    function stopSpeak() {
      try { player.pause(); player.removeAttribute('src'); player.load(); } catch (e) {}
      if (window.speechSynthesis) window.speechSynthesis.cancel();
      currentUtterance = null;
      voiceLine.textContent = '';
      clearCaption();
    }

    function playAudioUrl(url) {
      stopSpeak();
      player.src = url;
      voiceLine.textContent = '正在用神经女声朗读…';
      vscode.postMessage({ type: 'speechStarted' });
      player.onended = () => {
        voiceLine.textContent = '朗读结束';
        vscode.postMessage({ type: 'speechEnded' });
        setTimeout(() => clearCaption(), 600);
      };
      player.onerror = () => {
        voiceLine.textContent = '音频播放失败，尝试系统语音…';
      };
      const p = player.play();
      if (p && p.catch) p.catch(() => { voiceLine.textContent = '播放被拦截，请再点试听'; });
    }

    function pickVoice() {
      const list = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      if (!list.length) return null;
      const zh = list.filter(v => /zh(-|_)?cn|chinese|中文|普通话/i.test(v.lang + ' ' + v.name));
      return zh.find(v => /female|xiaoxiao|huihui|yaoyao/i.test(v.name)) || zh[0] || list[0];
    }

    function speakSystem(text, rate, pitch) {
      if (!window.speechSynthesis) {
        voiceLine.textContent = '当前环境不支持系统语音';
        return;
      }
      stopSpeak();
      showCaption(text, Math.round((Array.from(text).length * 210) / Math.max(0.7, rate || 1)) + 400);
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = rate || 1.05;
      u.pitch = pitch || 1.08;
      const v = pickVoice();
      if (v) u.voice = v;
      u.onstart = () => {
        voiceLine.textContent = '系统语音朗读中…';
        vscode.postMessage({ type: 'speechStarted' });
      };
      u.onend = () => {
        voiceLine.textContent = '朗读结束';
        vscode.postMessage({ type: 'speechEnded' });
        setTimeout(() => clearCaption(), 600);
      };
      currentUtterance = u;
      window.speechSynthesis.speak(u);
    }

    function render() {
      labelEl.textContent = snap.label || LABELS[snap.state] || snap.state;
      manualTag.hidden = !snap.manual;
      packSel.value = snap.pack;
      voiceToggle.checked = !voice || voice.enabled !== false;
      if (voice && voice.voiceId) voiceSel.value = voice.voiceId;
      buildPills();
      showMedia(snap.state);
      dot.className = 'dot';
      if (!snap.hooksInstalled) {
        dot.classList.add('bad');
        hooksText.textContent = 'Hooks 未安装 · 端口 ' + snap.port;
      } else if (snap.hooksConnected) {
        dot.classList.add('ok');
        hooksText.textContent = 'Hooks 已连接 · 端口 ' + snap.port;
      } else {
        dot.classList.add('warn');
        hooksText.textContent = 'Hooks 已安装，等待事件 · 端口 ' + snap.port;
      }
      eventLine.textContent = snap.lastEvent ? ('最近事件: ' + snap.lastEvent) : '';
    }

    packSel.addEventListener('change', () => vscode.postMessage({ type: 'setPack', pack: packSel.value }));
    autoBtn.addEventListener('click', () => vscode.postMessage({ type: 'clearManual' }));
    installBtn.addEventListener('click', () => vscode.postMessage({ type: 'installHooks' }));
    voiceToggle.addEventListener('change', () => {
      vscode.postMessage({ type: 'setVoiceEnabled', enabled: voiceToggle.checked });
      if (!voiceToggle.checked) stopSpeak();
    });
    voiceSel.addEventListener('change', () => {
      vscode.postMessage({ type: 'setVoiceId', voiceId: voiceSel.value });
    });
    testVoiceBtn.addEventListener('click', () => vscode.postMessage({ type: 'testVoice' }));

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'snapshot') {
        snap = msg.snapshot;
        media = msg.media || media;
        if (msg.posters) posters = msg.posters;
        if (msg.variants) variants = msg.variants;
        render();
      } else if (msg.type === 'voiceSettings') {
        voice = msg.voice || voice;
        if (msg.voices) voices = msg.voices;
        fillVoices();
        voiceToggle.checked = !voice || voice.enabled !== false;
      } else if (msg.type === 'playAudio') {
        playAudioUrl(msg.url);
      } else if (msg.type === 'speak') {
        speakSystem(msg.text, msg.rate, msg.pitch);
      } else if (msg.type === 'showCaption') {
        showCaption(msg.text, msg.durationMs);
      } else if (msg.type === 'clearCaption') {
        clearCaption();
      } else if (msg.type === 'stopSpeak') {
        stopSpeak();
      } else if (msg.type === 'voiceStatus') {
        voiceLine.textContent = msg.text || '';
      }
    });

    fillVoices();
    if (window.speechSynthesis) window.speechSynthesis.getVoices();
    render();
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
