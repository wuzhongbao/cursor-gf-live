import * as vscode from 'vscode';
import { playAudioFileHost, probeMp3DurationMs, warmAudioPlayerHost, disposeAudioPlayerHost, stopAudioPlayerHost } from './audioPlayer';
import { DEFAULT_NEURAL_VOICE, warmNeuralTts, disposeNeuralTts } from './edgeTts';
import { EventServer } from './eventServer';
import {
  installHooks,
  isHooksInstalled,
  openCharacterFolder,
  uninstallHooks,
  writeBridgePort,
} from './hooksInstaller';
import { CharacterPack, StateMachine } from './stateMachine';
import { GfLivePanelProvider } from './panelProvider';
import { cleanForSpeech, estimateSpeechMs } from './speechText';
import {
  looksCorruptedChinese,
  readLastAssistantText,
  tryRepairHookText,
} from './transcript';

let machine: StateMachine | undefined;
let server: EventServer | undefined;
let provider: GfLivePanelProvider | undefined;
let audioDir: vscode.Uri | undefined;
let speakQueue: Promise<void> = Promise.resolve();
let lastSpokenFingerprint = '';

function readVoiceSettings() {
  const config = vscode.workspace.getConfiguration('gfLive');
  return {
    enabled: config.get<boolean>('voiceEnabled', true),
    rate: config.get<number>('voiceRate', 1.05),
    pitch: config.get<number>('voicePitch', 1.08),
    maxChars: config.get<number>('voiceMaxChars', 360),
    voiceId: config.get<string>('voiceId', DEFAULT_NEURAL_VOICE),
  };
}

function setVoiceStatus(text: string): void {
  provider?.postVoiceStatus(text);
}

async function speakWithNeuralOrFallback(
  text: string,
  force: boolean
): Promise<void> {
  if (!provider || !audioDir) {
    return;
  }
  const voice = provider.getVoiceSettings();
  if (!force && !voice.enabled) {
    return;
  }

  provider.stopSpeaking();
  stopAudioPlayerHost();
  setVoiceStatus('正在合成语音…');
  const hasChinese = /[\u4e00-\u9fff]/.test(text);
  try {
    const { synthesizeNeuralMp3 } = await import('./edgeTts');
    const file = await synthesizeNeuralMp3({
      text,
      voice: voice.voiceId || DEFAULT_NEURAL_VOICE,
      rate: voice.rate,
      pitch: voice.pitch,
      audioDir: audioDir.fsPath,
    });
    setVoiceStatus('正在播放…');
    const probed = probeMp3DurationMs(file);
    if (!machine?.snapshot().manual) {
      machine?.ingestHookEvent('afterAgentResponse', {
        hook_event_name: 'afterAgentResponse',
      });
    } else {
      machine?.setManualState('speaking');
    }
    // Caption starts only when host audio actually begins (PowerShell cold-start
    // used to run karaoke ahead of the voice by several seconds).
    await playAudioFileHost(file, {
      onStarted: (durationMs) => {
        const ms =
          durationMs > 400
            ? durationMs
            : probed || estimateSpeechMs(text, voice.rate);
        provider?.showCaption(text, ms);
      },
    });
    setVoiceStatus('朗读结束');
    provider.clearCaption();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[GF Live] neural/host play failed:', message);
    if (hasChinese) {
      provider.clearCaption();
      setVoiceStatus(`中文语音失败（未回退系统音）：${message}`);
      void vscode.window.showWarningMessage(
        `GF Live 中文语音播放失败：${message}`
      );
      return;
    }
    setVoiceStatus(`语音失败，回退系统音：${message}`);
    provider.speakSystemFallback(text, force);
  }
}

function enqueueSpeak(text: string, force = false): void {
  const fingerprint = text.slice(0, 80);
  if (!force && fingerprint && fingerprint === lastSpokenFingerprint) {
    return;
  }
  lastSpokenFingerprint = fingerprint;
  speakQueue = speakQueue
    .then(() => speakWithNeuralOrFallback(text, force))
    .catch(() => undefined);
}

/**
 * Resolve speakable assistant text.
 * On Windows, hook stdin often corrupts Chinese — prefer transcript file.
 */
function resolveAssistantSpeakText(
  eventName: string,
  payload: Record<string, unknown>
): string | undefined {
  const transcriptPath =
    (typeof payload.transcript_path === 'string' && payload.transcript_path) ||
    (typeof payload.transcriptPath === 'string' && payload.transcriptPath) ||
    undefined;

  const fromTranscript = readLastAssistantText(transcriptPath);
  const fromHook =
    typeof payload.text === 'string' ? payload.text.trim() : undefined;

  let chosen: string | undefined;

  if (fromTranscript) {
    if (!fromHook || looksCorruptedChinese(fromHook)) {
      chosen = fromTranscript;
    } else {
      chosen =
        fromTranscript.length >= fromHook.length ? fromTranscript : fromHook;
    }
  } else if (fromHook) {
    chosen = looksCorruptedChinese(fromHook)
      ? tryRepairHookText(fromHook)
      : fromHook;
  } else if (eventName === 'afterAgentResponse' || eventName === 'stop') {
    chosen = undefined;
  }

  if (!chosen) {
    return undefined;
  }
  return cleanForSpeech(chosen);
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  try {
    await activateInner(context);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[GF Live] activate failed', err);
    void vscode.window.showErrorMessage(
      `GF Live 启动失败: ${message}。请查看扩展宿主日志。`
    );
  }
}

