/**
 * AI routes — thin, auth-protected proxy to the BAL-AI service.
 *
 * The browser calls THESE endpoints (with the user's session JWT); the server
 * holds the BAL-AI key and forwards to the LLM. The key is never sent to the
 * client. Inputs are length-capped to protect the per-key token budget.
 */
import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { rewriteText, suggestReplies, translateText, summarizeMeeting, SUPPORTED_TRANSLATE_LANGS, AIError, isAIConfigured, type ChatMessage } from './ai.service';

const router = Router();

const MAX_TEXT_CHARS = 4000;        // cap a single draft (rewrite)
const MAX_TRANSLATE_CHARS = 8000;   // emails can be longer than chat drafts
const MAX_TRANSCRIPT_CHARS = 48000; // ~12k tokens — safely within Qwen's 32k context
const MAX_CTX_MESSAGES = 8;         // recent turns fed to smart-reply
const MAX_CTX_CHARS = 1000;         // per-message cap

function handleError(res: Response, err: any) {
  const status = err instanceof AIError ? err.status : 500;
  res.status(status).json({ error: err?.message || 'AI error' });
}

// POST /api/ai/rewrite — { text, mode } → { result }
// mode ∈ formal | shorter | friendlier | grammar | professional
router.post('/rewrite', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAIConfigured()) return res.status(503).json({ error: 'AI is not configured' });
    const { text, mode } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_TEXT_CHARS) {
      return res.status(400).json({ error: `text too long (max ${MAX_TEXT_CHARS} chars)` });
    }
    const result = await rewriteText(text, typeof mode === 'string' ? mode : 'formal');
    res.json({ result });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/ai/suggest-replies — { messages: [{role, content}] } → { replies: string[] }
router.post('/suggest-replies', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAIConfigured()) return res.status(503).json({ error: 'AI is not configured' });
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages is required' });
    }
    const ctx: ChatMessage[] = messages
      .slice(-MAX_CTX_MESSAGES)
      .map((m: any) => ({
        role: (m?.role === 'assistant' ? 'assistant' : 'user') as ChatMessage['role'],
        content: String(m?.content ?? '').slice(0, MAX_CTX_CHARS),
      }))
      .filter((m) => m.content.trim());
    if (ctx.length === 0) return res.status(400).json({ error: 'no usable message content' });

    const replies = await suggestReplies(ctx);
    res.json({ replies });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/ai/translate — { text, targetLang } → { result }
// targetLang ∈ english | hindi | bengali | odia
router.post('/translate', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAIConfigured()) return res.status(503).json({ error: 'AI is not configured' });
    const { text, targetLang } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_TRANSLATE_CHARS) {
      return res.status(400).json({ error: `text too long (max ${MAX_TRANSLATE_CHARS} chars)` });
    }
    const lang = String(targetLang || '').toLowerCase();
    if (!SUPPORTED_TRANSLATE_LANGS.includes(lang)) {
      return res.status(400).json({ error: `unsupported target language: ${targetLang}` });
    }
    const result = await translateText(text, lang);
    res.json({ result });
  } catch (err) {
    handleError(res, err);
  }
});

// POST /api/ai/meeting-notes — { transcript, title?, attendees? } → { notes }
// notes = { summary, decisions[], actionItems[] }. The transcript-acquisition
// step (egress/Whisper) feeds this; this endpoint is the AI summarization stage.
router.post('/meeting-notes', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    if (!isAIConfigured()) return res.status(503).json({ error: 'AI is not configured' });
    const { transcript, title, attendees } = req.body || {};
    if (typeof transcript !== 'string' || !transcript.trim()) {
      return res.status(400).json({ error: 'transcript is required' });
    }
    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      // Very long meetings need map-reduce chunking (future enhancement).
      return res.status(413).json({ error: `transcript too long (max ${MAX_TRANSCRIPT_CHARS} chars for now)` });
    }
    const notes = await summarizeMeeting(transcript, {
      title: typeof title === 'string' ? title : undefined,
      attendees: Array.isArray(attendees) ? attendees.map(String) : undefined,
    });
    res.json({ notes });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
