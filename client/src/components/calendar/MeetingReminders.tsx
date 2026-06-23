/**
 * MeetingReminders — Teams-style "your meeting is starting" popup.
 *
 * Client-driven (the reliable model for a web app): we fetch the user's
 * upcoming meetings from GET /calendar/reminders/upcoming, then show a popup the
 * moment a meeting enters its reminder window (start_time − reminder_minutes).
 * The card stays until the user dismisses it or the meeting ends, shows a live
 * "in X min" countdown, and offers a Join button for online meetings.
 *
 * Mounted once globally in AppLayout so it works on any tab.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Video, MapPin, X } from 'lucide-react';
import api from '@/services/api';
import { getSocket } from '@/services/socket';
import { getNotificationPrefs, playReminderSound, showDesktopNotification } from '@/services/notification';

interface UpcomingEvent {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  location: string | null;
  color: string | null;
  is_online_meeting: boolean;
  livekit_call_id: string | null;
  reminder_minutes: number;
  creator_name: string | null;
}

const DISMISSED_KEY = 'dismissedMeetingReminders';

/** Dismissal key includes start_time so a rescheduled meeting re-alerts. */
const dismissKey = (e: UpcomingEvent) => `${e.id}:${e.start_time}`;

function loadDismissed(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}');
    // Prune entries older than 24h so the map can't grow forever.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const pruned: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number' && v > cutoff) pruned[k] = v;
    }
    return pruned;
  } catch {
    return {};
  }
}

export default function MeetingReminders() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<UpcomingEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [dismissed, setDismissed] = useState<Record<string, number>>(loadDismissed);
  // Tracks which reminders we've already chimed/notified for, so re-renders
  // every few seconds don't replay the sound.
  const announcedRef = useRef<Set<string>>(new Set());

  const fetchUpcoming = useCallback(async () => {
    try {
      const { data } = await api.get<{ events: UpcomingEvent[] }>('/calendar/reminders/upcoming');
      setEvents(data.events || []);
    } catch {
      /* transient — keep the last list, try again next tick */
    }
  }, []);

  // Fetch on mount, every 60s, and whenever the socket (re)connects.
  useEffect(() => {
    fetchUpcoming();
    const poll = setInterval(fetchUpcoming, 60_000);
    const socket = getSocket();
    socket?.on('connect', fetchUpcoming);
    return () => {
      clearInterval(poll);
      socket?.off('connect', fetchUpcoming);
    };
  }, [fetchUpcoming]);

  // Re-evaluate which reminders are due every 5s (also drives the countdown).
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(tick);
  }, []);

  // A meeting is "due" once it's inside its reminder window and not yet over.
  const isDue = useCallback((e: UpcomingEvent, t: number) => {
    const start = new Date(e.start_time).getTime();
    const end = new Date(e.end_time).getTime();
    const fireAt = start - e.reminder_minutes * 60_000;
    return t >= fireAt && t < end;
  }, []);

  const active = events.filter((e) => isDue(e, now) && !dismissed[dismissKey(e)]);

  // Chime + desktop notification once per reminder as it becomes due.
  useEffect(() => {
    for (const e of active) {
      const key = dismissKey(e);
      if (announcedRef.current.has(key)) continue;
      announcedRef.current.add(key);

      const prefs = getNotificationPrefs();
      if (prefs.sound) playReminderSound();
      showDesktopNotification({
        title: e.title,
        body: `Starting ${startsInLabel(e.start_time, Date.now())}`,
        tag: `reminder-${e.id}`,
        requireInteraction: true,
        onClick: () => joinOrView(e),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active.map((e) => dismissKey(e)).join(',')]);

  const dismiss = (e: UpcomingEvent) => {
    setDismissed((prev) => {
      const next = { ...prev, [dismissKey(e)]: Date.now() };
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const dismissAll = () => {
    setDismissed((prev) => {
      const next = { ...prev };
      for (const e of active) next[dismissKey(e)] = Date.now();
      try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  const joinOrView = (e: UpcomingEvent) => {
    dismiss(e);
    if (e.is_online_meeting && e.livekit_call_id) {
      navigate(`/meeting/${e.livekit_call_id}`);
    }
  };

  if (active.length === 0) return null;

  return (
    <div
      style={{
        position: 'fixed', top: 16, right: 16, zIndex: 3000,
        display: 'flex', flexDirection: 'column', gap: 10, width: 340, maxWidth: 'calc(100vw - 32px)',
      }}
    >
      {/* Header — only when more than one reminder is stacked */}
      {active.length > 1 && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 4px' }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#5A5A72' }}>
            {active.length} reminders
          </span>
          <button
            onClick={dismissAll}
            style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#6264A7' }}
          >
            Dismiss all
          </button>
        </div>
      )}

      {active.map((e) => (
        <ReminderCard key={e.id} event={e} now={now} onDismiss={() => dismiss(e)} onJoin={() => joinOrView(e)} />
      ))}
    </div>
  );
}

function ReminderCard({ event, now, onDismiss, onJoin }: { event: UpcomingEvent; now: number; onDismiss: () => void; onJoin: () => void }) {
  const accent = event.color || '#6264A7';
  const canJoin = event.is_online_meeting && !!event.livekit_call_id;
  const start = new Date(event.start_time);
  const timeStr = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  return (
    <div
      style={{
        background: '#fff', borderRadius: 12, boxShadow: '0 8px 28px rgba(20,20,40,0.18)',
        border: '1px solid #ECECF4', borderLeft: `4px solid ${accent}`, overflow: 'hidden',
        animation: 'reminderIn 0.25s cubic-bezier(0.2,0.8,0.2,1)',
      }}
    >
      <div style={{ padding: '14px 14px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: '#F0F0FA', color: accent, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <CalendarClock size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#1A1A2E', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {event.title}
            </div>
            <div style={{ fontSize: 12, color: '#8B8CA7', marginTop: 2, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>{timeStr}</span>
              {event.is_online_meeting && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                  <Video size={12} /> Online meeting
                </span>
              )}
              {!event.is_online_meeting && event.location && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 140 }}>
                  <MapPin size={12} /> {event.location}
                </span>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: accent, whiteSpace: 'nowrap' }}>
              {startsInLabel(event.start_time, now)}
            </span>
            <button
              onClick={onDismiss}
              title="Dismiss"
              style={{ width: 24, height: 24, borderRadius: 6, border: 'none', background: 'transparent', color: '#A0A1BC', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={15} />
            </button>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, padding: '0 14px 14px', justifyContent: 'flex-end' }}>
        <button
          onClick={onDismiss}
          style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #ECECF4', background: '#fff', fontSize: 12, fontWeight: 600, color: '#5A5A72', cursor: 'pointer', fontFamily: 'inherit' }}
        >
          Dismiss
        </button>
        {canJoin && (
          <button
            onClick={onJoin}
            style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: '#6264A7', fontSize: 12, fontWeight: 700, color: '#fff', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'inherit' }}
          >
            <Video size={13} /> Join
          </button>
        )}
      </div>

      <style>{`@keyframes reminderIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }`}</style>
    </div>
  );
}

/** "in 15 min" / "in 1 min" / "Now" / "Started 3 min ago" — Teams-style. */
function startsInLabel(startIso: string, now: number): string {
  const diffMs = new Date(startIso).getTime() - now;
  const mins = Math.round(diffMs / 60_000);
  if (mins > 1) return `in ${mins} min`;
  if (mins === 1) return 'in 1 min';
  if (mins === 0) return 'Now';
  const ago = Math.abs(mins);
  return ago === 1 ? 'Started 1 min ago' : `Started ${ago} min ago`;
}
