import { Router, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { query } from '../../database/connection';
import { sendEmail, resolveUserMailCredential } from './email.service';
import { fetchEmails, testImapConnection, fetchImapAttachment, fetchThreadByMessageIds, markEmailSeen } from './imap.service';
import { getIO } from '../../services/socket.service';

const EMAIL_ATTACH_DIR = path.resolve(process.env.UPLOAD_DIR || '../data', 'email-attachments');

const router = Router();
router.use(authMiddleware);

// Multer for email attachments (in-memory, max 25MB total)
const emailUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ─── SEND ────────────────────────────────────────────────

// POST /api/email/send — Send email via SMTP (supports JSON or multipart with attachments)
router.post('/send', emailUpload.array('attachments', 10), async (req: AuthRequest, res: Response) => {
  try {
    // Handle both JSON body and FormData (multipart)
    const isMultipart = req.is('multipart/form-data');
    const to = isMultipart ? JSON.parse(req.body.to || '[]') : req.body.to;
    const cc = isMultipart ? (req.body.cc ? JSON.parse(req.body.cc) : undefined) : req.body.cc;
    const bcc = isMultipart ? (req.body.bcc ? JSON.parse(req.body.bcc) : undefined) : req.body.bcc;
    const subject = req.body.subject;
    const html = req.body.html;
    const text = req.body.text;
    const replyTo = req.body.replyTo;
    const draftId = req.body.draftId;
    // Threading headers for reply emails
    const inReplyTo = req.body.inReplyTo;
    const references = isMultipart
      ? (req.body.references ? JSON.parse(req.body.references) : undefined)
      : req.body.references;

    console.log(`[SEND] from=${req.user!.userId} to=${JSON.stringify(to)} subject="${subject}" inReplyTo=${inReplyTo || 'NONE'} references=${references ? JSON.stringify(references) : 'NONE'} isMultipart=${isMultipart}`);

    // Process file attachments from multer
    const files = (req.files as Express.Multer.File[]) || [];
    const emailAttachments = files.map(f => ({
      filename: f.originalname,
      content: f.buffer,
      contentType: f.mimetype,
    }));

    if (!to || (Array.isArray(to) && to.length === 0)) {
      return res.status(400).json({ error: 'At least one recipient (to) is required' });
    }
    if (!subject?.trim()) {
      return res.status(400).json({ error: 'Subject is required' });
    }

    // Get sender's email, name, and mail_password (encrypted preferred, plaintext fallback)
    const sender = await resolveUserMailCredential(req.user!.userId);
    const senderEmail = sender.email;
    const senderName = sender.displayName;
    const mailPassword = sender.mailPassword;

    // All emails sent directly through Stalwart as the actual sender
    let finalHtml = html || undefined;
    if (false) {
      // Banner removed — no longer using Office 365 relay
    }

    const result = await sendEmail({
      to, cc: cc || undefined, bcc: bcc || undefined, subject,
      html: finalHtml,
      text: text || html?.replace(/<[^>]*>/g, '') || '',
      replyTo: replyTo || undefined,
      fromEmail: senderEmail,
      fromName: senderName,
      mailPassword,
      attachments: emailAttachments.length > 0 ? emailAttachments : undefined,
      inReplyTo: inReplyTo || undefined,
      references: references || undefined,
    });

    // Save attachments to disk and build metadata
    const attachmentMeta: Array<{ id: string; name: string; size: number; contentType: string }> = [];
    if (files.length > 0) {
      if (!fs.existsSync(EMAIL_ATTACH_DIR)) fs.mkdirSync(EMAIL_ATTACH_DIR, { recursive: true });
      for (const file of files) {
        const fileId = randomUUID();
        const ext = path.extname(file.originalname) || '';
        const savedName = `${fileId}${ext}`;
        fs.writeFileSync(path.join(EMAIL_ATTACH_DIR, savedName), file.buffer);
        attachmentMeta.push({ id: fileId, name: file.originalname, size: file.size, contentType: file.mimetype });
      }
    }
    const attachJson = JSON.stringify(attachmentMeta);

    // Threading info to store with the email
    const referencesStr = references && Array.isArray(references) && references.length > 0
      ? references.join(' ')
      : (typeof references === 'string' && references ? references : null);

    // If sending a draft, update it to 'sent'; otherwise insert new
    if (draftId) {
      await query(
        `UPDATE sent_emails SET to_addresses=$1, cc_addresses=$2, bcc_addresses=$3, subject=$4, html_body=$5, text_body=$6, message_id=$7, status='sent', attachments=$10, in_reply_to=$11, email_references=$12, created_at=NOW()
         WHERE id=$8 AND user_id=$9`,
        [
          JSON.stringify(Array.isArray(to) ? to : [to]),
          JSON.stringify(cc || []),
          JSON.stringify(bcc || []),
          subject, html || null, text || html?.replace(/<[^>]*>/g, '') || null,
          result.messageId, draftId, req.user!.userId, attachJson,
          inReplyTo || null, referencesStr,
        ]
      );
    } else {
      await query(
        `INSERT INTO sent_emails (user_id, to_addresses, cc_addresses, bcc_addresses, subject, html_body, text_body, message_id, status, attachments, in_reply_to, email_references)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'sent', $9, $10, $11)`,
        [
          req.user!.userId,
          JSON.stringify(Array.isArray(to) ? to : [to]),
          JSON.stringify(cc || []), JSON.stringify(bcc || []),
          subject, html || null, text || html?.replace(/<[^>]*>/g, '') || null,
          result.messageId, attachJson,
          inReplyTo || null, referencesStr,
        ]
      );
    }

    // DIAGNOSTIC: verify what we just stored in DB
    const verify = await query(
      'SELECT id, message_id FROM sent_emails WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [req.user!.userId],
    );
    if (verify.rows[0]) {
      console.log(`[SEND-VERIFY] Stored sent_email id=${verify.rows[0].id} message_id="${verify.rows[0].message_id}" (result.messageId we received was "${result.messageId}")`);
    }

    // Real-time INTERNAL mail push (item 4 — zero extra IMAP polling):
    // If any recipient is an internal ICP user, invalidate their cached inbox
    // and emit 'mail:new' so their client refreshes immediately and sees this
    // mail near-instantly. External recipients are unaffected (normal poll).
    try {
      const recipientEmails = [
        ...(Array.isArray(to) ? to : [to]),
        ...(Array.isArray(cc) ? cc : cc ? [cc] : []),
        ...(Array.isArray(bcc) ? bcc : bcc ? [bcc] : []),
      ].map((e: any) => String(e || '').trim().toLowerCase()).filter(Boolean);

      if (recipientEmails.length > 0) {
        const internal = await query(
          'SELECT id FROM users WHERE lower(email) = ANY($1)',
          [recipientEmails],
        );
        const io = getIO();
        for (const row of internal.rows) {
          inboxCache.delete(`${row.id}:INBOX`);          // force a fresh fetch
          io.to(`user:${row.id}`).emit('mail:new');      // nudge their client to refresh
        }
      }
    } catch (e) { /* push is best-effort; the email already sent fine */ }

    res.json({ success: true, messageId: result.messageId, accepted: result.accepted });
  } catch (err: any) {
    console.error('[EMAIL] Send failed:', err.message);
    res.status(500).json({ error: 'Failed to send email: ' + err.message });
  }
});

// ─── SENT ITEMS ──────────────────────────────────────────

router.get('/sent', async (req: AuthRequest, res: Response) => {
  try {
    const { limit = '50', offset = '0' } = req.query;
    const result = await query(
      `SELECT id, to_addresses, cc_addresses, bcc_addresses, subject, html_body, text_body, message_id, status, created_at, attachments
       FROM sent_emails WHERE user_id = $1 AND status = 'sent'
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [req.user!.userId, parseInt(limit as string), parseInt(offset as string)]
    );
    const count = await query(`SELECT COUNT(*) FROM sent_emails WHERE user_id = $1 AND status = 'sent'`, [req.user!.userId]);
    res.json({ emails: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DRAFTS ──────────────────────────────────────────────

router.post('/draft', async (req: AuthRequest, res: Response) => {
  try {
    const { to, cc, bcc, subject, html } = req.body;
    const result = await query(
      `INSERT INTO sent_emails (user_id, to_addresses, cc_addresses, bcc_addresses, subject, html_body, text_body, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft') RETURNING id, created_at`,
      [
        req.user!.userId,
        JSON.stringify(to || []), JSON.stringify(cc || []), JSON.stringify(bcc || []),
        subject || '(No subject)', html || null, html?.replace(/<[^>]*>/g, '') || null,
      ]
    );
    res.json({ success: true, draft: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/draft/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { to, cc, bcc, subject, html } = req.body;
    await query(
      `UPDATE sent_emails SET to_addresses=$1, cc_addresses=$2, bcc_addresses=$3, subject=$4, html_body=$5, text_body=$6
       WHERE id=$7 AND user_id=$8 AND status='draft'`,
      [
        JSON.stringify(to || []), JSON.stringify(cc || []), JSON.stringify(bcc || []),
        subject || '(No subject)', html || null, html?.replace(/<[^>]*>/g, '') || null,
        req.params.id, req.user!.userId,
      ]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/drafts', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, to_addresses, cc_addresses, bcc_addresses, subject, html_body, text_body, created_at
       FROM sent_emails WHERE user_id = $1 AND status = 'draft'
       ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    res.json({ emails: result.rows, total: result.rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE / RESTORE ────────────────────────────────────

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    await query(
      `UPDATE sent_emails SET status = 'deleted' WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user!.userId]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id/restore', async (req: AuthRequest, res: Response) => {
  try {
    await query(
      `UPDATE sent_emails SET status = 'sent' WHERE id = $1 AND user_id = $2 AND status = 'deleted'`,
      [req.params.id, req.user!.userId]
    );
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/deleted', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT id, to_addresses, cc_addresses, bcc_addresses, subject, html_body, text_body, created_at
       FROM sent_emails WHERE user_id = $1 AND status = 'deleted'
       ORDER BY created_at DESC`,
      [req.user!.userId]
    );
    res.json({ emails: result.rows, total: result.rows.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── FOLDER COUNTS ───────────────────────────────────────

router.get('/counts', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT status, COUNT(*) as count FROM sent_emails WHERE user_id = $1 GROUP BY status`,
      [req.user!.userId]
    );
    const counts: Record<string, number> = { sent: 0, draft: 0, deleted: 0 };
    result.rows.forEach((r: any) => { counts[r.status] = parseInt(r.count); });
    res.json(counts);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ATTACHMENT DOWNLOAD ─────────────────────────────────

router.get('/attachment/:fileId', async (req: AuthRequest, res: Response) => {
  try {
    const { fileId } = req.params;
    const { name } = req.query;

    // Find the file on disk
    const files = fs.readdirSync(EMAIL_ATTACH_DIR);
    const match = files.find(f => f.startsWith(fileId as string));
    if (!match) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const filePath = path.join(EMAIL_ATTACH_DIR, match);
    const fileName = (name as string) || match;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.sendFile(filePath);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── IMAP ATTACHMENT DOWNLOAD ─────────────────────────────

router.get('/imap-attachment/:uid/:index', async (req: AuthRequest, res: Response) => {
  try {
    const uid = parseInt(req.params.uid as string);
    const index = parseInt(req.params.index as string);
    const cred = await resolveUserMailCredential(req.user!.userId);
    const userLogin = cred.loginName;
    const mailPass = cred.mailPassword;

    const folder = req.query.folder ? String(req.query.folder) : undefined;
    const att = await fetchImapAttachment(uid, index, userLogin, mailPass, folder);
    if (!att) return res.status(404).json({ error: 'Attachment not found' });

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(att.filename)}"`);
    res.setHeader('Content-Type', att.contentType);
    res.send(att.content);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CONTACTS (company directory for autocomplete) ───────

router.get('/contacts', async (req: AuthRequest, res: Response) => {
  try {
    const { q = '' } = req.query;
    const search = `%${(q as string).toLowerCase()}%`;
    const result = await query(
      `SELECT id, display_name, email, department, designation, avatar_url
       FROM users
       WHERE is_active = true
         AND ($1 = '%%' OR LOWER(display_name) LIKE $1 OR LOWER(email) LIKE $1)
       ORDER BY display_name ASC
       LIMIT 500`,
      [search]
    );
    res.json({ contacts: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SMTP TEST ───────────────────────────────────────────

router.get('/test', async (_req: AuthRequest, res: Response) => {
  try {
    const { getTransporter } = require('./email.service');
    await getTransporter().verify();
    res.json({ status: 'ok', host: process.env.SMTP_HOST, user: process.env.SMTP_USER });
  } catch (err: any) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── IMAP (per-user inbox from Stalwart) ─────────────────

// Per-user inbox cache. Two jobs:
//   1. COLLAPSE LOAD — the unread-badge poller AND the open Email window both
//      poll /inbox; with many users that's a flood of IMAP connections that
//      can trip Stalwart's fail2ban. Within FRESH_MS we serve the cached copy
//      and open ZERO connections.
//   2. RESILIENCE — if an IMAP fetch fails (transient block, Stalwart restart),
//      we serve the last-known-good inbox instead of a 500/blank screen.
interface InboxCacheEntry { emails: any[]; account: string; ts: number; }
const inboxCache = new Map<string, InboxCacheEntry>();
const INBOX_CACHE_FRESH_MS = 25_000; // serve cached without re-fetching within this window

router.get('/inbox', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const { folder = 'INBOX', limit = '200' } = req.query;
  const cacheKey = `${userId}:${folder}`;
  const cached = inboxCache.get(cacheKey);

  // Fresh cache hit → no IMAP connection at all.
  if (cached && Date.now() - cached.ts < INBOX_CACHE_FRESH_MS) {
    return res.json({ emails: cached.emails, total: cached.emails.length, folder, account: cached.account, cached: true });
  }

  try {
    const cred = await resolveUserMailCredential(userId);
    const emails = await fetchEmails(folder as string, parseInt(limit as string), cred.loginName, cred.mailPassword);
    inboxCache.set(cacheKey, { emails, account: cred.email, ts: Date.now() });
    res.json({ emails, total: emails.length, folder, account: cred.email });
  } catch (err: any) {
    console.error('[EMAIL] Inbox fetch error:', err.message);
    // Resilience: serve the last-known-good inbox rather than blanking the UI
    // when IMAP is briefly unavailable (Stalwart restart / transient block).
    if (cached) {
      return res.json({ emails: cached.emails, total: cached.emails.length, folder, account: cached.account, cached: true, stale: true });
    }
    res.status(500).json({ error: 'Inbox not available — ' + err.message });
  }
});

// POST /api/email/inbox/:uid/seen — mark a message read on Stalwart (persistent \Seen flag)
// This is the REAL read-state: survives logout, other browsers, and devices —
// unlike the client localStorage cache which is only an instant-UI optimisation.
router.post('/inbox/:uid/seen', async (req: AuthRequest, res: Response) => {
  try {
    const uid = parseInt(String(req.params.uid), 10);
    if (!uid || Number.isNaN(uid)) return res.status(400).json({ error: 'invalid uid' });
    const cred = await resolveUserMailCredential(req.user!.userId);
    await markEmailSeen(uid, 'INBOX', cred.loginName, cred.mailPassword);

    // Keep the inbox cache consistent so the badge poll within the cache window
    // reflects the new read state immediately (otherwise it'd re-show unread for ~25s).
    const cached = inboxCache.get(`${req.user!.userId}:INBOX`);
    if (cached) {
      const m = cached.emails.find((e: any) => String(e.uid) === String(uid) || String(e.id) === String(uid));
      if (m) m.isRead = true;
    }
    res.json({ ok: true });
  } catch (err: any) {
    console.error('[EMAIL] mark-seen error:', err.message);
    res.status(500).json({ error: 'Failed to mark read — ' + err.message });
  }
});

/**
 * GET /api/email/thread?messageIds=id1,id2,...
 *
 * Fetches parent emails in a thread by their EXACT Message-IDs.
 * Uses References / In-Reply-To headers — never subject search.
 *
 * Two-tier lookup (the same pattern Outlook + Exchange use):
 *   1. IMAP search across INBOX + Sent folders — finds emails in the user's mailbox
 *   2. DB fallback (sent_emails table) — finds emails sent via BAL Connect that
 *      weren't APPENDed to IMAP Sent folder (e.g., before the APPEND fix was deployed)
 *
 * Results are merged + deduplicated by Message-ID, sorted oldest-first.
 */
function normalizeMsgId(id: string | undefined | null): string {
  if (!id) return '';
  return id.replace(/^<|>$/g, '').trim().toLowerCase();
}

router.get('/thread', async (req: AuthRequest, res: Response) => {
  try {
    const raw = String(req.query.messageIds || '');
    const currentMsgId = String(req.query.currentMessageId || '');

    const cred = await resolveUserMailCredential(req.user!.userId);
    const currentUserEmail = (cred.email || '').toLowerCase();

    // Build the full set of Message-IDs to look up:
    // 1. The ones explicitly provided (from References / In-Reply-To headers on current email)
    // 2. Reverse lookup: if current email is in sent_emails, get its stored references
    // 3. Forward lookup: find any DB email that references current email (e.g., parent of a reply chain)
    let messageIds: string[] = raw ? raw.split(',').map(id => id.trim()).filter(Boolean) : [];

    console.log(`[THREAD] User ${req.user!.userId} (${currentUserEmail}) — initial Message-IDs:`, messageIds);
    console.log(`[THREAD] currentMessageId from frontend:`, currentMsgId);

    // ── Reverse lookup: find current email in sent_emails table and use its stored references ──
    if (currentMsgId) {
      const candidates = [currentMsgId, currentMsgId.replace(/^<|>$/g, ''), `<${currentMsgId.replace(/^<|>$/g, '')}>`];
      const dbCurrent = await query(
        `SELECT in_reply_to, email_references FROM sent_emails
          WHERE message_id = ANY($1) LIMIT 1`,
        [candidates],
      );
      if (dbCurrent.rows.length > 0) {
        const row = dbCurrent.rows[0];
        console.log(`[THREAD] Current email found in DB. in_reply_to=${row.in_reply_to}, email_references=${row.email_references}`);
        if (row.in_reply_to) messageIds.push(row.in_reply_to);
        if (row.email_references) {
          for (const ref of row.email_references.split(/\s+/).filter(Boolean)) {
            messageIds.push(ref);
          }
        }
      }
    }

    // Deduplicate
    messageIds = Array.from(new Set(messageIds));

    if (messageIds.length === 0) {
      console.log('[THREAD] No Message-IDs to look up — returning empty');
      return res.json({ emails: [] });
    }

    console.log(`[THREAD] Full Message-IDs to search:`, messageIds);

    // ── Tier 1: IMAP search across INBOX + Sent + other folders ──
    const imapEmails = await fetchThreadByMessageIds(messageIds, cred.loginName, cred.mailPassword);
    const foundIds = new Set(imapEmails.map(e => normalizeMsgId(e.messageId)).filter(Boolean));
    console.log(`[THREAD] IMAP found ${imapEmails.length} emails. Message-IDs:`, [...foundIds]);

    // ── Tier 2: DB fallback for any Message-IDs not found in IMAP ──
    // Searches ALL users' sent_emails (not just current user's), because the original
    // email could have been sent by ANY participant in the thread. Authorization is
    // enforced per-row by verifying current user is sender OR recipient.
    const missingIds = messageIds.filter(id => !foundIds.has(normalizeMsgId(id)));

    if (missingIds.length > 0) {
      // Build candidate Message-ID forms (with and without <> brackets)
      const candidates: string[] = [];
      for (const id of missingIds) {
        const clean = id.replace(/^<|>$/g, '');
        if (id) candidates.push(id);                  // as-is
        if (clean) candidates.push(clean);            // stripped
        if (clean) candidates.push(`<${clean}>`);     // re-bracketed
      }

      // DIAGNOSTIC: dump all recent sent_emails Message-IDs so we can see EXACTLY what's stored
      const recentSent = await query(
        `SELECT id, user_id, subject, message_id, LENGTH(message_id) as msgid_len
           FROM sent_emails WHERE status = 'sent'
           ORDER BY created_at DESC LIMIT 10`,
      );
      console.log(`[THREAD] DB diagnostic — recent 10 sent_emails:`);
      for (const row of recentSent.rows) {
        console.log(`  id=${row.id} subject="${row.subject}" msgid="${row.message_id}" (len=${row.msgid_len})`);
      }
      console.log(`[THREAD] DB query candidates (looking for these exact values):`, candidates);

      // Robust lookup: try exact match AND LIKE patterns to handle bracket inconsistencies
      // Build OR conditions: message_id = ANY(candidates) OR message_id LIKE '%bare-id%'
      const bareIds = missingIds.map(id => id.replace(/^<|>$/g, '')).filter(Boolean);
      const likePatterns = bareIds.map(id => `%${id}%`);

      const dbResult = await query(
        `SELECT se.id, se.user_id, se.to_addresses, se.cc_addresses, se.bcc_addresses,
                se.subject, se.html_body, se.text_body, se.message_id, se.created_at,
                se.attachments,
                u.email AS sender_email, u.display_name AS sender_name
           FROM sent_emails se
           JOIN users u ON u.id = se.user_id
          WHERE se.status = 'sent'
            AND (se.message_id = ANY($1) OR se.message_id ILIKE ANY($2))`,
        [candidates, likePatterns],
      );

      console.log(`[THREAD] DB found ${dbResult.rows.length} candidate sent_emails for missing IDs:`, missingIds);

      const parseField = (v: any): any[] => {
        if (!v) return [];
        if (Array.isArray(v)) return v;
        try { return JSON.parse(v); } catch { return []; }
      };

      for (const row of dbResult.rows) {
        if (foundIds.has(normalizeMsgId(row.message_id))) continue; // dedupe

        const to = parseField(row.to_addresses).map((s: any) => String(s).toLowerCase());
        const cc = parseField(row.cc_addresses).map((s: any) => String(s).toLowerCase());
        const bcc = parseField(row.bcc_addresses).map((s: any) => String(s).toLowerCase());

        // ── Authorization: current user must be sender OR a recipient ──
        const isSender = row.user_id === req.user!.userId;
        const isRecipient = currentUserEmail && (
          to.includes(currentUserEmail) ||
          cc.includes(currentUserEmail) ||
          bcc.includes(currentUserEmail)
        );

        if (!isSender && !isRecipient) {
          console.log(`[THREAD] Skipping ${row.message_id} — user is not sender or recipient`);
          continue;
        }

        const attachments = parseField(row.attachments);
        // DB attachments use {id, name, size, contentType} format —
        // frontend downloads via /email/attachment/:fileId (already handled).

        imapEmails.push({
          id: `db-${row.id}`,
          uid: 0,
          from: row.sender_name || row.sender_email || 'Unknown',
          fromEmail: row.sender_email || '',
          to: parseField(row.to_addresses) as string[],
          cc: parseField(row.cc_addresses) as string[],
          subject: row.subject || '(No subject)',
          preview: (row.text_body || '').toString().substring(0, 120).replace(/\n/g, ' '),
          body: row.html_body || '',
          date: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
          isRead: true,
          isStarred: false,
          attachments: attachments as any,
          messageId: row.message_id,
        });
        foundIds.add(normalizeMsgId(row.message_id));
        console.log(`[THREAD] Added DB email ${row.message_id} from ${row.sender_email} with ${attachments.length} attachments`);
      }
    }

    // Sort oldest-first for natural conversation order
    imapEmails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    console.log(`[THREAD] Returning ${imapEmails.length} total emails`);
    res.json({ emails: imapEmails });
  } catch (err: any) {
    console.error('[EMAIL] Thread fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

router.get('/imap-test', async (_req: AuthRequest, res: Response) => {
  try {
    const ok = await testImapConnection();
    res.json({ status: ok ? 'ok' : 'error', host: process.env.IMAP_HOST, user: process.env.IMAP_USER });
  } catch (err: any) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── PINS (Outlook-style "keep at top of folder") ─────────────────
// Per-user, server-persisted so pins survive refreshes and follow the
// user across machines. `email_key` = inbox IMAP UID or sent_emails UUID.

// GET /api/email/pins — all pinned email keys for the current user
router.get('/pins', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      'SELECT email_key FROM email_pins WHERE user_id = $1 ORDER BY pinned_at DESC',
      [req.user!.userId],
    );
    res.json({ pins: result.rows.map((r: any) => r.email_key) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/email/pins — pin a message. Body: { emailKey }
router.post('/pins', async (req: AuthRequest, res: Response) => {
  try {
    const emailKey = String(req.body?.emailKey || '').trim();
    if (!emailKey) return res.status(400).json({ error: 'emailKey required' });
    if (emailKey.length > 512) return res.status(400).json({ error: 'emailKey too long' });
    await query(
      `INSERT INTO email_pins (user_id, email_key) VALUES ($1, $2)
       ON CONFLICT (user_id, email_key) DO UPDATE SET pinned_at = NOW()`,
      [req.user!.userId, emailKey],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/email/pins/:emailKey — unpin a message
router.delete('/pins/:emailKey', async (req: AuthRequest, res: Response) => {
  try {
    const emailKey = String(req.params.emailKey || '').trim();
    if (!emailKey) return res.status(400).json({ error: 'emailKey required' });
    await query(
      'DELETE FROM email_pins WHERE user_id = $1 AND email_key = $2',
      [req.user!.userId, emailKey],
    );
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
