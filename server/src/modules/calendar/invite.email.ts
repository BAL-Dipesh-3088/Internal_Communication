/**
 * Outlook-style meeting invitation email.
 *
 * Sends an HTML email that looks like the invites Outlook/Teams generate,
 * with an iCalendar alternative part so the recipient's mail client renders
 * native Accept/Decline/Tentative buttons inline.
 *
 * The template mimics Outlook's visual structure:
 *   - Organiser identity at the very top
 *   - Large meeting title
 *   - Date + time block with day-of-week
 *   - Location row (with map icon if it's a physical location)
 *   - Description body
 *   - Big purple "Join the meeting now" CTA (when online)
 *   - Attendee list at the bottom
 *
 * Three call sites:
 *   - sendInvite(...)   → first send, METHOD=REQUEST, SEQUENCE=0
 *   - sendUpdate(...)   → event changed, METHOD=REQUEST, SEQUENCE+=1 (Outlook
 *                         shows "Updated:" prefix; recipient calendar replaces
 *                         the existing entry because UID matches)
 *   - sendCancellation(...) → event deleted, METHOD=CANCEL, SEQUENCE+=1
 *                             (Outlook shows "Cancelled:" prefix; recipient
 *                             calendar removes the existing entry)
 */

import { sendEmail, resolveUserMailCredential } from '../email/email.service';
import { buildIcs, type ICalAttendee } from './ical.helper';

export interface InviteRecipient {
  email: string;
  displayName?: string;
}

export interface MeetingInvitePayload {
  /** Stable UID — the calendar_events.id. Same UID across original + updates + cancellation. */
  uid: string;
  organiserUserId: string;       // BAL Connect user id of the host (sender)
  recipients: InviteRecipient[];
  title: string;
  description?: string;
  /** Location string (could be a physical address OR the meeting URL itself) */
  location?: string;
  meetingUrl?: string;
  startUtc: Date;
  endUtc: Date;
  /** SEQUENCE — bump on every update so recipient calendars know to replace. */
  sequence: number;
}

/**
 * First-time invitation (METHOD=REQUEST, SEQUENCE=0).
 */
export async function sendInvite(payload: MeetingInvitePayload): Promise<void> {
  return sendOne(payload, 'REQUEST', 'Invitation');
}

/**
 * Update to an existing invitation. Caller must bump `sequence` >= previous.
 */
export async function sendUpdate(payload: MeetingInvitePayload): Promise<void> {
  return sendOne(payload, 'REQUEST', 'Updated');
}

/**
 * Cancellation. Recipient calendars remove the event when this is received.
 */
export async function sendCancellation(payload: MeetingInvitePayload): Promise<void> {
  return sendOne(payload, 'CANCEL', 'Cancelled');
}

async function sendOne(
  payload: MeetingInvitePayload,
  method: 'REQUEST' | 'CANCEL',
  subjectPrefix: 'Invitation' | 'Updated' | 'Cancelled',
): Promise<void> {
  const organiser = await resolveUserMailCredential(payload.organiserUserId);
  if (!organiser.email || !organiser.mailPassword) {
    console.warn(`[CalendarInvite] Cannot send — organiser ${payload.organiserUserId} has no mail credentials`);
    return;
  }

  if (payload.recipients.length === 0) return;

  // Build .ics
  const icalAttendees: ICalAttendee[] = payload.recipients.map((r) => ({
    email: r.email,
    displayName: r.displayName,
    required: true,
    status: 'NEEDS-ACTION',
  }));
  const ics = buildIcs({
    uid: payload.uid,
    organizerEmail: organiser.email,
    organizerName: organiser.displayName,
    attendees: icalAttendees,
    summary: payload.title,
    description: payload.description,
    location: payload.location,
    meetingUrl: payload.meetingUrl,
    startUtc: payload.startUtc,
    endUtc: payload.endUtc,
    sequence: payload.sequence,
    method,
    status: method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED',
  });

  const subject = method === 'CANCEL'
    ? `Cancelled: ${payload.title}`
    : payload.sequence > 0
      ? `Updated: ${payload.title}`
      : payload.title;

  const html = buildHtmlBody(payload, organiser, method);
  const text = buildPlainText(payload, organiser, method);

  // Send to each recipient individually so each gets a personal To: line —
  // this is what Outlook expects and gives best Accept/Decline UX.
  // (Sending one email with all attendees in To: also works but the iCal
  // PARTSTAT/RSVP belongs to a specific person.)
  for (const r of payload.recipients) {
    try {
      await sendEmail({
        to: r.email,
        subject,
        html,
        text,
        fromEmail: organiser.email,
        fromName: organiser.displayName,
        mailPassword: organiser.mailPassword,
        icalInvite: {
          content: ics,
          method,
          filename: method === 'CANCEL' ? 'cancel.ics' : 'invite.ics',
        },
      });
    } catch (err: any) {
      console.warn(`[CalendarInvite] Failed to send ${method} to ${r.email}:`, err?.message || err);
      // Continue with remaining recipients — one bad address shouldn't block the whole batch
    }
  }
  console.log(
    `[CalendarInvite] ${subjectPrefix} "${payload.title}" sent to ${payload.recipients.length} recipient(s) ` +
    `(uid=${payload.uid}, seq=${payload.sequence}, method=${method})`,
  );
}

