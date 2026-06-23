import { Router, Response } from 'express';
import { randomUUID } from 'crypto';
import { authMiddleware, AuthRequest } from '../../middleware/auth';
import { query, pool } from '../../database/connection';
import { getIO } from '../../services/socket.service';
import { config } from '../../config';
import { sendInvite, sendUpdate, sendCancellation, type InviteRecipient } from './invite.email';

const router = Router();
router.use(authMiddleware);

/**
 * Is this URL/host a local-only / non-routable address that must NEVER appear
 * in an email sent to other people? (localhost, loopback, link-local, etc.)
 */
function isLocalAddress(url: string): boolean {
  const host = url
    .replace(/^https?:\/\//i, '')   // strip scheme
    .split('/')[0]                  // strip path
    .split(':')[0]                  // strip port
    .toLowerCase()
    .trim();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local')
  );
}

/**
 * Resolve the PUBLIC meeting URL for a given LiveKit call — the link that lands
 * in invite emails opened on other people's machines. It MUST be an absolute,
 * routable address; a localhost link is worthless to a recipient.
 *
 * Priority order (most-explicit / most-trustworthy first):
 *   1. PUBLIC_APP_URL  — the canonical public address (e.g. https://icp.balasorealloys.in).
 *                        This is the correct production answer and always wins.
 *   2. CLIENT_URL      — only if it is NOT a local address (in prod it is the real
 *                        host; in dev it is localhost and is deliberately skipped).
 *   3. Origin header   — only if it is NOT a local address.
 *   4. Relative path   — last resort. Works inside the app, useless in email,
 *                        so we also warn loudly so it never silently ships.
 *
 * The localhost guard is the key fix: even if someone forgets to set
 * PUBLIC_APP_URL, a dev/localhost value can never leak into an outbound invite.
 */
function buildMeetingUrl(callId: string, req?: AuthRequest): string {
  const candidates: Array<string | undefined> = [
    config.publicAppUrl,
    process.env.CLIENT_URL,
    req?.get?.('origin'),
  ];

  for (const candidate of candidates) {
    if (candidate && !isLocalAddress(candidate)) {
      return `${candidate.replace(/\/$/, '')}/meeting/${callId}`;
    }
  }

  console.warn(
    '[calendar] No public base URL resolved for meeting link — set PUBLIC_APP_URL ' +
      '(e.g. https://icp.balasorealloys.in). Falling back to a relative path that ' +
      'will NOT work in email clients.'
  );
  return `/meeting/${callId}`;
}

/**
 * Fetch the email address + display name for a list of user ids.
 * Skips users with no email (which would just silently fail the invite anyway).
 */
async function resolveRecipients(userIds: string[]): Promise<InviteRecipient[]> {
  if (userIds.length === 0) return [];
  const r = await query(
    `SELECT id, email, display_name, username
       FROM users WHERE id = ANY($1) AND is_active = true AND email IS NOT NULL AND email <> ''`,
    [userIds],
  );
  return r.rows.map((u: any) => ({
    email: u.email,
    displayName: u.display_name || u.username || u.email,
  }));
}

/**
 * Clamp the reminder lead time to a sane, whitelisted set of minutes.
 * Anything unexpected falls back to the Teams default (15). 0 = no reminder.
 */
function normalizeReminderMinutes(value: unknown): number {
  const allowed = [0, 5, 10, 15, 30, 60, 120, 1440];
  const n = Number(value);
  if (!Number.isFinite(n)) return 15;
  return allowed.includes(n) ? n : 15;
}

// ─── GET EVENTS (date range) ─────────────────────────────

