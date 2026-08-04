import * as fs from 'fs';

/**
 * Read the latest assistant plain text from a Cursor agent transcript (.jsonl).
 * This avoids Windows hook stdin corrupting non-ASCII (known Cursor bug).
 */
export function readLastAssistantText(
  transcriptPath: string | undefined | null
): string | undefined {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return undefined;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    let obj: unknown;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const text = extractAssistantLine(obj);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function extractAssistantLine(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object') {
    return undefined;
  }
  const rec = obj as Record<string, unknown>;

  // Format A: { role: "assistant", message: { content: [...] } }
  if (rec.role === 'assistant') {
    const fromMessage = flattenContent(
      (rec.message as Record<string, unknown> | undefined)?.content ??
        rec.content
    );
    if (fromMessage) {
      return fromMessage;
    }
  }

  // Format B: nested message.role
  const message = rec.message as Record<string, unknown> | undefined;
  if (message && message.role === 'assistant') {
    const fromMessage = flattenContent(message.content);
    if (fromMessage) {
      return fromMessage;
    }
  }

  return undefined;
}

function flattenContent(content: unknown): string | undefined {
  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (rec.type === 'text' && typeof rec.text === 'string') {
      parts.push(rec.text);
    } else if (typeof rec.text === 'string') {
      parts.push(rec.text);
    }
  }
  const joined = parts.join('\n').trim();
  return joined || undefined;
}

/**
 * Detect / repair common Windows hook mojibake for Chinese.
 * Prefer transcript text when available; this is only a fallback.
 */
export function looksCorruptedChinese(text: string): boolean {
  if (!text) {
    return false;
  }
  // Replacement chars
  if (text.includes('\uFFFD') || text.includes('?？?')) {
    return true;
  }
  // Typical mojibake markers from UTF-8 read as Latin1/CP1252
  if (/[ÃÂåäæçèéêëì]/.test(text) && !/[\u4e00-\u9fff]{2,}/.test(text)) {
    return true;
  }
  // Mixed: has CJK punctuation but nonsense CJK from wrong decode
  // e.g. "Hello！" + rare/garbled chars
  const cjk = text.match(/[\u4e00-\u9fff]/g) || [];
  if (cjk.length >= 2) {
    // High ratio of rare/compatibility ideographs often means mojibake
    const rare = cjk.filter((ch) => {
      const code = ch.codePointAt(0)!;
      return code >= 0x3400 && code <= 0x4dbf; // Extension A, uncommon in normal chat
    }).length;
    if (rare / cjk.length > 0.4) {
      return true;
    }
  }
  return false;
}

export function tryRepairHookText(text: string): string {
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    if (
      /[\u4e00-\u9fff]/.test(repaired) &&
      (!/[\u4e00-\u9fff]/.test(text) || looksCorruptedChinese(text))
    ) {
      return repaired;
    }
  } catch {
    // ignore
  }
  return text;
}