async function activateInner(
  context: vscode.ExtensionContext
): Promise<void> {
  warmAudioPlayerHost();
  warmNeuralTts(vscode.workspace.getConfiguration('gfLive').get<string>('voiceId', DEFAULT_NEURAL_VOICE));
  const config = vscode.workspace.getConfiguration('gfLive');
  const port = config.get<number>('port', 39217);
  const idleTimeoutMs = config.get<number>('idleTimeoutMs', 8000);
  const doneHoldMs = config.get<number>('doneHoldMs', 2500);
  let pack = config.get<CharacterPack>('defaultPack', 'dark-cyber');
  const autoFollowTheme = config.get<boolean>('autoFollowTheme', true);

  if (autoFollowTheme) {
    const kind = vscode.window.activeColorTheme.kind;
    if (
      kind === vscode.ColorThemeKind.Light ||
      kind === vscode.ColorThemeKind.HighContrastLight
    ) {
      pack = 'warm-white';
    } else {
      pack = 'dark-cyber';
    }
  }

  machine = new StateMachine({
    pack,
    port,
    idleTimeoutMs,
    doneHoldMs,
  });
  machine.setHooksInstalled(isHooksInstalled());

  audioDir = vscode.Uri.joinPath(context.globalStorageUri, 'tts-cache');
  try {
    await vscode.workspace.fs.createDirectory(audioDir);
  } catch {
    // ignore
  }

  provider = new GfLivePanelProvider(
    context.extensionUri,
    audioDir,
    machine
  );
  provider.setVoiceSettings(readVoiceSettings());
  provider.setSpeakHandler(async (text, force) => {
    enqueueSpeak(text, force);
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      GfLivePanelProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  server = new EventServer(port, (eventName, payload) => {
    machine?.setHooksConnected(true);
    machine?.ingestHookEvent(eventName, payload);

    if (eventName === 'beforeSubmitPrompt' || eventName === 'preToolUse') {
      provider?.stopSpeaking();
      stopAudioPlayerHost();
    }

    const voice = readVoiceSettings();
    if (!voice.enabled) {
      return;
    }

    if (eventName === 'afterAgentResponse' || eventName === 'stop') {
      setTimeout(() => {
        const spoken = resolveAssistantSpeakText(eventName, payload);
        if (spoken) {
          enqueueSpeak(spoken, false);
        }
      }, eventName === 'stop' ? 400 : 200);
    }
  });

  try {
    const bound = await server.start();
    writeBridgePort(bound);
    machine.updateConfig({ port: bound });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showWarningMessage(
      `GF Live 事件服务启动失败（${message}）。面板仍可用。`
    );
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('gfLive.showPanel', async () => {
      try {
        await vscode.commands.executeCommand('workbench.view.extension.gfLive');
      } catch {
        // ignore
      }
      try {
        await vscode.commands.executeCommand('gfLive.panel.focus');
      } catch {
        // ignore
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gfLive.installHooks', async () => {
      try {
        const p = server?.getPort() ?? port;
        await installHooks(context.extensionPath, p);
        writeBridgePort(p);
        machine?.setHooksInstalled(true);
        void vscode.window.showInformationMessage(
          'GF Live Hooks 已安装。中文语音从会话记录读取，可避开 Windows Hook 乱码。'
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`安装 Hooks 失败: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gfLive.uninstallHooks', async () => {
      try {
        await uninstallHooks();
        machine?.setHooksInstalled(false);
        void vscode.window.showInformationMessage('GF Live Hooks 已卸载。');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(`卸载 Hooks 失败: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gfLive.openCharacterFolder', async () => {
      await openCharacterFolder(context.extensionPath);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gfLive.testVoice', async () => {
      await vscode.commands.executeCommand('gfLive.showPanel');
      enqueueSpeak(
        '你好呀，我是 GF Live。中文语音已经改成从会话记录读取，不会再读成乱码了。',
        true
      );
      machine?.setManualState('speaking');
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('gfLive')) {
        return;
      }
      const cfg = vscode.workspace.getConfiguration('gfLive');
      machine?.updateConfig({
        port: cfg.get<number>('port', 39217),
        idleTimeoutMs: cfg.get<number>('idleTimeoutMs', 8000),
        doneHoldMs: cfg.get<number>('doneHoldMs', 2500),
      });
      provider?.setVoiceSettings(readVoiceSettings());
    })
  );

  context.subscriptions.push({
    dispose: () => {
      provider?.dispose();
      machine?.dispose();
      void server?.stop();
    },
  });
}

export function deactivate(): void {
  provider?.dispose();
  machine?.dispose();
  disposeAudioPlayerHost();
  disposeNeuralTts();
  void server?.stop();
}
