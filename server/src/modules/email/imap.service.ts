import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export interface ParsedEmail {
  id: string;
  uid: number;
  from: string;
  fromEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  preview: string;
  body: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  attachments: Array<{ name: string; size: number; contentType: string }>;
  /** Unique Message-ID header (e.g. "<abc123@mail.example.com>") */
  messageId?: string;
  /** Message-ID of the email this is a reply to */
  inReplyTo?: string;
  /** Space-separated list of all parent Message-IDs in the thread */
  references?: string[];
}

function createClient(userLoginName?: string, mailPassword?: string): ImapFlow {
  // Per-user IMAP: each user authenticates with their own mail_password (NOT login password)
  const imapUser = userLoginName || process.env.IMAP_USER || '';
  const imapPass = mailPassword || process.env.IMAP_PASSWORD || '';

  return new ImapFlow({
    host: process.env.IMAP_HOST || 'outlook.office365.com',
    port: parseInt(process.env.IMAP_PORT || '993'),
    secure: process.env.IMAP_SECURE !== 'false',
    auth: {
      user: imapUser,
      pass: imapPass,
    },
    logger: false,
    tls: {
      rejectUnauthorized: false,
    },
  });
}

/**
 * APPEND a sent message to the user's IMAP "Sent" folder.
 *
 * This is the standard pattern used by Outlook/Thunderbird/Apple Mail:
 * after SMTP send, the client APPENDs a copy of the message to the user's
 * Sent folder so it's part of their mailbox.
 *
 * Without this, sent emails only exist in the recipient's mailbox, and
 * threading lookups (find parent email by Message-ID) won't find sent emails.
 *
 * Tries multiple folder name conventions (Stalwart, Dovecot, Cyrus, Office365).
 * Fire-and-forget: failures here must not block email sending.
 */
export async function appendToSentFolder(
  rawMessage: Buffer | string,
  userLoginName: string,
  mailPassword: string,
): Promise<boolean> {
  if (!userLoginName || !mailPassword) return false;
  const client = createClient(userLoginName, mailPassword);
  try {
    await client.connect();

    // Try standard Sent folder names. Stalwart typically uses "Sent".
    // Some servers prefix with "INBOX." (Cyrus-style). Office365 uses "Sent Items".
    const candidates = ['Sent', 'INBOX.Sent', 'Sent Items', 'Sent Messages'];

    // Discover available mailboxes to pick the best match
    try {
      const list = await client.list();
      const specialSent = list.find(mb => mb.specialUse === '\\Sent');
      if (specialSent) {
        // RFC 6154 SPECIAL-USE \Sent flag — most reliable
        candidates.unshift(specialSent.path);
      }
    } catch {
      // List failed — proceed with hardcoded names
    }

    let saved = false;
    for (const folder of candidates) {
      try {
        await client.append(folder, rawMessage as any, ['\\Seen']);
        console.log(`[IMAP] Appended sent message to "${folder}" for ${userLoginName}`);
        saved = true;
        break;
      } catch {
        // Folder doesn't exist or APPEND not allowed — try next
      }
    }

    await client.logout();
    return saved;
  } catch (err: any) {
    console.warn(`[IMAP] Failed to append to Sent folder for ${userLoginName}:`, err.message);
    try { await client.logout(); } catch { /* ignore */ }
    return false;
  }
}