router.get('/events', async (req: AuthRequest, res: Response) => {
  try {
    const { start, end } = req.query;
    const userId = req.user!.userId;

    if (!start || !end) {
      return res.status(400).json({ error: 'start and end query params required' });
    }

    const result = await query(
      `SELECT e.*,
              u.display_name as creator_name,
              (
                SELECT json_agg(json_build_object(
                  'user_id', ea2.user_id,
                  'display_name', au.display_name,
                  'status', ea2.status
                ))
                FROM event_attendees ea2
                JOIN users au ON au.id = ea2.user_id
                WHERE ea2.event_id = e.id
              ) as attendees
       FROM calendar_events e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE (e.created_by = $1 OR EXISTS (SELECT 1 FROM event_attendees ea WHERE ea.event_id = e.id AND ea.user_id = $1))
         AND e.start_time < $3
         AND e.end_time > $2
       ORDER BY e.start_time ASC`,
      [userId, start, end]
    );

    res.json({ events: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET SINGLE EVENT ────────────────────────────────────

router.get('/events/:eventId', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT e.*,
              u.display_name as creator_name,
              (
                SELECT json_agg(json_build_object(
                  'user_id', ea.user_id,
                  'display_name', au.display_name,
                  'status', ea.status
                ))
                FROM event_attendees ea
                JOIN users au ON au.id = ea.user_id
                WHERE ea.event_id = e.id
              ) as attendees
       FROM calendar_events e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = $1`,
      [req.params.eventId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    res.json({ event: result.rows[0] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CREATE EVENT ────────────────────────────────────────

router.post('/events', async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const userId = req.user!.userId;
    const {
      title, description, start_time, end_time, is_all_day, location, color, attendee_ids,
      is_online_meeting, // NEW — Teams-style toggle
      reminder_minutes,  // NEW — Teams-style reminder lead time (0 = none)
    } = req.body;

    if (!title?.trim()) return res.status(400).json({ error: 'Title is required' });
    if (!start_time || !end_time) return res.status(400).json({ error: 'Start and end time required' });

    const onlineMeeting = !!is_online_meeting;
    const reminderMinutes = normalizeReminderMinutes(reminder_minutes);

    await client.query('BEGIN');

    // Create event (livekit_call_id is set later if online meeting)
    const eventResult = await client.query(
      `INSERT INTO calendar_events (title, description, start_time, end_time, is_all_day, location, color, created_by, is_online_meeting, reminder_minutes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [title.trim(), description || null, start_time, end_time, is_all_day || false, location || null, color || '#5B5FC7', userId, onlineMeeting, reminderMinutes]
    );

    const event = eventResult.rows[0];

    // ── Pre-provision a LiveKit call row for online meetings ──
    // We create the call_history record NOW (with status='scheduled') so the
    // /meeting/<callId> link is stable and works before the meeting starts.
    // The LiveKit room itself is lazy-created when the first participant joins.
    let livekitCallId: string | null = null;
    if (onlineMeeting) {
      livekitCallId = randomUUID();
      const roomName = `cal-${event.id.replace(/-/g, '').slice(0, 12)}-${Date.now().toString(36)}`;
      await client.query(
        `INSERT INTO call_history (
            id, caller_id, host_user_id, call_type, is_group_call, status,
            participants, livekit_room_name, calendar_event_id, started_at
          ) VALUES ($1, $2, $2, 'video', TRUE, 'scheduled', $3, $4, $5, $6)`,
        [
          livekitCallId,
          userId,
          JSON.stringify([]), // host added on first join via /join flow
          roomName,
          event.id,
          start_time,
        ],
      );
      await client.query(
        `UPDATE calendar_events SET livekit_call_id = $1 WHERE id = $2`,
        [livekitCallId, event.id],
      );
    }

    // Add creator as accepted attendee
    await client.query(
      `INSERT INTO event_attendees (event_id, user_id, status, responded_at)
       VALUES ($1, $2, 'accepted', NOW())`,
      [event.id, userId]
    );

    // Add other attendees as pending
    const allAttendeeIds = [userId];
    if (attendee_ids && Array.isArray(attendee_ids)) {
      for (const attendeeId of attendee_ids) {
        if (attendeeId === userId) continue;
        await client.query(
          `INSERT INTO event_attendees (event_id, user_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (event_id, user_id) DO NOTHING`,
          [event.id, attendeeId]
        );
        allAttendeeIds.push(attendeeId);
      }
    }

    await client.query('COMMIT');

    // Fetch full event with attendees
    const fullResult = await query(
      `SELECT e.*,
              u.display_name as creator_name,
              (
                SELECT json_agg(json_build_object(
                  'user_id', ea.user_id,
                  'display_name', au.display_name,
                  'status', ea.status
                ))
                FROM event_attendees ea
                JOIN users au ON au.id = ea.user_id
                WHERE ea.event_id = e.id
              ) as attendees
       FROM calendar_events e
       LEFT JOIN users u ON u.id = e.created_by
       WHERE e.id = $1`,
      [event.id]
    );

    const fullEvent = fullResult.rows[0];

    // Notify attendees via socket (real-time, in-app)
    const creatorName = fullEvent.creator_name || 'Someone';
    if (attendee_ids && Array.isArray(attendee_ids)) {
      const io = getIO();
      for (const attendeeId of attendee_ids) {
        if (attendeeId === userId) continue;
        io.to(`user:${attendeeId}`).emit('calendar:invitation', {
          event: fullEvent,
          invitedBy: { id: userId, display_name: creatorName },
        });
      }
    }

    // ── Send .ics email invites (out-of-band — failure here doesn't fail the API) ──
    // Attendees who use Outlook/Apple Mail get a native invite with
    // Accept/Decline/Tentative buttons in their inbox. Anyone can also use
    // the "Join meeting" button to open the LiveKit room from email.
    if (attendee_ids && Array.isArray(attendee_ids) && attendee_ids.length > 0) {
      const recipientIds = attendee_ids.filter((id: string) => id !== userId);
      if (recipientIds.length > 0) {
        // Fire-and-forget so a slow SMTP doesn't block the API response
        (async () => {
          try {
            const recipients = await resolveRecipients(recipientIds);
            if (recipients.length === 0) return;
            await sendInvite({
              uid: event.id,
              organiserUserId: userId,
              recipients,
              title: event.title,
              description: event.description || undefined,
              location: event.location || undefined,
              meetingUrl: livekitCallId ? buildMeetingUrl(livekitCallId, req) : undefined,
              startUtc: new Date(event.start_time),
              endUtc: new Date(event.end_time),
              sequence: 0,
            });
          } catch (err: any) {
            console.warn('[Calendar] email invite send failed (non-fatal):', err?.message || err);
          }
        })();
      }
    }

    res.status(201).json({ event: fullEvent });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── UPDATE EVENT ────────────────────────────────────────

router.put('/events/:eventId', async (req: AuthRequest, res: Response) => {
  const client = await pool.connect();
  try {
    const userId = req.user!.userId;
    const eventId = req.params.eventId;

    // Verify creator
    const existing = await client.query(
      'SELECT * FROM calendar_events WHERE id = $1 AND created_by = $2',
      [eventId, userId]
    );
    if (existing.rows.length === 0) {
      return res.status(403).json({ error: 'Only the event creator can edit' });
    }

    const { title, description, start_time, end_time, is_all_day, location, color, attendee_ids, reminder_minutes } = req.body;

    // Only override the reminder when the client actually sent a value, so an
    // edit that omits the field keeps the existing reminder.
    const reminderMinutes = reminder_minutes === undefined ? null : normalizeReminderMinutes(reminder_minutes);

    await client.query('BEGIN');

    // Bump iCal SEQUENCE counter so recipient mail clients replace the
    // existing entry instead of duplicating it. Combined with the bump in
    // updated_at, this is the standard CalDAV update pattern.
    await client.query(
      `UPDATE calendar_events
       SET title = COALESCE($1, title),
           description = COALESCE($2, description),
           start_time = COALESCE($3, start_time),
           end_time = COALESCE($4, end_time),
           is_all_day = COALESCE($5, is_all_day),
           location = COALESCE($6, location),
           color = COALESCE($7, color),
           reminder_minutes = COALESCE($9, reminder_minutes),
           ical_sequence = ical_sequence + 1,
           updated_at = NOW()
       WHERE id = $8`,
      [title, description, start_time, end_time, is_all_day, location, color, eventId, reminderMinutes]
    );

    // Update attendees if provided
    if (attendee_ids && Array.isArray(attendee_ids)) {
      // Remove attendees not in new list (except creator)
      await client.query(
        `DELETE FROM event_attendees WHERE event_id = $1 AND user_id != $2 AND user_id != ALL($3::uuid[])`,
        [eventId, userId, attendee_ids]
      );
      // Add new attendees
      for (const attendeeId of attendee_ids) {
        if (attendeeId === userId) continue;
        await client.query(
          `INSERT INTO event_attendees (event_id, user_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (event_id, user_id) DO NOTHING`,
          [eventId, attendeeId]
        );
      }
    }

    await client.query('COMMIT');

    // Fetch updated event
    const fullResult = await query(
      `SELECT e.*, u.display_name as creator_name,
              (SELECT json_agg(json_build_object('user_id', ea.user_id, 'display_name', au.display_name, 'status', ea.status))
               FROM event_attendees ea JOIN users au ON au.id = ea.user_id WHERE ea.event_id = e.id) as attendees
       FROM calendar_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.id = $1`,
      [eventId]
    );

    // Notify attendees (real-time, in-app)
    const io = getIO();
    const updatedEvent = fullResult.rows[0];
    const attendees = updatedEvent?.attendees || [];
    for (const att of attendees) {
      if (att.user_id !== userId) {
        io.to(`user:${att.user_id}`).emit('calendar:event-updated', { event: updatedEvent });
      }
    }

    // ── Send .ics update emails (fire-and-forget) ──
    // Recipient calendars replace the existing entry because the UID stays
    // the same and SEQUENCE is bumped.
    const otherAttendees = (attendees as any[]).filter((a) => a.user_id !== userId);
    if (otherAttendees.length > 0) {
      const recipientIds = otherAttendees.map((a) => a.user_id);
      (async () => {
        try {
          const recipients = await resolveRecipients(recipientIds);
          if (recipients.length === 0) return;
          await sendUpdate({
            uid: updatedEvent.id,
            organiserUserId: userId,
            recipients,
            title: updatedEvent.title,
            description: updatedEvent.description || undefined,
            location: updatedEvent.location || undefined,
            meetingUrl: updatedEvent.livekit_call_id ? buildMeetingUrl(updatedEvent.livekit_call_id, req) : undefined,
            startUtc: new Date(updatedEvent.start_time),
            endUtc: new Date(updatedEvent.end_time),
            sequence: updatedEvent.ical_sequence || 1,
          });
        } catch (err: any) {
          console.warn('[Calendar] email update send failed (non-fatal):', err?.message || err);
        }
      })();
    }

    res.json({ event: updatedEvent });
  } catch (err: any) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ─── DELETE EVENT ─────────────────────────────────────────

router.delete('/events/:eventId', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const eventId = String(req.params.eventId);

    // ── Capture event details + attendees BEFORE deletion ──
    // Needed for the cancellation .ics email (we need title/time/etc) and the
    // SEQUENCE bump for proper iCal etiquette.
    const snapshot = await query(
      `SELECT e.*, u.display_name as creator_name
         FROM calendar_events e
         LEFT JOIN users u ON u.id = e.created_by
        WHERE e.id = $1 AND e.created_by = $2`,
      [eventId, userId],
    );
    if (snapshot.rows.length === 0) {
      return res.status(403).json({ error: 'Only the event creator can delete' });
    }
    const ev = snapshot.rows[0];

    const attendeesResult = await query(
      'SELECT user_id FROM event_attendees WHERE event_id = $1 AND user_id != $2',
      [eventId, userId]
    );
    const recipientIds = attendeesResult.rows.map((r: any) => r.user_id);

    // End the associated LiveKit call (if online meeting) — anyone trying to
    // join via a stale link after this will see "Meeting has ended".
    if (ev.livekit_call_id) {
      await query(
        `UPDATE call_history
            SET status = 'ended', ended_at = NOW()
          WHERE id = $1 AND status != 'ended'`,
        [ev.livekit_call_id],
      );
    }

    // Now delete the event row (ON DELETE CASCADE clears event_attendees)
    await query('DELETE FROM calendar_events WHERE id = $1', [eventId]);

    // In-app real-time notification
    const io = getIO();
    for (const att of attendeesResult.rows) {
      io.to(`user:${att.user_id}`).emit('calendar:event-deleted', { eventId });
    }

    // ── Send .ics cancellation emails (fire-and-forget) ──
    // METHOD=CANCEL — recipient calendars auto-remove the entry.
    if (recipientIds.length > 0) {
      const cancelSeq = (ev.ical_sequence || 0) + 1;
      (async () => {
        try {
          const recipients = await resolveRecipients(recipientIds);
          if (recipients.length === 0) return;
          await sendCancellation({
            uid: eventId,
            organiserUserId: userId,
            recipients,
            title: ev.title,
            description: ev.description || undefined,
            location: ev.location || undefined,
            meetingUrl: ev.livekit_call_id ? buildMeetingUrl(ev.livekit_call_id, req) : undefined,
            startUtc: new Date(ev.start_time),
            endUtc: new Date(ev.end_time),
            sequence: cancelSeq,
          });
        } catch (err: any) {
          console.warn('[Calendar] cancellation email send failed (non-fatal):', err?.message || err);
        }
      })();
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── RESPOND TO INVITATION ───────────────────────────────

router.patch('/events/:eventId/respond', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const { status } = req.body;

    if (!['accepted', 'declined', 'tentative'].includes(status)) {
      return res.status(400).json({ error: 'Status must be accepted, declined, or tentative' });
    }

    const result = await query(
      `UPDATE event_attendees SET status = $1, responded_at = NOW()
       WHERE event_id = $2 AND user_id = $3
       RETURNING *`,
      [status, req.params.eventId, userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'You are not an attendee of this event' });
    }

    // Notify event creator
    const eventResult = await query('SELECT created_by FROM calendar_events WHERE id = $1', [req.params.eventId]);
    if (eventResult.rows.length > 0) {
      const creatorId = eventResult.rows[0].created_by;
      const io = getIO();
      const userName = await query('SELECT display_name FROM users WHERE id = $1', [userId]);
      io.to(`user:${creatorId}`).emit('calendar:rsvp-updated', {
        eventId: req.params.eventId,
        userId,
        userName: userName.rows[0]?.display_name || 'Someone',
        status,
      });
    }

    res.json({ success: true, status });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── UPCOMING REMINDERS (drives the Teams-style popup) ───
//
// Returns the current user's meetings that are about to start, so the client
// can schedule the reminder popup. We return everything starting within the
// next 2 hours (and not yet over) where a reminder is enabled and the user
// hasn't declined — the client decides the exact fire moment from
// reminder_minutes. Kept deliberately small (no attendee join) for a fast,
// frequently-polled endpoint.
router.get('/reminders/upcoming', async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!.userId;
    const result = await query(
      `SELECT e.id, e.title, e.start_time, e.end_time, e.location, e.color,
              e.is_online_meeting, e.livekit_call_id, e.reminder_minutes,
              u.display_name AS creator_name
         FROM calendar_events e
         LEFT JOIN users u ON u.id = e.created_by
        WHERE e.reminder_minutes > 0
          AND e.end_time > NOW()
          AND e.start_time <= NOW() + INTERVAL '2 hours'
          AND (
            e.created_by = $1
            OR EXISTS (
              SELECT 1 FROM event_attendees ea
               WHERE ea.event_id = e.id AND ea.user_id = $1 AND ea.status <> 'declined'
            )
          )
        ORDER BY e.start_time ASC`,
      [userId],
    );
    res.json({ events: result.rows });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
