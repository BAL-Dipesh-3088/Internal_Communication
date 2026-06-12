import nodemailer from 'nodemailer';
// MailComposer is exported by nodemailer for building raw MIME messages
// We use it to build the message once for BOTH SMTP send and IMAP APPEND
// (same pattern Outlook/Thunderbird use to keep sent copies in the user's Sent folder)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MailComposer = require('nodemailer/lib/mail-composer');
import { query } from '../../database/connection';
import { tryDecryptSecret } from '../../utils/crypto';
import { appendToSentFolder } from './imap.service';

const STALWART_HOST = process.env.STALWART_SMTP_HOST || '';
const STALWART_PORT = parseInt(process.env.STALWART_SMTP_PORT || '587');
const STALWART_SECURE = process.env.STALWART_SMTP_SECURE === 'true';

// Per-user Stalwart SMTP — each user authenticates with their own mail_password
function createUserStalwartTransport(userLoginName: string, mailPassword: string): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: STALWART_HOST,
    port: STALWART_PORT,
    secure: STALWART_SECURE,
    auth: { user: userLoginName, pass: mailPassword },
    tls: { rejectUnauthorized: false },
  });
}

if (STALWART_HOST) {
  console.log('[EMAIL] Stalwart SMTP configured at', STALWART_HOST + ':' + STALWART_PORT);
}

/**
 * System-sender email — for mails that have NO authenticated user behind them
 * (login-page help desk: forgot-password requests, feedback).
 *
 * Stalwart only lets a principal send from its OWN address (the env `admin`
 * account is a management principal with no mail identity — it gets
 * "501 not allowed to send from this address"). So instead we authenticate as
 * the first ADMIN USER that has a working mail account and send as them,
 * labelled "ICP Help Desk". This reuses the exact same per-user path that
 * meeting invites already use in production.
 */
export async function sendSystemEmail(opts: {
  to: string | string[];
  subject: string;
  html: string;
  fromName?: string;
}): Promise<void> {
  // First active admin with a mail credential acts as the system sender.
  const admins = await query(
    `SELECT id FROM users
      WHERE role = 'admin' AND is_active = true
        AND (mail_password_encrypted IS NOT NULL OR mail_password IS NOT NULL)
      ORDER BY created_at ASC`,
  );

  let lastErr: Error | null = null;
  for (const row of admins.rows) {
    const cred = await resolveUserMailCredential(row.id);
    if (!cred.email || !cred.mailPassword) continue;
    try {
      await sendEmail({
        to: opts.to,
        subject: opts.subject,
        html: opts.html,
        fromEmail: cred.email,
        fromName: opts.fromName || 'ICP Help Desk',
        mailPassword: cred.mailPassword,
      });
      return;
    } catch (err: any) {
      lastErr = err; // try the next admin's mailbox
    }
  }
  throw lastErr || new Error('No admin account with a working mail credential found for system mail');
}

/**
 * Resolves a user's Stalwart credential, preferring the AES-encrypted column.
 * Falls back to the legacy plaintext `mail_password` column (during migration window).
 *
 * Returns { email, displayName, mailPassword } — mailPassword is plaintext (decrypted)
 * suitable for passing to SMTP/IMAP auth. Returns empty string if no credential.
 */
export async function resolveUserMailCredential(userId: string): Promise<{
  email: string;
  displayName: string;
  mailPassword: string;
  loginName: string;
}> {
  const result = await query(
    `SELECT email, display_name, mail_password, mail_password_encrypted
       FROM users WHERE id = $1`,
    [userId],
  );
  const row = result.rows[0] || {};
  const email: string = row.email || '';
  const displayName: string = row.display_name || 'BAL Connect';

  let mailPassword = '';
  if (row.mail_password_encrypted) {
    const decrypted = tryDecryptSecret(row.mail_password_encrypted);
    if (decrypted !== null) {
      mailPassword = decrypted;
    }
  }
  // Backward-compat: plaintext column for users not yet migrated
  if (!mailPassword && row.mail_password) {
    mailPassword = row.mail_password;
  }

  const loginName = email ? email.split('@')[0] : '';
  return { email, displayName, mailPassword, loginName };
}

export interface SendEmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
  fromEmail?: string;
  fromName?: string;
  mailPassword?: string;
  attachments?: Array<{ filename: string; path?: string; content?: Buffer; contentType?: string }>;
  /** Message-ID of the email being replied to (In-Reply-To header) */
  inReplyTo?: string;
  /** List of all ancestor Message-IDs in the thread (References header) */
  references?: string[];
  /**
   * iCalendar payload for meeting invites. When present, it's added as a
   * multipart/alternative MIME part (NOT as a regular attachment) — this is
   * what makes Outlook / Apple Mail / Gmail render the native
   * "Accept / Decline / Tentative" inline buttons instead of showing a
   * downloadable .ics file.
   *
   * It's ALSO attached as a regular .ics attachment so non-rich clients
   * (some webmail viewers, mobile fallbacks) can still save and import it.
   */
  icalInvite?: {
    /** Raw RFC 5545 .ics content */
    content: string;
    /** REQUEST = new/update invite, CANCEL = cancellation */
    method: 'REQUEST' | 'CANCEL';
    /** Filename for the attachment fallback (default 'invite.ics') */
    filename?: string;
  };
}

