/**
 * Meeting notes pipeline — runs AFTER a meeting's audio is recorded by LiveKit
 * Egress:
 *
 *   egress .ogg file  ──►  faster-whisper (self-hosted STT)  ──►  transcript
 *                     ──►  Qwen summarizeMeeting()           ──►  notes
 *                     ──►  store in meeting_notes + email attendees
 *
 * The egress webhook (egress_ended) calls processMeetingRecording().
 */
import fs from 'fs';
import { query } from '../../database/connection';
import { summarizeMeeting, type MeetingNotes } from './ai.service';
import { sendSystemEmail } from '../email/email.service';
import { startMeetingAudioEgress } from '../../services/livekit.service';

const WHISPER_URL = process.env.WHISPER_URL || 'http://whisper:8000';
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'Systran/faster-whisper-base';

function esc(s: string): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Called when a meeting that opted into AI notes starts. Snapshots the attendee
 * list (name + email for the summary header and email delivery), starts the
 * audio egress, and inserts the meeting_notes row. Never throws into the call
 * flow — a recording failure must not break the meeting.
 */
export async function startMeetingNotesRecording(params: {
  callId: string;
  conversationId?: string | null;
  roomName: string;
  hostId: string;
  title?: string;
  /** Explicit attendee list (used for scheduled meetings that aren't tied to a
   *  conversation). If omitted, members are pulled from conversationId. */
  attendees?: { id: string; name: string; email: string }[];
  /** Calendar event id — attendees pulled from event_attendees if no list/conv. */
  calendarEventId?: string | null;
}): Promise<void> {
  const { callId, conversationId, roomName, hostId, title } = params;
  try {
    // Idempotency — never start a second recording for the same meeting (handles
    // the /join race where two first-joiners arrive together).
    const existing = await query('SELECT 1 FROM meeting_notes WHERE call_id = $1', [callId]);
    if (existing.rows.length > 0) return;

    let attendees = params.attendees;
    if (!attendees && conversationId) {
      const members = await query(
        `SELECT u.id, u.display_name, u.email
           FROM conversation_members cm JOIN users u ON u.id = cm.user_id
          WHERE cm.conversation_id = $1`,
        [conversationId],
      );
      attendees = members.rows.map((r) => ({ id: r.id, name: r.display_name, email: r.email }));
    } else if (!attendees && params.calendarEventId) {
      const rows = await query(
        `SELECT u.id, u.display_name, u.email
           FROM event_attendees ea JOIN users u ON u.id = ea.user_id
          WHERE ea.event_id = $1`,
        [params.calendarEventId],
      );
      attendees = rows.rows.map((r) => ({ id: r.id, name: r.display_name, email: r.email }));
    }
    attendees = attendees || [];

    const egress = await startMeetingAudioEgress(roomName);

    await query(
      `INSERT INTO meeting_notes
         (call_id, conversation_id, room_name, host_id, title, egress_id, audio_path, status, attendees, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        callId, conversationId ?? null, roomName, hostId, title || null,
        egress?.egressId || null, egress?.filepath || null,
        egress ? 'recording' : 'failed',
        JSON.stringify(attendees),
        egress ? null : 'egress failed to start',
      ],
    );
    console.log(`[MeetingNotes] recording ${egress ? 'started' : 'FAILED to start'} for room ${roomName}`);
  } catch (err: any) {
    console.error('[MeetingNotes] startMeetingNotesRecording error:', err.message);
  }
}

/** Send the recorded audio file to the self-hosted faster-whisper server. */
async function transcribeAudioFile(filepath: string): Promise<string> {
  const buf = await fs.promises.readFile(filepath);
  const form = new FormData();
  form.append('file', new Blob([buf]), filepath.split('/').pop() || 'audio.ogg');
  form.append('model', WHISPER_MODEL);
  form.append('response_format', 'text');

  const res = await fetch(`${WHISPER_URL}/v1/audio/transcriptions`, { method: 'POST', body: form as any });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Whisper failed (${res.status}): ${t.slice(0, 200)}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    const j: any = await res.json();
    return String(j?.text ?? '').trim();
  }
  return (await res.text()).trim();
}

/**
 * Full pipeline for one recorded meeting. Looks up the meeting_notes row by
 * egress id, transcribes, summarizes, stores, and emails attendees. Every
 * failure is recorded on the row (status='failed') — it never throws upstream.
 */
export async function processMeetingRecording(egressId: string, filepathFromWebhook?: string): Promise<void> {
  const rowRes = await query('SELECT * FROM meeting_notes WHERE egress_id = $1', [egressId]);
  const note = rowRes.rows[0];
  if (!note) {
    console.warn('[MeetingNotes] no meeting_notes row for egress', egressId);
    return;
  }

  const filepath = filepathFromWebhook || note.audio_path;
  if (!filepath || !fs.existsSync(filepath)) {
    await query(`UPDATE meeting_notes SET status='no_audio', error=$2 WHERE id=$1`, [note.id, 'recording file not found']);
    return;
  }

  try {
    await query(`UPDATE meeting_notes SET status='transcribing', audio_path=$2 WHERE id=$1`, [note.id, filepath]);
    const transcript = await transcribeAudioFile(filepath);

    if (!transcript || transcript.length < 5) {
      await query(`UPDATE meeting_notes SET status='no_audio', transcript=$2 WHERE id=$1`, [note.id, transcript || '']);
      return;
    }

    await query(`UPDATE meeting_notes SET status='summarizing', transcript=$2 WHERE id=$1`, [note.id, transcript]);

    const attendees: any[] = Array.isArray(note.attendees) ? note.attendees : [];
    const notes = await summarizeMeeting(transcript, {
      title: note.title || undefined,
      attendees: attendees.map((a) => a?.name).filter(Boolean),
    });

    await query(
      `UPDATE meeting_notes
         SET status='completed', summary=$2, decisions=$3, action_items=$4, completed_at=NOW()
       WHERE id=$1`,
      [note.id, notes.summary, JSON.stringify(notes.decisions), JSON.stringify(notes.actionItems)],
    );

    await emailNotes(note, notes);
    console.log(`[MeetingNotes] completed for room ${note.room_name} (${notes.actionItems.length} action items)`);
  } catch (err: any) {
    console.error('[MeetingNotes] processing failed:', err.message);
    await query(`UPDATE meeting_notes SET status='failed', error=$2 WHERE id=$1`, [note.id, (err.message || 'error').slice(0, 500)]);
  }
}

async function emailNotes(note: any, notes: MeetingNotes): Promise<void> {
  const attendees: any[] = Array.isArray(note.attendees) ? note.attendees : [];
  const emails = attendees.map((a) => a?.email).filter(Boolean);
  if (emails.length === 0) return;
  try {
    await sendSystemEmail({
      to: emails,
      subject: `Meeting notes — ${note.title || 'Meeting'}`,
      html: renderNotesEmail(note, notes),
      fromName: 'ICP Meeting Notes',
    });
  } catch (err: any) {
    console.warn('[MeetingNotes] email delivery failed:', err.message);
  }
}

/** Build the notes email (also reusable as the in-app view markup). */
export function renderNotesEmail(note: any, notes: MeetingNotes): string {
  const decisions = notes.decisions.length
    ? `<ul>${notes.decisions.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`
    : '<p style="color:#888">No explicit decisions recorded.</p>';

  const actions = notes.actionItems.length
    ? `<table style="width:100%;border-collapse:collapse;font-size:14px">
         <tr style="background:#F3F2FA;text-align:left">
           <th style="padding:6px 10px;border:1px solid #E6E6F2">Action</th>
           <th style="padding:6px 10px;border:1px solid #E6E6F2">Owner</th>
           <th style="padding:6px 10px;border:1px solid #E6E6F2">Due</th>
         </tr>
         ${notes.actionItems.map((a) => `
           <tr>
             <td style="padding:6px 10px;border:1px solid #E6E6F2">${esc(a.task)}</td>
             <td style="padding:6px 10px;border:1px solid #E6E6F2">${esc(a.owner) || '—'}</td>
             <td style="padding:6px 10px;border:1px solid #E6E6F2">${esc(a.due) || '—'}</td>
           </tr>`).join('')}
       </table>`
    : '<p style="color:#888">No action items recorded.</p>';

  return `
  <div style="font-family:'Segoe UI',Calibri,sans-serif;color:#242424;max-width:640px">
    <h2 style="color:#4338CA;margin:0 0 4px">📝 Meeting Notes</h2>
    <p style="color:#666;margin:0 0 16px">${esc(note.title || 'Meeting')}</p>
    <h3 style="margin:18px 0 6px">Summary</h3>
    <p style="line-height:1.6">${esc(notes.summary) || '<span style="color:#888">No summary.</span>'}</p>
    <h3 style="margin:18px 0 6px">Decisions</h3>
    ${decisions}
    <h3 style="margin:18px 0 6px">Action Items</h3>
    ${actions}
    <p style="margin-top:24px;color:#A0A0A0;font-size:12px">
      Generated automatically by ICP from the meeting recording. Please verify before acting on critical items.
    </p>
  </div>`;
}
