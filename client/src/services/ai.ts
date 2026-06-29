/**
 * AI client — calls OUR backend (/api/ai/*), which proxies to the on-premise
 * BAL-AI LLM. The browser never sees the API key (it lives in server/.env).
 */
import api from './api';

export type RewriteMode = 'formal' | 'shorter' | 'friendlier' | 'grammar' | 'professional';

export const REWRITE_MODES: { mode: RewriteMode; label: string }[] = [
  { mode: 'formal', label: 'Make formal' },
  { mode: 'shorter', label: 'Make shorter' },
  { mode: 'friendlier', label: 'Make friendlier' },
  { mode: 'grammar', label: 'Fix grammar' },
];

/** Rewrite a draft in the requested style. Returns the rewritten text. */
export async function aiRewrite(text: string, mode: RewriteMode): Promise<string> {
  const { data } = await api.post('/ai/rewrite', { text, mode });
  return (data?.result ?? '') as string;
}

/** Suggest up to 3 short quick replies for a recent conversation context. */
export async function aiSuggestReplies(
  messages: { role: 'user' | 'assistant'; content: string }[],
): Promise<string[]> {
  const { data } = await api.post('/ai/suggest-replies', { messages });
  return (data?.replies ?? []) as string[];
}

// ── Inline translation ──────────────────────────────────────────────────────

export type TranslateLang = 'english' | 'hindi' | 'bengali' | 'odia';

/** Target languages, labelled with their native script (for a multilingual UI). */
export const TRANSLATE_LANGS: { lang: TranslateLang; label: string; native: string }[] = [
  { lang: 'odia', label: 'Odia', native: 'ଓଡ଼ିଆ' },
  { lang: 'hindi', label: 'Hindi', native: 'हिन्दी' },
  { lang: 'bengali', label: 'Bengali', native: 'বাংলা' },
  { lang: 'english', label: 'English', native: 'English' },
];

/** Translate text into the target language (source auto-detected). */
export async function aiTranslate(text: string, targetLang: TranslateLang): Promise<string> {
  const { data } = await api.post('/ai/translate', { text, targetLang });
  return (data?.result ?? '') as string;
}
