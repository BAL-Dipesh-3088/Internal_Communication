/**
 * BAL-AI service — server-side wrapper around the on-premise, OpenAI-compatible
 * Qwen 3 LLM (https://chat.balasorealloys.in/v1).
 *
 * SECURITY: the API key lives ONLY here (read from env) and never reaches the
 * browser. All AI features proxy through our backend per BAL-AI's guide
 * ("Don't expose to browsers — always proxy via your own backend").
 *
 * Dependency-free: uses Node 18+ global fetch (no `openai` package needed).
 */

const BASE_URL = process.env.BAL_AI_BASE_URL || 'https://chat.balasorealloys.in/v1';
const API_KEY = process.env.BAL_AI_KEY || '';
const MODEL = process.env.BAL_AI_MODEL || 'qwen3-32b';
const TIMEOUT_MS = 30_000;

export type AIRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: AIRole;
  content: string;
}

/** Carries an HTTP status so the route can surface the right code to the client. */
export class AIError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AIError';
    this.status = status;
  }
}

export function isAIConfigured(): boolean {
  return !!API_KEY;
}

/**
 * Low-level chat completion. Returns the trimmed assistant text.
 * Thinking mode stays OFF (we never send /think) so short prompts return real
 * content immediately rather than spending the budget on reasoning.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  opts: { maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  if (!API_KEY) throw new AIError(503, 'AI is not configured on the server');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.5,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // Map upstream rate-limit / timeout so the client can react sensibly.
      const status = res.status === 429 ? 429 : res.status === 504 ? 504 : 502;
      throw new AIError(status, `AI request failed (${res.status}): ${body.slice(0, 200)}`);
    }

    const data: any = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new AIError(502, 'AI returned no content');
    return content.trim();
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new AIError(504, 'AI request timed out');
    if (err instanceof AIError) throw err;
    throw new AIError(502, `AI request error: ${err?.message || 'unknown'}`);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Rewrite / Smart Compose ────────────────────────────────────────────────

const REWRITE_INSTRUCTIONS: Record<string, string> = {
  formal: 'Rewrite the text in a professional, formal tone suitable for workplace communication.',
  shorter: 'Rewrite the text to be clear and concise, keeping every key point but removing filler.',
  friendlier: 'Rewrite the text in a warm, friendly, approachable tone while staying professional.',
  grammar: 'Correct spelling, grammar, and punctuation. Preserve the original meaning, tone, and language.',
  professional: 'Rewrite the text to be polished and professional for a business audience.',
};

export type RewriteMode = keyof typeof REWRITE_INSTRUCTIONS | string;

export async function rewriteText(text: string, mode: RewriteMode): Promise<string> {
  const instruction = REWRITE_INSTRUCTIONS[mode] || REWRITE_INSTRUCTIONS.formal;
  const system =
    `You are a writing assistant for Balasore Alloys employees. ${instruction} ` +
    `Return ONLY the rewritten text — no preamble, no surrounding quotes, no explanations, no markdown. ` +
    `If the input is already in another language, keep that same language.`;
  const out = await chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    { maxTokens: 700, temperature: mode === 'grammar' ? 0.2 : 0.5 },
  );
  // Strip wrapping quotes the model sometimes adds despite instructions.
  return out.replace(/^["“'']+|["”'']+$/g, '').trim();
}

// ─── Inline translation ─────────────────────────────────────────────────────

const LANG_NAMES: Record<string, string> = {
  english: 'English',
  hindi: 'Hindi',
  bengali: 'Bengali',
  odia: 'Odia (Oriya)',
};

export const SUPPORTED_TRANSLATE_LANGS = Object.keys(LANG_NAMES);

export async function translateText(text: string, targetLang: string): Promise<string> {
  const key = (targetLang || '').toLowerCase();
  const target = LANG_NAMES[key] || targetLang;
  const system =
    `You are a professional translator for an Indian industrial company. Translate the user's text into ${target}. ` +
    `Auto-detect the source language. Preserve the meaning, tone, names, numbers, URLs, and line breaks. ` +
    `Use the native script of the target language (Devanagari for Hindi, Bengali script for Bengali, Odia script for Odia). ` +
    `If the text is already entirely in ${target}, return it unchanged. ` +
    `Return ONLY the translated text — no preamble, no transliteration, no explanations, no surrounding quotes.`;
  const out = await chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ],
    { maxTokens: 1500, temperature: 0.2 },
  );
  return out.replace(/^["“'']+|["”'']+$/g, '').trim();
}

// ─── Meeting notes (transcript → summary / decisions / action items) ────────

export interface MeetingActionItem {
  task: string;
  owner: string;
  due: string;
}
export interface MeetingNotes {
  summary: string;
  decisions: string[];
  actionItems: MeetingActionItem[];
}

export async function summarizeMeeting(
  transcript: string,
  opts: { title?: string; attendees?: string[] } = {},
): Promise<MeetingNotes> {
  const header = [
    opts.title ? `Meeting title: ${opts.title}` : '',
    opts.attendees?.length ? `Attendees: ${opts.attendees.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  const system =
    `You are a meeting-notes assistant for Balasore Alloys. From the transcript, produce concise, accurate notes. ` +
    `Return ONLY a JSON object with exactly these keys: ` +
    `"summary" (string, 3-5 sentences), ` +
    `"decisions" (array of strings — concrete decisions made), ` +
    `"action_items" (array of objects each with "task", "owner", "due"; owner/due are empty strings if not stated). ` +
    `Attribute owners only when the transcript makes it clear. Do NOT invent facts. ` +
    `No preamble, no markdown, no code fences — just the JSON object.`;
  const user = `${header ? header + '\n\n' : ''}Transcript:\n${transcript}`;

  const raw = await chatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { maxTokens: 1200, temperature: 0.3 },
  );

  let obj: any = {};
  try {
    const m = raw.match(/\{[\s\S]*\}/); // tolerate accidental code-fence wrapping
    obj = JSON.parse(m ? m[0] : raw);
  } catch {
    obj = {};
  }
  return {
    summary: typeof obj.summary === 'string' ? obj.summary.trim() : '',
    decisions: Array.isArray(obj.decisions)
      ? obj.decisions.filter((d: any) => typeof d === 'string' && d.trim()).map((d: string) => d.trim())
      : [],
    actionItems: Array.isArray(obj.action_items)
      ? obj.action_items
          .map((a: any) => ({
            task: String(a?.task ?? '').trim(),
            owner: String(a?.owner ?? '').trim(),
            due: String(a?.due ?? '').trim(),
          }))
          .filter((a: MeetingActionItem) => a.task)
      : [],
  };
}

// ─── Smart quick replies ────────────────────────────────────────────────────

export async function suggestReplies(context: ChatMessage[]): Promise<string[]> {
  const system =
    `You suggest 3 short, distinct quick replies the current user could send next in a workplace chat. ` +
    `Each reply must be a single short sentence, natural and ready to send as-is. Vary them (e.g. an affirmative, ` +
    `a clarifying question, a deferral). Return ONLY a JSON array of exactly 3 strings and nothing else. ` +
    `Example: ["Sure, that works for me.","Let me check and get back to you.","Can we discuss this on a quick call?"]`;
  const raw = await chatCompletion(
    [{ role: 'system', content: system }, ...context],
    { maxTokens: 200, temperature: 0.7 },
  );

  // Primary: parse the JSON array. Fallback: split lines & strip bullets/numbers.
  let replies: string[] = [];
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    const parsed = JSON.parse(match ? match[0] : raw);
    if (Array.isArray(parsed)) replies = parsed;
  } catch {
    replies = raw
      .split('\n')
      .map((l) => l.replace(/^[-*\d.)\s"'']+/, '').replace(/["'']+$/, '').trim())
      .filter(Boolean);
  }
  return replies
    .filter((r) => typeof r === 'string' && r.trim())
    .map((r) => r.trim())
    .slice(0, 3);
}