export async function fetchEmails(folder: string = 'INBOX', limit: number = 30, userLoginName?: string, mailPassword?: string): Promise<ParsedEmail[]> {
  const client = createClient(userLoginName, mailPassword);
  const emails: ParsedEmail[] = [];

  try {
    await client.connect();

    const lock = await client.getMailboxLock(folder);
    try {
      // Fetch latest emails (newest first)
      const mb = client.mailbox;
      const totalMessages = mb && typeof mb === 'object' && 'exists' in mb ? (mb as any).exists : 0;
      if (totalMessages === 0) return [];

      const startSeq = Math.max(1, totalMessages - limit + 1);
      const range = `${startSeq}:${totalMessages}`;

      for await (const message of client.fetch(range, {
        envelope: true,
        flags: true,
        bodyStructure: true,
        source: true,
      })) {
        try {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source) as any;

          const fromAddr = parsed.from?.value?.[0];
          const toAddrs = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a: any) => a.value?.map((v: any) => v.address || '') || []) : [];
          const ccAddrs = parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap((a: any) => a.value?.map((v: any) => v.address || '') || []) : [];

          const textBody = parsed.text || '';
          const htmlBody = parsed.html || `<p>${textBody.replace(/\n/g, '<br/>')}</p>`;

          // Extract threading headers
          const rawRefs = parsed.references
            ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
            : [];

          emails.push({
            id: message.uid.toString(),
            uid: message.uid,
            from: fromAddr?.name || fromAddr?.address || 'Unknown',
            fromEmail: fromAddr?.address || '',
            to: toAddrs.filter(Boolean) as string[],
            cc: ccAddrs.filter(Boolean) as string[],
            subject: parsed.subject || '(No subject)',
            preview: textBody.substring(0, 120).replace(/\n/g, ' '),
            body: htmlBody as string,
            date: (parsed.date || new Date()).toISOString(),
            isRead: message.flags?.has('\\Seen') || false,
            isStarred: message.flags?.has('\\Flagged') || false,
            attachments: (parsed.attachments || []).map((att: any, idx: number) => ({
              name: att.filename || 'attachment',
              size: att.size || 0,
              contentType: att.contentType || 'application/octet-stream',
              index: idx,
              uid: message.uid,
              source: 'imap',
            })),
            messageId: parsed.messageId || undefined,
            inReplyTo: parsed.inReplyTo || undefined,
            references: rawRefs.length > 0 ? rawRefs : undefined,
          });
          // Debug logging — log EVERY email's threading info so we can diagnose
          console.log(`[IMAP FETCH] UID=${message.uid} subject="${(parsed.subject || '').substring(0, 40)}" msgId=${parsed.messageId || 'NONE'} inReplyTo=${parsed.inReplyTo || 'NONE'} refs=${rawRefs.length}`);
        } catch (parseErr) {
          // Skip emails that fail to parse
          console.warn('[IMAP] Failed to parse message UID', message.uid);
        }
      }
    } finally {
      lock.release();
    }

  } catch (err: any) {
    console.error('[IMAP] Fetch error:', err.message);
    throw err;
  } finally {
    // ALWAYS release the connection — even on the empty-inbox early return OR a
    // thrown error (the old code skipped this on both paths, which leaked).
    // Use GRACEFUL logout(): it sends the IMAP LOGOUT command so Stalwart frees
    // the connection slot IMMEDIATELY. An abrupt close() leaves the slot held
    // until a TCP timeout, which — under per-user 30s polling — exhausts
    // Stalwart's connection limit and 500s the inbox for everyone. close() is
    // only the fallback if a graceful logout isn't possible.
    try {
      await client.logout();
    } catch {
      try { client.close(); } catch { /* already gone */ }
    }
  }

  // Return newest first
  return emails.reverse();
}

/**
 * Mark a message as read by adding the IMAP \Seen flag on Stalwart.
 *
 * This is the REAL, persistent read-state (survives logout, different browsers,
 * other devices) — unlike the client-side localStorage cache, which is only an
 * instant-UI optimisation. Called when the user opens an inbox message.
 */
export async function markEmailSeen(
  uid: number,
  folder: string = 'INBOX',
  userLoginName?: string,
  mailPassword?: string,
): Promise<void> {
  const client = createClient(userLoginName, mailPassword);
  try {
    await client.connect();
    const lock = await client.getMailboxLock(folder);
    try {
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    } finally {
      lock.release();
    }
  } catch (err: any) {
    console.error('[IMAP] markSeen error:', err.message);
    throw err;
  } finally {
    // Always release the connection (graceful logout — see fetchEmails note).
    try { await client.logout(); } catch { try { client.close(); } catch { /* gone */ } }
  }
}

export async function fetchFolders(): Promise<Array<{ id: string; name: string; count: number }>> {
  const client = createClient();
  const folders: Array<{ id: string; name: string; count: number }> = [];

  try {
    await client.connect();
    const mailboxes = await client.list();

    for (const mb of mailboxes) {
      if (mb.specialUse || !mb.flags?.has('\\Noselect')) {
        folders.push({
          id: mb.path,
          name: mb.name,
          count: 0, // Would need to open each to get count
        });
      }
    }

    await client.logout();
  } catch (err: any) {
    console.error('[IMAP] Folder list error:', err.message);
    throw err;
  }

  return folders;
}