export async function sendEmail(options: SendEmailOptions): Promise<{ messageId: string; accepted: string[] }> {
  const senderEmail = options.fromEmail || '';
  const senderName = options.fromName || 'BAL Connect';
  const recipients = Array.isArray(options.to) ? options.to : [options.to];
  const mailPass = options.mailPassword || '';
  const userLogin = senderEmail ? senderEmail.split('@')[0] : '';

  if (!STALWART_HOST || !userLogin || !mailPass) {
    throw new Error('Stalwart SMTP not configured or user has no mail_password');
  }

  // ALL mail routed through Stalwart — user authenticates as themselves
  const transport = createUserStalwartTransport(userLogin, mailPass);
  const fromAddress = `"${senderName}" <${senderEmail}>`;

  // Build References header: all ancestor Message-IDs (for threading)
  const referencesHeader = options.references && options.references.length > 0
    ? options.references.join(' ')
    : undefined;

  // ── iCalendar invitation handling ──
  // For Outlook/Apple Mail/Gmail to show native Accept/Decline buttons, the
  // .ics must be a multipart/alternative part (peer of text/html), NOT a
  // regular attachment. Nodemailer exposes this via `alternatives`. We also
  // duplicate as a regular .ics attachment so dumb clients still see a
  // saveable file.
  const alternatives: any[] = [];
  const attachmentsList: any[] = options.attachments ? [...options.attachments] : [];
  if (options.icalInvite) {
    alternatives.push({
      content: options.icalInvite.content,
      contentType: `text/calendar; charset=UTF-8; method=${options.icalInvite.method}`,
    });
    attachmentsList.push({
      filename: options.icalInvite.filename || 'invite.ics',
      content: Buffer.from(options.icalInvite.content, 'utf-8'),
      contentType: 'application/ics',
    });
  }

  // ── Build the raw MIME message ONCE — used for both SMTP send and IMAP APPEND ──
  // This is the same pattern Outlook/Thunderbird use: compile once, send via SMTP,
  // then append the same bytes to the user's Sent folder via IMAP.
  const mailOpts: any = {
    from: fromAddress,
    to: recipients.join(', '),
    cc: options.cc ? (Array.isArray(options.cc) ? options.cc.join(', ') : options.cc) : undefined,
    bcc: options.bcc ? (Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc) : undefined,
    subject: options.subject,
    text: options.text,
    html: options.html,
    replyTo: options.replyTo,
    inReplyTo: options.inReplyTo || undefined,
    references: referencesHeader,
    attachments: attachmentsList.length > 0 ? attachmentsList : undefined,
    alternatives: alternatives.length > 0 ? alternatives : undefined,
  };

  console.log(`[SENDMAIL] options.inReplyTo=${options.inReplyTo || 'NONE'} options.references=${referencesHeader || 'NONE'}`);

  const composer = new MailComposer(mailOpts);
  const compiled = composer.compile();
  const rawMessage: Buffer = await new Promise((resolve, reject) => {
    compiled.build((err: any, msg: Buffer) => (err ? reject(err) : resolve(msg)));
  });
  const envelope = compiled.getEnvelope();
  const compiledMessageId: string = compiled.messageId();

  // Log a snippet of the raw message headers so we can verify In-Reply-To/References
  // are actually being included in the SMTP-bound bytes
  const rawHeadersOnly = rawMessage.toString('utf8').split(/\r?\n\r?\n/)[0] || '';
  const hasInReplyTo = /^In-Reply-To:/im.test(rawHeadersOnly);
  const hasReferences = /^References:/im.test(rawHeadersOnly);
  console.log(`[SENDMAIL] Compiled message — messageId=${compiledMessageId} hasInReplyToHeader=${hasInReplyTo} hasReferencesHeader=${hasReferences}`);

  // Send via SMTP using the pre-built raw bytes (guarantees same Message-ID for APPEND)
  const result = await transport.sendMail({
    envelope,
    raw: rawMessage,
  });

  // ── APPEND to user's IMAP Sent folder (fire-and-forget) ──
  // This is critical for threading: when someone replies, we need to find this email
  // in the sender's mailbox via IMAP search. Without APPEND, the message only exists
  // in the recipient's INBOX and is invisible to the sender.
  appendToSentFolder(rawMessage, userLogin, mailPass).catch((err: any) =>
    console.warn('[EMAIL] APPEND to Sent failed (non-fatal):', err.message),
  );

  console.log(`[EMAIL] Sent via Stalwart as ${senderEmail} to ${recipients.join(', ')}`);
  return {
    messageId: result.messageId || compiledMessageId,
    accepted: (result.accepted || recipients) as string[],
  };
}

export function getTransporter() {
  return createUserStalwartTransport('admin', process.env.STALWART_SMTP_PASSWORD || '');
}