// ─── HTML template ────────────────────────────────────────────────────────────

function buildHtmlBody(
  p: MeetingInvitePayload,
  organiser: { email: string; displayName: string },
  method: 'REQUEST' | 'CANCEL',
): string {
  const isCancel = method === 'CANCEL';
  const dateLine = formatLongDate(p.startUtc);
  const timeLine = `${formatTime(p.startUtc)} – ${formatTime(p.endUtc)} (${getTimezoneName()})`;
  const banner = isCancel ? 'This meeting has been cancelled' : 'You\'re invited to a meeting';
  const bannerColor = isCancel ? '#DC2626' : '#6264A7';

  const safe = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${safe(p.title)}</title>
</head>
<body style="margin:0; padding:0; background:#F3F2F1; font-family: 'Segoe UI', Roboto, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif; color:#252423;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F3F2F1;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="background:#FFFFFF; border-radius:10px; box-shadow:0 2px 8px rgba(0,0,0,0.06); max-width:600px;">

        <!-- Banner -->
        <tr><td style="background:${bannerColor}; padding:14px 24px; border-top-left-radius:10px; border-top-right-radius:10px; color:#fff; font-size:13px; font-weight:600;">
          ${banner}
        </td></tr>

        <!-- Organiser line (Outlook-style) -->
        <tr><td style="padding:18px 28px 4px;">
          <div style="font-size:12px; color:#605E5C;">
            From <strong style="color:#252423;">${safe(organiser.displayName)}</strong>
            &lt;<a href="mailto:${organiser.email}" style="color:#0078D4; text-decoration:none;">${organiser.email}</a>&gt;
          </div>
        </td></tr>

        <!-- Title -->
        <tr><td style="padding:6px 28px 16px;">
          <h1 style="margin:0; font-size:22px; line-height:1.3; font-weight:600; color:#252423; ${isCancel ? 'text-decoration:line-through; color:#A19F9D;' : ''}">
            ${safe(p.title)}
          </h1>
        </td></tr>

        <!-- Time block -->
        <tr><td style="padding:0 28px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
            <tr>
              <td style="padding-right:10px; vertical-align:top;">
                <div style="width:32px; height:32px; border-radius:6px; background:#F3F2F1; text-align:center; line-height:32px; font-size:18px;">🕐</div>
              </td>
              <td style="vertical-align:middle;">
                <div style="font-size:14px; font-weight:600; color:#252423;">${safe(dateLine)}</div>
                <div style="font-size:13px; color:#605E5C; margin-top:2px;">${safe(timeLine)}</div>
              </td>
            </tr>
          </table>
        </td></tr>

        ${p.location ? `
        <!-- Location -->
        <tr><td style="padding:0 28px 18px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
            <tr>
              <td style="padding-right:10px; vertical-align:top;">
                <div style="width:32px; height:32px; border-radius:6px; background:#F3F2F1; text-align:center; line-height:32px; font-size:16px;">📍</div>
              </td>
              <td style="vertical-align:middle;">
                <div style="font-size:13px; color:#252423;">${safe(p.location)}</div>
              </td>
            </tr>
          </table>
        </td></tr>` : ''}

        ${p.meetingUrl && !isCancel ? `
        <!-- Join CTA -->
        <tr><td style="padding:8px 28px 24px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr><td bgcolor="#6264A7" style="border-radius:6px;">
              <a href="${p.meetingUrl}" target="_blank"
                 style="display:inline-block; padding:13px 28px; font-size:14px; font-weight:600; color:#FFFFFF; text-decoration:none; border-radius:6px;">
                Join the meeting now
              </a>
            </td></tr>
          </table>
          <div style="font-size:11px; color:#8B8CA7; margin-top:10px;">
            Or copy: <a href="${p.meetingUrl}" style="color:#0078D4; text-decoration:none;">${p.meetingUrl}</a>
          </div>
        </td></tr>` : ''}

        ${p.description && !isCancel ? `
        <!-- Description -->
        <tr><td style="padding:0 28px 18px;">
          <div style="border-top:1px solid #EDEBE9; padding-top:18px;">
            <div style="font-size:12px; font-weight:600; color:#605E5C; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.4px;">Details</div>
            <div style="font-size:13px; line-height:1.55; color:#252423; white-space:pre-wrap;">${safe(p.description)}</div>
          </div>
        </td></tr>` : ''}

        <!-- Attendees -->
        <tr><td style="padding:0 28px 24px;">
          <div style="border-top:1px solid #EDEBE9; padding-top:18px;">
            <div style="font-size:12px; font-weight:600; color:#605E5C; margin-bottom:8px; text-transform:uppercase; letter-spacing:0.4px;">
              Required attendees (${p.recipients.length})
            </div>
            <div style="font-size:13px; color:#252423; line-height:1.7;">
              ${p.recipients.map(r => `<div>• ${safe(r.displayName || r.email)} <span style="color:#8B8CA7;">&lt;${r.email}&gt;</span></div>`).join('')}
            </div>
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:18px 28px 22px; border-top:1px solid #EDEBE9; font-size:11px; color:#8B8CA7; border-bottom-left-radius:10px; border-bottom-right-radius:10px;">
          Sent by BAL Connect (ICP) — Internal Communication Platform
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ─── Plain-text fallback ──────────────────────────────────────────────────────

function buildPlainText(
  p: MeetingInvitePayload,
  organiser: { email: string; displayName: string },
  method: 'REQUEST' | 'CANCEL',
): string {
  const isCancel = method === 'CANCEL';
  const banner = isCancel ? 'CANCELLED MEETING' : 'MEETING INVITATION';
  const lines: string[] = [];
  lines.push(banner);
  lines.push('='.repeat(banner.length));
  lines.push('');
  lines.push(`From: ${organiser.displayName} <${organiser.email}>`);
  lines.push('');
  lines.push(`Subject: ${p.title}`);
  lines.push(`When: ${formatLongDate(p.startUtc)} ${formatTime(p.startUtc)}–${formatTime(p.endUtc)} (${getTimezoneName()})`);
  if (p.location) lines.push(`Where: ${p.location}`);
  if (p.meetingUrl && !isCancel) {
    lines.push('');
    lines.push(`Join the meeting: ${p.meetingUrl}`);
  }
  if (p.description && !isCancel) {
    lines.push('');
    lines.push('Details:');
    lines.push(p.description);
  }
  lines.push('');
  lines.push(`Required attendees (${p.recipients.length}):`);
  for (const r of p.recipients) {
    lines.push(`  - ${r.displayName || r.email} <${r.email}>`);
  }
  lines.push('');
  lines.push('— Sent by BAL Connect (ICP)');
  return lines.join('\n');
}

// ─── Format helpers ───────────────────────────────────────────────────────────

// Display timezone for invite emails. The Node process TZ differs per host
// (laptop = Asia/Calcutta, Docker container defaults to UTC), which made the
// SAME meeting render different wall-clock times depending on where the email
// was generated. Pin it to a fixed company timezone so every recipient sees
// the time the organiser intended, regardless of server TZ. Configurable via
// env for multi-region deployments. (The .ics attachment stays in UTC — mail
// clients convert that to each viewer's own zone, which is correct.)
const DISPLAY_TZ = process.env.INVITE_TIMEZONE || 'Asia/Kolkata';

function formatLongDate(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: DISPLAY_TZ,
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: DISPLAY_TZ,
  });
}

function getTimezoneName(): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: DISPLAY_TZ, timeZoneName: 'long',
    }).formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value || DISPLAY_TZ;
  } catch {
    return DISPLAY_TZ;
  }
}