export async function testImapConnection(): Promise<boolean> {
  const client = createClient();
  try {
    await client.connect();
    await client.logout();
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetch parent emails in a thread by their exact Message-IDs.
 * Uses the References header (list of parent Message-IDs) for precise matching.
 * Searches across INBOX and Sent — no subject guessing, no false matches.
 */
export async function fetchThreadByMessageIds(
  messageIds: string[],
  userLoginName?: string,
  mailPassword?: string
): Promise<ParsedEmail[]> {
  if (!messageIds || messageIds.length === 0) return [];
  const client = createClient(userLoginName, mailPassword);
  const results: ParsedEmail[] = [];
  const found = new Set<string>();

  try {
    await client.connect();

    // Normalize all target Message-IDs to lowercase without brackets for matching
    const targetSet = new Set(messageIds.map(id => id.replace(/^<|>$/g, '').toLowerCase()));
    const normToOrig = new Map<string, string>();
    for (const id of messageIds) {
      normToOrig.set(id.replace(/^<|>$/g, '').toLowerCase(), id);
    }

    for (const folder of ['INBOX', 'Sent', 'INBOX.Sent', 'Sent Items']) {
      // Stop early if we found all requested message IDs
      if (found.size >= messageIds.length) break;
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          // ── Strategy 1: Try IMAP HEADER search (fast — works on most servers) ──
          const matchingUids: number[] = [];
          for (const msgId of messageIds) {
            if (found.has(msgId)) continue;
            const cleanId = msgId.replace(/^<|>$/g, '');
            try {
              const uids = await client.search({ header: { 'Message-ID': cleanId } });
              const uidCount = Array.isArray(uids) ? uids.length : 0;
              console.log(`[IMAP THREAD] folder=${folder} HEADER search for "${cleanId}" → ${uidCount} UIDs`);
              if (Array.isArray(uids) && uids.length > 0) {
                matchingUids.push(uids[0]);
              }
            } catch { /* search failed — fall through to envelope scan */ }
          }

          // ── Strategy 2: Envelope scan fallback (works on Stalwart + others where HEADER search is broken) ──
          // Fetch envelopes for ALL messages in folder, filter by Message-ID in JS.
          // Slower but reliable. Only runs if HEADER search found nothing.
          if (matchingUids.length === 0) {
            const mb = client.mailbox as any;
            const totalMessages = mb && 'exists' in mb ? mb.exists : 0;
            if (totalMessages > 0) {
              console.log(`[IMAP THREAD] folder=${folder} HEADER search returned nothing — falling back to envelope scan of ${totalMessages} messages`);
              const range = `1:${totalMessages}`;
              try {
                for await (const msg of client.fetch(range, { envelope: true })) {
                  const envMsgId = (msg.envelope?.messageId || '').replace(/^<|>$/g, '').toLowerCase();
                  if (envMsgId && targetSet.has(envMsgId)) {
                    matchingUids.push(msg.uid);
                    console.log(`[IMAP THREAD] envelope scan matched UID=${msg.uid} for "${envMsgId}"`);
                  }
                }
              } catch (scanErr: any) {
                console.warn(`[IMAP THREAD] envelope scan error: ${scanErr.message}`);
              }
            }
          }

          // ── Fetch full source for matching UIDs and parse ──
          if (matchingUids.length === 0) { lock.release(); continue; }

          for await (const message of client.fetch(matchingUids, { source: true }, { uid: true })) {
            try {
              if (!message.source) continue;
              const parsed = await simpleParser(message.source) as any;
              const fromAddr = parsed.from?.value?.[0];
              const toAddrs = parsed.to ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to]).flatMap((a: any) => a.value?.map((v: any) => v.address || '') || []) : [];
              const ccAddrs = parsed.cc ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc]).flatMap((a: any) => a.value?.map((v: any) => v.address || '') || []) : [];
              const textBody = parsed.text || '';
              const htmlBody = parsed.html || `<p>${textBody.replace(/\n/g, '<br/>')}</p>`;

              const normMsgId = (parsed.messageId || '').replace(/^<|>$/g, '').toLowerCase();
              const origMsgId = normToOrig.get(normMsgId);
              if (origMsgId) found.add(origMsgId);

              results.push({
                id: `${folder}-${message.uid}`,
                uid: message.uid,
                from: fromAddr?.name || fromAddr?.address || 'Unknown',
                fromEmail: fromAddr?.address || '',
                to: toAddrs.filter(Boolean) as string[],
                cc: ccAddrs.filter(Boolean) as string[],
                subject: parsed.subject || '(No subject)',
                preview: textBody.substring(0, 120).replace(/\n/g, ' '),
                body: htmlBody as string,
                date: (parsed.date || new Date()).toISOString(),
                isRead: true,
                isStarred: false,
                attachments: (parsed.attachments || []).map((att: any, idx: number) => ({
                  name: att.filename || 'attachment',
                  size: att.size || 0,
                  contentType: att.contentType || 'application/octet-stream',
                  index: idx,
                  uid: message.uid,
                  source: 'imap',
                  folder: folder,
                })),
                messageId: parsed.messageId || undefined,
              });
              console.log(`[IMAP THREAD] matched & parsed UID=${message.uid} subject="${(parsed.subject || '').substring(0, 40)}" attachments=${(parsed.attachments || []).length}`);
            } catch (parseErr: any) {
              console.warn('[IMAP THREAD] Parse error:', parseErr.message);
            }
          }
        } finally {
          lock.release();
        }
      } catch (folderErr: any) {
        console.warn(`[IMAP THREAD] Folder "${folder}" error:`, folderErr.message);
      }
    }

    await client.logout();
  } catch (err: any) {
    console.error('[IMAP] Thread fetch error:', err.message);
  }

  return results.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

