import React, { useState, useEffect, useRef } from 'react';
import { X, MapPin, Clock, Users, FileText, Palette, Video, Link2, Check } from 'lucide-react';
import api from '@/services/api';

/* ===================================================================
   TYPES
   =================================================================== */
interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  is_all_day: boolean;
  location: string | null;
  color: string;
  created_by: string;
  attendees: { user_id: string; display_name: string; status: string }[] | null;
  // Phase A — online meeting fields
  is_online_meeting?: boolean;
  livekit_call_id?: string | null;
}

interface Contact {
  id: string;
  display_name: string;
  email: string;
  department?: string;
}

interface Props {
  editingEvent: CalendarEvent | null;
  prefillTime: { start: Date; end: Date } | null;
  onClose: () => void;
  onSaved: () => void;
}

const EVENT_COLORS = ['#5B5FC7', '#107C10', '#D83B01', '#008272', '#B4009E', '#E81123', '#00188F', '#FFB900'];

function toLocalDateTimeStr(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

const AVATAR_COLORS = ['#5B5FC7', '#107C10', '#D83B01', '#5C2D91', '#008272', '#B4009E', '#E81123', '#00188F'];
function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

/* ===================================================================
   COMPONENT
   =================================================================== */
export default function CreateEventModal({ editingEvent, prefillTime, onClose, onSaved }: Props) {
  // Defaults
  const defaultStart = prefillTime?.start || new Date();
  const defaultEnd = prefillTime?.end || (() => { const d = new Date(); d.setHours(d.getHours() + 1); return d; })();

  const [title, setTitle] = useState(editingEvent?.title || '');
  const [startTime, setStartTime] = useState(
    editingEvent ? toLocalDateTimeStr(new Date(editingEvent.start_time)) : toLocalDateTimeStr(defaultStart)
  );
  const [endTime, setEndTime] = useState(
    editingEvent ? toLocalDateTimeStr(new Date(editingEvent.end_time)) : toLocalDateTimeStr(defaultEnd)
  );
  const [isAllDay, setIsAllDay] = useState(editingEvent?.is_all_day || false);
  const [location, setLocation] = useState(editingEvent?.location || '');
  const [description, setDescription] = useState(editingEvent?.description || '');
  const [color, setColor] = useState(editingEvent?.color || '#5B5FC7');
  const [saving, setSaving] = useState(false);
  // Phase A — online meeting state
  // When editing an existing online meeting, pre-fill the toggle to ON
  // and the link gets displayed below the toggle (read-only after creation —
  // the meeting URL is the /meeting/<livekit_call_id> stable link).
  const [isOnlineMeeting, setIsOnlineMeeting] = useState(!!editingEvent?.is_online_meeting);
  const [linkCopied, setLinkCopied] = useState(false);

  // Attendees
  const [attendees, setAttendees] = useState<Contact[]>([]);
  const [attendeeSearch, setAttendeeSearch] = useState('');
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  // Pre-fill attendees from editing event
  useEffect(() => {
    if (editingEvent?.attendees) {
      const existing = editingEvent.attendees
        .filter(a => a.user_id !== editingEvent.created_by)
        .map(a => ({
          id: a.user_id,
          display_name: a.display_name,
          email: '',
        }));
      setAttendees(existing);
    }
  }, [editingEvent]);

  // Load contacts for search
  useEffect(() => {
    api.get('/email/contacts').then(({ data }) => {
      setContacts(data.contacts || []);
    }).catch(() => {});
  }, []);

  const filteredContacts = attendeeSearch.trim().length >= 1
    ? contacts.filter(c =>
        (c.display_name.toLowerCase().includes(attendeeSearch.toLowerCase()) ||
         c.email.toLowerCase().includes(attendeeSearch.toLowerCase())) &&
        !attendees.some(a => a.id === c.id)
      ).slice(0, 6)
    : [];

  const addAttendee = (contact: Contact) => {
    setAttendees(prev => [...prev, contact]);
    setAttendeeSearch('');
    setShowSuggestions(false);
    searchRef.current?.focus();
  };

  const removeAttendee = (id: string) => {
    setAttendees(prev => prev.filter(a => a.id !== id));
  };

  const handleSave = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const payload = {
        title: title.trim(),
        description: description.trim() || null,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
        is_all_day: isAllDay,
        location: location.trim() || null,
        color,
        attendee_ids: attendees.map(a => a.id),
        is_online_meeting: isOnlineMeeting,
      };

      if (editingEvent) {
        await api.put(`/calendar/events/${editingEvent.id}`, payload);
      } else {
        await api.post('/calendar/events', payload);
      }
      onSaved();
    } catch (err: any) {
      alert('Failed to save event: ' + (err.response?.data?.error || err.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 2000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: 480, maxHeight: '90vh', background: '#fff', borderRadius: 12,
        boxShadow: '0 12px 40px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px', borderBottom: '1px solid #E8E8E8', flexShrink: 0,
        }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, color: '#242424', margin: 0 }}>
            {editingEvent ? 'Edit Event' : 'New Event'}
          </h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4, color: '#8B8CA7' }}>
            <X size={20} />
          </button>
        </div>

        {/* Form */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
          {/* Title */}
          <input
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Add a title"
            autoFocus
            style={{
              width: '100%', padding: '10px 12px', fontSize: 15, fontWeight: 600,
              border: '1px solid #E0E0E0', borderRadius: 6, outline: 'none',
              color: '#242424', marginBottom: 16,
              boxSizing: 'border-box',
            }}
            onFocus={e => { e.currentTarget.style.borderColor = '#5B5FC7'; }}
            onBlur={e => { e.currentTarget.style.borderColor = '#E0E0E0'; }}
          />

          {/* Date/Time */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Clock size={16} color="#8B8CA7" style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <input
                type="datetime-local"
                value={startTime}
                onChange={e => setStartTime(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #E0E0E0', borderRadius: 4, fontSize: 12, color: '#424242', outline: 'none' }}
              />
              <span style={{ fontSize: 12, color: '#8B8CA7' }}>to</span>
              <input
                type="datetime-local"
                value={endTime}
                onChange={e => setEndTime(e.target.value)}
                style={{ padding: '6px 8px', border: '1px solid #E0E0E0', borderRadius: 4, fontSize: 12, color: '#424242', outline: 'none' }}
              />
            </div>
          </div>

          {/* All day toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, marginLeft: 24 }}>
            <input
              type="checkbox"
              checked={isAllDay}
              onChange={e => setIsAllDay(e.target.checked)}
              style={{ cursor: 'pointer' }}
            />
            <span style={{ fontSize: 12, color: '#616161' }}>All day</span>
          </div>

          {/* Location */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <MapPin size={16} color="#8B8CA7" style={{ flexShrink: 0 }} />
            <input
              value={location}
              onChange={e => setLocation(e.target.value)}
              placeholder="Add location"
              style={{
                flex: 1, padding: '8px 10px', border: '1px solid #E0E0E0', borderRadius: 4,
                fontSize: 13, color: '#424242', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Online meeting toggle — Teams-style.
              When ON: an LiveKit meeting link is auto-generated on Save.
              That link is emailed to every attendee in the .ics invite and
              opens the meeting via /meeting/<callId>. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <Video size={16} color="#8B8CA7" style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#242424' }}>Online meeting</div>
                <div style={{ fontSize: 11, color: '#8B8CA7', marginTop: 2 }}>
                  {isOnlineMeeting
                    ? 'A meeting link will be created and emailed to attendees'
                    : 'Generate a join link and email it to attendees'}
                </div>
              </div>
              {/* iOS-style switch */}
              <button
                type="button"
                role="switch"
                aria-checked={isOnlineMeeting}
                onClick={() => setIsOnlineMeeting(v => !v)}
                style={{
                  width: 42, height: 24, borderRadius: 999,
                  background: isOnlineMeeting ? '#5B5FC7' : '#D0D0D0',
                  border: 'none', cursor: 'pointer', position: 'relative',
                  transition: 'background 0.15s', padding: 0, flexShrink: 0,
                }}
              >
                <span style={{
                  position: 'absolute', top: 2, left: isOnlineMeeting ? 20 : 2,
                  width: 20, height: 20, borderRadius: '50%', background: '#fff',
                  transition: 'left 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                }} />
              </button>
            </div>
          </div>

          {/* Meeting link display — shows AFTER an online event is saved.
              The link is built from livekit_call_id which only exists after
              POST returns. So during NEW event creation we just show a
              promise ("A link will be created"); during EDIT we show the
              actual link with a Copy button. */}
          {isOnlineMeeting && editingEvent?.livekit_call_id && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
              padding: '10px 12px', background: '#F0F4FF', borderRadius: 6,
              border: '1px solid #D6DDF7',
            }}>
              <Link2 size={14} color="#5B5FC7" style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: '#5B5FC7', fontWeight: 600, marginBottom: 2 }}>Meeting link</div>
                <div style={{
                  fontSize: 12, color: '#242424',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {`${window.location.origin}/meeting/${editingEvent.livekit_call_id}`}
                </div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  const url = `${window.location.origin}/meeting/${editingEvent.livekit_call_id}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    setLinkCopied(true);
                    setTimeout(() => setLinkCopied(false), 2000);
                  } catch {
                    window.prompt('Copy this meeting link:', url);
                  }
                }}
                style={{
                  padding: '6px 10px', fontSize: 11, fontWeight: 600,
                  background: linkCopied ? '#107C10' : '#5B5FC7',
                  color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
                }}
              >
                {linkCopied ? <><Check size={11} /> Copied</> : <>Copy</>}
              </button>
            </div>
          )}

          {/* Description */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <FileText size={16} color="#8B8CA7" style={{ flexShrink: 0, marginTop: 6 }} />
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Add description"
              rows={3}
              style={{
                flex: 1, padding: '8px 10px', border: '1px solid #E0E0E0', borderRadius: 4,
                fontSize: 13, color: '#424242', outline: 'none', resize: 'vertical',
                fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Color picker */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
            <Palette size={16} color="#8B8CA7" style={{ flexShrink: 0 }} />
            <div style={{ display: 'flex', gap: 6 }}>
              {EVENT_COLORS.map(c => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 22, height: 22, borderRadius: '50%', border: color === c ? '2px solid #242424' : '2px solid transparent',
                    background: c, cursor: 'pointer', padding: 0,
                    transition: 'border 0.1s',
                  }}
                />
              ))}
            </div>
          </div>

          {/* Attendees */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <Users size={16} color="#8B8CA7" style={{ flexShrink: 0, marginTop: 8 }} />
            <div style={{ flex: 1, position: 'relative' }}>
              {/* Chips */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
                {attendees.map(a => (
                  <span key={a.id} style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 8px 3px 4px',
                    background: '#E8EBFA', borderRadius: 12, fontSize: 11, color: '#5B5FC7', fontWeight: 500,
                  }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%', background: getAvatarColor(a.display_name),
                      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700,
                    }}>
                      {getInitials(a.display_name)}
                    </div>
                    {a.display_name}
                    <button onClick={() => removeAttendee(a.id)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: '#5B5FC7', display: 'flex' }}>
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>

              {/* Search input */}
              <input
                ref={searchRef}
                value={attendeeSearch}
                onChange={e => { setAttendeeSearch(e.target.value); setShowSuggestions(true); }}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 180)}
                placeholder="Search people to invite..."
                style={{
                  width: '100%', padding: '8px 10px', border: '1px solid #E0E0E0', borderRadius: 4,
                  fontSize: 12, color: '#424242', outline: 'none', boxSizing: 'border-box',
                }}
              />

              {/* Suggestions dropdown */}
              {showSuggestions && filteredContacts.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10,
                  background: '#fff', borderRadius: 6, boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                  border: '1px solid #E8E8E8', maxHeight: 200, overflowY: 'auto',
                }}>
                  {filteredContacts.map(c => (
                    <div
                      key={c.id}
                      onMouseDown={() => addAttendee(c)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#F5F5FA'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
                    >
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%', background: getAvatarColor(c.display_name),
                        color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700,
                      }}>
                        {getInitials(c.display_name)}
                      </div>
                      <div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#242424' }}>{c.display_name}</div>
                        <div style={{ fontSize: 10, color: '#8B8CA7' }}>{c.email}</div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: 8,
          padding: '12px 20px', borderTop: '1px solid #E8E8E8', flexShrink: 0,
        }}>
          <button onClick={onClose} style={{
            padding: '8px 20px', borderRadius: 6, border: '1px solid #E0E0E0',
            background: '#fff', color: '#616161', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}>
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!title.trim() || saving}
            style={{
              padding: '8px 24px', borderRadius: 6, border: 'none',
              background: title.trim() ? '#5B5FC7' : '#B0B0B0',
              color: '#fff', fontSize: 13, fontWeight: 600,
              cursor: title.trim() ? 'pointer' : 'not-allowed',
              boxShadow: title.trim() ? '0 2px 6px rgba(91,95,199,0.3)' : 'none',
            }}
          >
            {saving ? 'Saving...' : editingEvent ? 'Update' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
