/**
 * iCalendar (.ics) generator — RFC 5545 compliant
 *
 * Builds a single-event VCALENDAR string that Outlook, Apple Mail, Gmail, and
 * Thunderbird all recognise as a meeting invitation. The output is intended
 * to be attached to an email with MIME headers:
 *
 *   Content-Type: text/calendar; charset=UTF-8; method=REQUEST
 *   Content-Transfer-Encoding: 8bit
 *
 * On the recipient's mail client this triggers the native "Accept / Decline /
 * Tentative" UI without our server needing to track replies (the email
 * client emits a METHOD:REPLY back to the organiser automatically).
 *
 * METHOD=REQUEST — new or updated invitation (SEQUENCE bumps for updates)
 * METHOD=CANCEL  — event cancelled (organiser deletes it)
 *
 * No external dependency. Hand-rolled because the spec is straightforward
 * and ical-generator brings in a lot of weight we don't need.
 */

export interface ICalAttendee {
  email: string;
  displayName?: string;
  /** Whether this attendee is required (default true) or optional */
  required?: boolean;
  /** Current participation status — typically 'NEEDS-ACTION' on first invite */
  status?: 'NEEDS-ACTION' | 'ACCEPTED' | 'DECLINED' | 'TENTATIVE';
}

export interface ICalEventInput {
  /** Stable UID for the event (typically the calendar_events.id). Same UID
   *  across the original REQUEST, any UPDATE (REQUEST with higher SEQUENCE),
   *  and the CANCEL — this is what lets the recipient's calendar update
   *  the existing entry instead of creating a duplicate. */
  uid: string;
  /** Organiser email (must match the email the message is sent FROM). */
  organizerEmail: string;
  organizerName: string;
  attendees: ICalAttendee[];
  summary: string;
  description?: string;
  /** Free-text location, OR a URL like https://...meeting/xyz */
  location?: string;
  /** Meeting join URL — also placed in the URL property AND prepended in DESCRIPTION */
  meetingUrl?: string;
  startUtc: Date;
  endUtc: Date;
  /** Monotonically-increasing version number. Increment on every update so
   *  recipient calendars know to replace the existing entry. */
  sequence: number;
  /** REQUEST (new/update) or CANCEL (deletion). */
  method: 'REQUEST' | 'CANCEL';
  /** STATUS field — usually CONFIRMED for REQUEST, CANCELLED for CANCEL */
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
}

/**
 * Format a Date as an iCalendar UTC datetime: YYYYMMDDTHHMMSSZ
 */
function formatUtc(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return (
    d.getUTCFullYear().toString() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    'T' +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/**
 * Escape iCalendar text values per RFC 5545:
 *   - Backslash → \\
 *   - Newline   → \n
 *   - Semicolon → \;
 *   - Comma     → \,
 */
function escapeText(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

/**
 * Fold long lines per RFC 5545 §3.1: lines longer than 75 octets MUST be
 * folded by inserting CRLF followed by a single whitespace. Outlook is
 * forgiving but strict CalDAV servers reject unfolded long lines.
 */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (i === 0) {
      out.push(line.slice(0, 75));
      i = 75;
    } else {
      out.push(' ' + line.slice(i, i + 74));
      i += 74;
    }
  }
  return out.join('\r\n');
}

/**
 * Build the .ics content. Output uses CRLF line endings as required by the
 * spec. Do NOT change to plain \n — some strict parsers (notably older
 * Outlook on Windows) reject \n-only content.
 */
export function buildIcs(input: ICalEventInput): string {
  const lines: string[] = [];

  const push = (line: string) => lines.push(foldLine(line));

  push('BEGIN:VCALENDAR');
  push('VERSION:2.0');
  push('PRODID:-//BAL Connect//ICP Internal Communication Platform//EN');
  push('CALSCALE:GREGORIAN');
  push(`METHOD:${input.method}`);

  push('BEGIN:VEVENT');
  push(`UID:${input.uid}@balasorealloys.in`);
  push(`DTSTAMP:${formatUtc(new Date())}`);
  push(`DTSTART:${formatUtc(input.startUtc)}`);
  push(`DTEND:${formatUtc(input.endUtc)}`);
  push(`SEQUENCE:${input.sequence}`);
  push(`STATUS:${input.status || (input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED')}`);
  push('TRANSP:OPAQUE'); // shows as Busy in attendees' calendars

  push(`SUMMARY:${escapeText(input.summary)}`);

  // Description: prepend join link (if any) so even plain-text mail clients see it
  const descParts: string[] = [];
  if (input.meetingUrl) {
    descParts.push(`Join the meeting: ${input.meetingUrl}`);
    descParts.push('');
  }
  if (input.description) descParts.push(input.description);
  if (descParts.length > 0) push(`DESCRIPTION:${escapeText(descParts.join('\n'))}`);

  // LOCATION can be a URL (Outlook hyperlinks it) or free text
  if (input.location) push(`LOCATION:${escapeText(input.location)}`);

  // URL property — Outlook surfaces this as a clickable link
  if (input.meetingUrl) push(`URL:${input.meetingUrl}`);

  // Organiser
  push(`ORGANIZER;CN=${escapeText(input.organizerName)}:mailto:${input.organizerEmail}`);

  // Attendees — one ATTENDEE line each
  for (const a of input.attendees) {
    const role = a.required === false ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT';
    const partstat = a.status || 'NEEDS-ACTION';
    const cn = a.displayName ? `;CN=${escapeText(a.displayName)}` : '';
    push(
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=${role};PARTSTAT=${partstat};RSVP=TRUE${cn}:mailto:${a.email}`,
    );
  }

  push('END:VEVENT');
  push('END:VCALENDAR');

  // RFC 5545 mandates CRLF line endings
  return lines.join('\r\n') + '\r\n';
}