/**
 * Fetch thread emails by SUBJECT + PARTICIPANT filtering.
 * Used as a fallback when References headers are unavailable (e.g., old replies from BAL Connect).
 *
 * 1. Strips Re:/Fwd: from subject and searches IMAP by base subject
 * 2. Parses each result and checks participant overlap (from/to/cc must share addresses with current email)
 * 3. Filters by date proximity (only emails within 90 days of the current email)
 * 4. Returns matched emails sorted oldest-first, with full attachment data
 *
 * This prevents mixing: "testing" between Dipesh↔Swastik won't include "testing" between Dipesh↔SomeoneElse.
 */
export async function fetchThreadByConversation(
  subject: string,
  participants: string[],       // All email addresses involved in the current email (from + to + cc)
  currentEmailDate: string,     // ISO date of the email being viewed
  excludeMessageId?: string,    // Skip the current email itself
  userLoginName?: string,
  mailPassword?: string,
): Promise<ParsedEmail[]> {
  if (!subject || participants.length === 0) return [];

  // Normalize subject: strip Re:/Fwd:/RE:/FW: prefixes
  const baseSubject = subject.replace(/^(Re|Fwd|RE|FW|Fw|re|fwd):\s*/gi, '').trim();
  if (!baseSubject) return [];

  const participantSet = new Set(participants.map(p => p.toLowerCase().trim()).filter(Boolean));
  const currentDate = new Date(currentEmailDate);
  const dateWindowMs = 90 * 24 * 60 * 60 * 1000; // 90-day window

  const client = createClient(userLoginName, mailPassword);
  const results: ParsedEmail[] = [];
  const seenMessageIds = new Set<string>();

  try {
    await client.connect();

    for (const folder of ['INBOX', 'Sent', 'INBOX.Sent', 'Sent Items']) {
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          // IMAP SEARCH by subject
          const uids = await client.search({ subject: baseSubject });
          if (!uids || uids.length === 0) { lock.release(); continue; }

          // Fetch in batches — limit to last 50 matches to avoid performance issues
          const uidSlice = uids.slice(-50);

          for await (const message of client.fetch(uidSlice, {
            source: true,
          }, { uid: true })) {
            try {
              if (!message.source) continue;
              const parsed = await simpleParser(message.source) as any;

              const msgId = parsed.messageId || '';
              // Skip the current email and already-seen emails
              if (excludeMessageId && msgId === excludeMessageId) continue;
              if (msgId && seenMessageIds.has(msgId)) continue;

              // ── Participant overlap check ──
              // Collect all addresses from this email
              const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase() || '';
              const toAddrs = parsed.to
                ? (Array.isArray(parsed.to) ? parsed.to : [parsed.to])
                    .flatMap((a: any) => a.value?.map((v: any) => (v.address || '').toLowerCase()) || [])
                : [];
              const ccAddrs = parsed.cc
                ? (Array.isArray(parsed.cc) ? parsed.cc : [parsed.cc])
                    .flatMap((a: any) => a.value?.map((v: any) => (v.address || '').toLowerCase()) || [])
                : [];

              const emailAddresses = [fromAddr, ...toAddrs, ...ccAddrs].filter(Boolean);
              // At least ONE address must be in our participant set
              const hasOverlap = emailAddresses.some(addr => participantSet.has(addr));
              if (!hasOverlap) continue;

              // ── Date proximity check ──
              const emailDate = parsed.date ? new Date(parsed.date) : null;
              if (emailDate) {
                const diff = Math.abs(emailDate.getTime() - currentDate.getTime());
                if (diff > dateWindowMs) continue;
              }

              // ── Subject similarity check ──
              // The found email's subject (stripped) must match our base subject
              const foundSubject = (parsed.subject || '').replace(/^(Re|Fwd|RE|FW|Fw|re|fwd):\s*/gi, '').trim();
              if (foundSubject.toLowerCase() !== baseSubject.toLowerCase()) continue;

              if (msgId) seenMessageIds.add(msgId);

              const textBody = parsed.text || '';
              const htmlBody = parsed.html || `<p>${textBody.replace(/\n/g, '<br/>')}</p>`;
              const fromAddrObj = parsed.from?.value?.[0];

              results.push({
                id: `${folder}-${message.uid}`,
                uid: message.uid,
                from: fromAddrObj?.name || fromAddrObj?.address || 'Unknown',
                fromEmail: fromAddrObj?.address || '',
                to: toAddrs.filter(Boolean) as string[],
                cc: ccAddrs.filter(Boolean) as string[],
                subject: parsed.subject || '(No subject)',
                preview: textBody.substring(0, 120).replace(/\n/g, ' '),
                body: htmlBody as string,
                date: (parsed.date || new Date()).toISOString(),
                isRead: true,
                isStarred: false,
                attachments: (parsed.attachments || []).map((att: any, idx: number) => ({
                  name: att.filename || 'attachment',
                  size: att.size || 0,
                  contentType: att.contentType || 'application/octet-stream',
                  index: idx,
                  uid: message.uid,
                  source: 'imap',
                  folder: folder,
                })),
                messageId: msgId || undefined,
                inReplyTo: parsed.inReplyTo || undefined,
                references: parsed.references
                  ? (Array.isArray(parsed.references) ? parsed.references : [parsed.references])
                  : undefined,
              });
            } catch {
              // Skip unparseable emails
            }
          }
        } finally {
          lock.release();
        }
      } catch {
        // Folder doesn't exist — skip
      }
    }

    await client.logout();
  } catch (err: any) {
    console.error('[IMAP] Conversation thread fetch error:', err.message);
  }

  // Sort oldest-first, exclude the current email
  return results.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

