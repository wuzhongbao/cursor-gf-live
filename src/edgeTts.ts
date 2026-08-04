import * as fs from 'fs';
import * as path from 'path';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export interface NeuralVoiceOption {
  id: string;
  label: string;
}

/** Pleasant Chinese female neural voices (Edge Read Aloud). */
export const NEURAL_VOICES: NeuralVoiceOption[] = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温柔甜妹' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 清新自然' },
  { id: 'zh-CN-XiaochenNeural', label: '晓辰 · 知性轻柔' },
  { id: 'zh-CN-XiaohanNeural', label: '晓涵 · 温柔稳重' },
  { id: 'zh-CN-XiaomengNeural', label: '晓梦 · 软萌可爱' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 · 明亮活泼' },
  { id: 'zh-CN-XiaorouNeural', label: '晓柔 · 柔和亲切' },
  { id: 'zh-CN-XiaozhenNeural', label: '晓甄 · 沉稳女声' },
];

export const DEFAULT_NEURAL_VOICE = 'zh-CN-XiaoxiaoNeural';

const OUTPUT = OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3;

let cachedVoice = '';
let cachedTts: MsEdgeTTS | undefined;
let warmPromise: Promise<void> | undefined;
let synthChain: Promise<unknown> = Promise.resolve();

function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Plain text for Edge SSML (only speak/voice/prosody are supported). */
function sanitizeSpeakText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rateToProsody(rate: number): number {
  return Math.min(1.3, Math.max(0.8, rate));
}

function pitchToProsody(pitch: number): string {
  const hz = Math.round((pitch - 1) * 40);
  const clamped = Math.min(40, Math.max(-40, hz));
  return `${clamped >= 0 ? '+' : ''}${clamped}Hz`;
}

async function streamToBuffer(
  stream: NodeJS.ReadableStream
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function resolveVoice(text: string, voice: string): string {
  let v = voice || DEFAULT_NEURAL_VOICE;
  if (containsChinese(text) && !/^zh-/i.test(v)) {
    v = DEFAULT_NEURAL_VOICE;
  }
  return v;
}

async function getReadyTts(voice: string): Promise<MsEdgeTTS> {
  if (cachedTts && cachedVoice === voice) {
    return cachedTts;
  }
  if (cachedTts) {
    try {
      cachedTts.close();
    } catch {
      // ignore
    }
    cachedTts = undefined;
    cachedVoice = '';
  }
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT);
  cachedTts = tts;
  cachedVoice = voice;
  return tts;
}

/** Prefetch Edge TTS websocket + voice metadata. */
export function warmNeuralTts(voice = DEFAULT_NEURAL_VOICE): void {
  if (warmPromise) {
    return;
  }
  warmPromise = (async () => {
    try {
      await getReadyTts(voice || DEFAULT_NEURAL_VOICE);
    } catch (err) {
      warmPromise = undefined;
      console.warn(
        '[GF Live] TTS warm failed:',
        err instanceof Error ? err.message : String(err)
      );
    }
  })();
}

export function disposeNeuralTts(): void {
  if (cachedTts) {
    try {
      cachedTts.close();
    } catch {
      // ignore
    }
  }
  cachedTts = undefined;
  cachedVoice = '';
  warmPromise = undefined;
}

/**
 * Synthesize MP3 via Microsoft Edge neural TTS into audioDir.
 * Reuses a warm websocket when possible.
 */
export async function synthesizeNeuralMp3(opts: {
  text: string;
  voice: string;
  rate: number;
  pitch: number;
  audioDir: string;
}): Promise<string> {
  const run = synthChain.then(() => synthesizeNeuralMp3Inner(opts));
  synthChain = run.catch(() => undefined);
  return run;
}

async function synthesizeNeuralMp3Inner(opts: {
  text: string;
  voice: string;
  rate: number;
  pitch: number;
  audioDir: string;
}): Promise<string> {
  fs.mkdirSync(opts.audioDir, { recursive: true });

  try {
    const existing = fs
      .readdirSync(opts.audioDir)
      .filter((f) => f.endsWith('.mp3'))
      .map((f) => ({
        f,
        t: fs.statSync(path.join(opts.audioDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.t - a.t);
    for (const old of existing.slice(4)) {
      fs.unlinkSync(path.join(opts.audioDir, old.f));
    }
  } catch {
    // ignore
  }

  const voice = resolveVoice(opts.text, opts.voice);
  const plain = sanitizeSpeakText(opts.text);
  const safe = escapeXml(plain);

  let tts: MsEdgeTTS;
  try {
    tts = await getReadyTts(voice);
  } catch {
    disposeNeuralTts();
    tts = await getReadyTts(voice);
  }

  let buf: Buffer;
  try {
    const { audioStream } = tts.toStream(safe, {
      rate: rateToProsody(opts.rate),
      pitch: pitchToProsody(opts.pitch),
      volume: 100,
    });
    buf = await streamToBuffer(audioStream);
  } catch (err) {
    // Connection may have dropped — rebuild once.
    disposeNeuralTts();
    tts = await getReadyTts(voice);
    const { audioStream } = tts.toStream(safe, {
      rate: rateToProsody(opts.rate),
      pitch: pitchToProsody(opts.pitch),
      volume: 100,
    });
    buf = await streamToBuffer(audioStream);
  }

  if (!buf.length) {
    throw new Error('Edge TTS returned empty audio');
  }

  const outPath = path.join(opts.audioDir, `gf-${Date.now()}.mp3`);
  fs.writeFileSync(outPath, buf);
  try {
    const debugDir = path.join(
      process.env.USERPROFILE || process.env.HOME || opts.audioDir,
      '.cursor',
      'gf-live'
    );
    fs.mkdirSync(debugDir, { recursive: true });
    fs.writeFileSync(path.join(debugDir, 'last-speak.txt'), plain, 'utf8');
  } catch {
    // ignore
  }
  return outPath;
}
