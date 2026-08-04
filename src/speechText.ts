/**
 * Extract and clean assistant text for TTS.
 */
export function extractSpeakText(
  eventName: string,
  payload?: Record<string, unknown>
): string | undefined {
  if (!payload) {
    return undefined;
  }

  // Prefer afterAgentResponse final text; skip raw thinking dumps by default.
  if (eventName === 'afterAgentThought') {
    return undefined;
  }

  let raw =
    pickString(payload.text) ||
    pickString(payload.message) ||
    pickString(payload.content) ||
    pickString(payload.assistant_text) ||
    pickString(payload.response) ||
    pickNestedText(payload);

  // Recover from bridge parse failures: payload.raw may still contain JSON.
  if (!raw && typeof payload.raw === 'string') {
    raw = recoverTextFromRaw(payload.raw);
  }

  // Don't narrate shell/tool payloads unless they include assistant text.
  if (
    !pickString(payload.text) &&
    (eventName.includes('Shell') ||
      eventName.includes('Tool') ||
      eventName.includes('MCP') ||
      eventName.includes('File') ||
      eventName.includes('Read'))
  ) {
    return undefined;
  }

  if (!raw) {
    if (eventName === 'afterAgentResponse') {
      return '嗯，我这边回复完啦。';
    }
    return undefined;
  }

  return cleanForSpeech(raw);
}

export function cleanForSpeech(input: string, maxChars = 360): string {
  let text = input;

  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`[^`]+`/g, ' ');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/[*_~>]{1,3}/g, '');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) {
    return '';
  }

  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars);
    const lastStop = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('！'),
      cut.lastIndexOf('？'),
      cut.lastIndexOf('.'),
      cut.lastIndexOf('!'),
      cut.lastIndexOf('?')
    );
    text =
      (lastStop > 40 ? cut.slice(0, lastStop + 1) : cut).trim() + '……我就说到这里。';
  }

  return text;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function pickNestedText(payload: Record<string, unknown>): string | undefined {
  for (const key of ['data', 'result', 'payload', 'body']) {
    const nested = payload[key];
    if (nested && typeof nested === 'object') {
      const obj = nested as Record<string, unknown>;
      const t =
        pickString(obj.text) ||
        pickString(obj.message) ||
        pickString(obj.content);
      if (t) {
        return t;
      }
    }
  }
  return undefined;
}

function recoverTextFromRaw(raw: string): string | undefined {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) {
      return undefined;
    }
    const obj = JSON.parse(raw.slice(start, end + 1)) as Record<
      string,
      unknown
    >;
    return (
      pickString(obj.text) ||
      pickString(obj.message) ||
      pickString(obj.content) ||
      pickNestedText(obj)
    );
  } catch {
    const m = raw.match(/"text"\s*:\s*"((?:\\.|[^"\\])*)"/);
    if (m && m[1]) {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1];
      }
    }
    return undefined;
  }
}

/** Rough TTS duration when exact audio length is unknown. */
export function estimateSpeechMs(text: string, rate = 1): number {
  const chars = Array.from(text || '').length;
  if (!chars) {
    return 1200;
  }
  const chinese = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const other = Math.max(0, chars - chinese);
  const base = chinese * 210 + other * 75;
  const scaled = base / Math.max(0.7, rate || 1);
  return Math.max(1400, Math.min(120000, Math.round(scaled + 400)));
}