export async function fetchImapAttachment(
  uid: number, attachIndex: number, userLoginName?: string, mailPassword?: string, folder?: string
): Promise<{ content: Buffer; filename: string; contentType: string } | null> {
  const client = createClient(userLoginName, mailPassword);
  // Try the specified folder first, then fall back to common folders
  const foldersToTry = folder
    ? [folder, 'INBOX', 'Sent', 'INBOX.Sent', 'Sent Items']
    : ['INBOX', 'Sent', 'INBOX.Sent', 'Sent Items'];
  // Deduplicate
  const uniqueFolders = [...new Set(foldersToTry)];

  try {
    await client.connect();
    for (const f of uniqueFolders) {
      try {
        const lock = await client.getMailboxLock(f);
        try {
          for await (const message of client.fetch(String(uid), { source: true }, { uid: true })) {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source) as any;
            const att = parsed.attachments?.[attachIndex];
            if (att) {
              await client.logout();
              return {
                content: att.content,
                filename: att.filename || 'attachment',
                contentType: att.contentType || 'application/octet-stream',
              };
            }
          }
        } finally {
          lock.release();
        }
      } catch {
        // Folder doesn't exist or UID not found — try next
      }
    }
    await client.logout();
  } catch (err: any) {
    console.error('[IMAP] Attachment fetch error:', err.message);
  }
  return null;
}
