import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Calendar, ChevronLeft, ChevronRight, Plus, Clock, MapPin,
  Check, X, HelpCircle, Trash2, Edit3, Loader2, Users, Video,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import api from '@/services/api';
import { getSocket } from '@/services/socket';
import CreateEventModal from './CreateEventModal';

/* ===================================================================
   TYPES
   =================================================================== */
interface Attendee {
  user_id: string;
  display_name: string;
  status: 'accepted' | 'declined' | 'tentative' | 'pending';
}

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
  creator_name: string;
  attendees: Attendee[] | null;
  created_at: string;
  // Phase A — online meeting (Teams-style)
  is_online_meeting?: boolean;
  livekit_call_id?: string | null;
}

type ViewMode = 'week' | 'day';

/* ===================================================================
   HELPERS
   =================================================================== */
const HOUR_HEIGHT = 56;
const HOURS_START = 6; // 6 AM
const HOURS_END = 22;  // 10 PM
const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const EVENT_COLORS = ['#5B5FC7', '#107C10', '#D83B01', '#008272', '#B4009E', '#E81123', '#00188F', '#FFB900'];

function getWeekStart(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  d.setHours(0, 0, 0, 0);
  return d;
}

function getWeekDays(date: Date): Date[] {
  const start = getWeekStart(date);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function getMonthGrid(year: number, month: number): (Date | null)[][] {
  const firstDay = new Date(year, month, 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weeks: (Date | null)[][] = [];
  let week: (Date | null)[] = [];
  for (let i = 0; i < startOffset; i++) week.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    week.push(new Date(year, month, d));
    if (week.length === 7) { weeks.push(week); week = []; }
  }
  if (week.length > 0) {
    while (week.length < 7) week.push(null);
    weeks.push(week);
  }
  return weeks;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatHour(h: number): string {
  if (h === 0) return '12 AM';
  if (h < 12) return `${h} AM`;
  if (h === 12) return '12 PM';
  return `${h - 12} PM`;
}

function formatEventTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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
   MAIN COMPONENT
   =================================================================== */
export default function CalendarWindow() {
  const { user } = useAuthStore();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [viewMode, setViewMode] = useState<ViewMode>('week');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<CalendarEvent | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const [prefillTime, setPrefillTime] = useState<{ start: Date; end: Date } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const today = useMemo(() => new Date(), []);
  const weekDays = useMemo(() => getWeekDays(currentDate), [currentDate]);

  // Fetch events for visible range
  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      let start: Date, end: Date;
      if (viewMode === 'week') {
        start = getWeekStart(currentDate);
        end = new Date(start);
        end.setDate(end.getDate() + 7);
      } else {
        start = new Date(currentDate);
        start.setHours(0, 0, 0, 0);
        end = new Date(currentDate);
        end.setHours(23, 59, 59, 999);
      }
      const { data } = await api.get('/calendar/events', {
        params: { start: start.toISOString(), end: end.toISOString() },
      });
      setEvents(data.events || []);
    } catch (err) {
      console.error('Failed to fetch calendar events:', err);
    } finally {
      setLoading(false);
    }
  }, [currentDate, viewMode]);

  useEffect(() => { fetchEvents(); }, [fetchEvents]);

  // Socket listeners for real-time updates
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const onInvitation = () => fetchEvents();
    const onUpdated = () => fetchEvents();
    const onDeleted = (data: any) => {
      setEvents(prev => prev.filter(e => e.id !== data.eventId));
      if (selectedEvent?.id === data.eventId) setSelectedEvent(null);
    };
    const onRsvp = () => fetchEvents();

    socket.on('calendar:invitation', onInvitation);
    socket.on('calendar:event-updated', onUpdated);
    socket.on('calendar:event-deleted', onDeleted);
    socket.on('calendar:rsvp-updated', onRsvp);
    return () => {
      socket.off('calendar:invitation', onInvitation);
      socket.off('calendar:event-updated', onUpdated);
      socket.off('calendar:event-deleted', onDeleted);
      socket.off('calendar:rsvp-updated', onRsvp);
    };
  }, [fetchEvents, selectedEvent?.id]);

  // Scroll to 8 AM on mount
  useEffect(() => {
    if (gridRef.current) {
      gridRef.current.scrollTop = (8 - HOURS_START) * HOUR_HEIGHT;
    }
  }, []);

  // Navigation
  const navigate = (dir: -1 | 1) => {
    setCurrentDate(prev => {
      const d = new Date(prev);
      d.setDate(d.getDate() + (viewMode === 'week' ? 7 * dir : dir));
      return d;
    });
  };

  const goToday = () => setCurrentDate(new Date());

  // Click on empty grid cell
  const handleGridClick = (day: Date, hour: number) => {
    const start = new Date(day);
    start.setHours(hour, 0, 0, 0);
    const end = new Date(start);
    end.setHours(hour + 1);
    setPrefillTime({ start, end });
    setEditingEvent(null);
    setShowCreateModal(true);
  };

  // Click on event block
  const handleEventClick = (event: CalendarEvent, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedEvent(event);
    const rect = (e.target as HTMLElement).getBoundingClientRect();
    setPopupPos({ x: rect.right + 8, y: rect.top });
  };

  // RSVP
  const handleRsvp = async (status: 'accepted' | 'declined' | 'tentative') => {
    if (!selectedEvent) return;
    try {
      await api.patch(`/calendar/events/${selectedEvent.id}/respond`, { status });
      fetchEvents();
      setSelectedEvent(null);
    } catch (err) {
      console.error('RSVP failed:', err);
    }
  };

  // Delete
  const handleDelete = async () => {
    if (!selectedEvent) return;
    try {
      await api.delete(`/calendar/events/${selectedEvent.id}`);
      setEvents(prev => prev.filter(e => e.id !== selectedEvent.id));
      setSelectedEvent(null);
    } catch (err) {
      console.error('Delete failed:', err);
    }
  };

  // Edit
  const handleEdit = () => {
    if (!selectedEvent) return;
    setEditingEvent(selectedEvent);
    setShowCreateModal(true);
    setSelectedEvent(null);
  };

  // Date range label
  const rangeLabel = useMemo(() => {
    if (viewMode === 'day') {
      return currentDate.toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    const start = weekDays[0];
    const end = weekDays[6];
    if (start.getMonth() === end.getMonth()) {
      return `${start.getDate()} - ${end.getDate()} ${MONTH_NAMES[start.getMonth()]}, ${start.getFullYear()}`;
    }
    return `${MONTH_NAMES[start.getMonth()].slice(0, 3)} ${start.getDate()} - ${MONTH_NAMES[end.getMonth()].slice(0, 3)} ${end.getDate()}, ${end.getFullYear()}`;
  }, [weekDays, viewMode, currentDate]);

  // Mini calendar month
  const [miniMonth, setMiniMonth] = useState(currentDate.getMonth());
  const [miniYear, setMiniYear] = useState(currentDate.getFullYear());
  const miniGrid = useMemo(() => getMonthGrid(miniYear, miniMonth), [miniYear, miniMonth]);

  const miniPrev = () => { if (miniMonth === 0) { setMiniMonth(11); setMiniYear(y => y - 1); } else setMiniMonth(m => m - 1); };
  const miniNext = () => { if (miniMonth === 11) { setMiniMonth(0); setMiniYear(y => y + 1); } else setMiniMonth(m => m + 1); };

  // Get events for a specific day
  const getEventsForDay = (day: Date): CalendarEvent[] => {
    return events.filter(ev => {
      const start = new Date(ev.start_time);
      const end = new Date(ev.end_time);
      const dayStart = new Date(day); dayStart.setHours(0, 0, 0, 0);
      const dayEnd = new Date(day); dayEnd.setHours(23, 59, 59, 999);
      return start < dayEnd && end > dayStart;
    });
  };

  return (
    <div style={{ display: 'flex', height: '100%', background: '#F5F5F5', position: 'relative' }}>
      {/* ─── Left Panel: Mini Calendar ─── */}
      <div style={{ width: 280, minWidth: 240, background: '#fff', borderRight: '1px solid #E0E0E0', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        {/* New Event Button */}
        <div style={{ padding: 16 }}>
          <button
            onClick={() => { setEditingEvent(null); setPrefillTime(null); setShowCreateModal(true); }}
            style={{
              width: '100%', padding: '10px 0', borderRadius: 8, border: 'none',
              background: '#5B5FC7', color: '#fff', fontSize: 14, fontWeight: 600,
              cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              boxShadow: '0 2px 6px rgba(91,95,199,0.3)', transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#4B4FB7'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#5B5FC7'; }}
          >
            <Plus size={16} /> New event
          </button>
        </div>

        {/* Mini Month Calendar */}
        <div style={{ padding: '0 16px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <button onClick={miniPrev} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4, color: '#616161' }}><ChevronLeft size={16} /></button>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#242424' }}>{MONTH_NAMES[miniMonth]} {miniYear}</span>
            <button onClick={miniNext} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4, color: '#616161' }}><ChevronRight size={16} /></button>
          </div>

          {/* Day headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0, marginBottom: 4 }}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <div key={i} style={{ textAlign: 'center', fontSize: 10, fontWeight: 600, color: '#8B8CA7', padding: '2px 0' }}>{d}</div>
            ))}
          </div>

          {/* Days grid */}
          {miniGrid.map((week, wi) => (
            <div key={wi} style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 0 }}>
              {week.map((day, di) => {
                if (!day) return <div key={di} />;
                const isToday = isSameDay(day, today);
                const isSelected = isSameDay(day, currentDate);
                const isCurrentMonth = day.getMonth() === miniMonth;
                return (
                  <button
                    key={di}
                    onClick={() => { setCurrentDate(new Date(day)); }}
                    style={{
                      width: 28, height: 28, margin: '1px auto', borderRadius: '50%',
                      border: 'none', cursor: 'pointer',
                      background: isToday ? '#5B5FC7' : isSelected ? '#E8EBFA' : 'transparent',
                      color: isToday ? '#fff' : isCurrentMonth ? '#242424' : '#C0C0C0',
                      fontSize: 11, fontWeight: isToday || isSelected ? 600 : 400,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => { if (!isToday && !isSelected) e.currentTarget.style.background = '#F0F0F5'; }}
                    onMouseLeave={e => { if (!isToday && !isSelected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {day.getDate()}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* My Calendars */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #F0F0F0' }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: '#8B8CA7', margin: '0 0 8px', textTransform: 'uppercase', letterSpacing: 0.5 }}>My calendars</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 14, height: 14, borderRadius: 3, background: '#5B5FC7' }} />
            <span style={{ fontSize: 13, color: '#242424' }}>Calendar</span>
          </div>
        </div>
      </div>

      {/* ─── Right Panel: Week/Day Grid ─── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Toolbar */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px',
          background: '#fff', borderBottom: '1px solid #E0E0E0', flexShrink: 0, flexWrap: 'wrap',
        }}>
          <button onClick={goToday} style={{
            display: 'flex', alignItems: 'center', gap: 4, padding: '6px 14px', borderRadius: 6,
            border: '1px solid #E0E0E0', background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500, color: '#242424',
          }}>
            <Calendar size={14} /> Today
          </button>

          <button onClick={() => navigate(-1)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4, color: '#616161' }}>
            <ChevronLeft size={18} />
          </button>
          <button onClick={() => navigate(1)} style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 4, color: '#616161' }}>
            <ChevronRight size={18} />
          </button>

          <span style={{ fontSize: 15, fontWeight: 600, color: '#242424' }}>{rangeLabel}</span>

          <div style={{ flex: 1 }} />

          {/* View toggle */}
          <div style={{ display: 'flex', border: '1px solid #E0E0E0', borderRadius: 6, overflow: 'hidden' }}>
            {(['day', 'week'] as ViewMode[]).map(mode => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  padding: '5px 14px', border: 'none', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                  background: viewMode === mode ? '#E8EBFA' : '#fff',
                  color: viewMode === mode ? '#5B5FC7' : '#616161',
                }}
              >
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Day Headers */}
        <div style={{ display: 'flex', background: '#fff', borderBottom: '1px solid #E0E0E0', flexShrink: 0 }}>
          {/* Time gutter spacer */}
          <div style={{ width: 60, flexShrink: 0 }} />
          {(viewMode === 'week' ? weekDays : [currentDate]).map((day, i) => {
            const isToday2 = isSameDay(day, today);
            return (
              <div key={i} style={{
                flex: 1, textAlign: 'center', padding: '8px 0',
                borderLeft: i > 0 ? '1px solid #F0F0F0' : 'none',
              }}>
                <div style={{ fontSize: 11, color: isToday2 ? '#5B5FC7' : '#8B8CA7', fontWeight: 500, textTransform: 'uppercase' }}>
                  {DAY_NAMES_SHORT[day.getDay()]}
                </div>
                <div style={{
                  fontSize: 20, fontWeight: 600, marginTop: 2,
                  color: isToday2 ? '#fff' : '#242424',
                  background: isToday2 ? '#5B5FC7' : 'transparent',
                  width: 32, height: 32, borderRadius: '50%',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  {day.getDate()}
                </div>
              </div>
            );
          })}
        </div>

        {/* Time Grid */}
        <div ref={gridRef} style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}>
          {loading && (
            <div style={{ position: 'absolute', top: 8, right: 16, zIndex: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Loader2 size={14} style={{ color: '#5B5FC7', animation: 'spin 1s linear infinite' }} />
              <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}`}</style>
            </div>
          )}

          <div style={{ display: 'flex', position: 'relative' }}>
            {/* Hour labels */}
            <div style={{ width: 60, flexShrink: 0 }}>
              {Array.from({ length: HOURS_END - HOURS_START }, (_, i) => (
                <div key={i} style={{ height: HOUR_HEIGHT, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', paddingRight: 8, paddingTop: 0 }}>
                  <span style={{ fontSize: 10, color: '#8B8CA7', marginTop: -6 }}>{formatHour(HOURS_START + i)}</span>
                </div>
              ))}
            </div>

            {/* Day columns */}
            {(viewMode === 'week' ? weekDays : [currentDate]).map((day, dayIdx) => {
              const dayEvents = getEventsForDay(day);
              return (
                <div key={dayIdx} style={{
                  flex: 1, position: 'relative', borderLeft: dayIdx > 0 ? '1px solid #F0F0F0' : '1px solid #E8E8E8',
                  minWidth: 0,
                }}>
                  {/* Hour rows (clickable) */}
                  {Array.from({ length: HOURS_END - HOURS_START }, (_, i) => (
                    <div
                      key={i}
                      onClick={() => handleGridClick(day, HOURS_START + i)}
                      style={{
                        height: HOUR_HEIGHT, borderBottom: '1px solid #F5F5F5',
                        cursor: 'pointer',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = '#FAFAFF'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                    />
                  ))}

                  {/* Event blocks */}
                  {dayEvents.map(ev => {
                    const start = new Date(ev.start_time);
                    const end = new Date(ev.end_time);
                    const startMins = start.getHours() * 60 + start.getMinutes();
                    const endMins = end.getHours() * 60 + end.getMinutes();
                    const topPx = ((startMins - HOURS_START * 60) / 60) * HOUR_HEIGHT;
                    const heightPx = Math.max(((endMins - startMins) / 60) * HOUR_HEIGHT, 22);

                    return (
                      <div
                        key={ev.id}
                        onClick={(e) => handleEventClick(ev, e)}
                        style={{
                          position: 'absolute', top: topPx, left: 2, right: 4,
                          height: heightPx, borderRadius: 4, padding: '3px 6px',
                          background: ev.color || '#5B5FC7', color: '#fff',
                          fontSize: 11, fontWeight: 500, overflow: 'hidden',
                          cursor: 'pointer', zIndex: 2,
                          borderLeft: `3px solid ${ev.color || '#5B5FC7'}`,
                          opacity: 0.9,
                        }}
                        onMouseEnter={e => { e.currentTarget.style.opacity = '1'; }}
                        onMouseLeave={e => { e.currentTarget.style.opacity = '0.9'; }}
                      >
                        <div style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600,
                          display: 'flex', alignItems: 'center', gap: 3,
                        }}>
                          {ev.is_online_meeting && (
                            <Video size={10} style={{ flexShrink: 0, opacity: 0.9 }} />
                          )}
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.title}</span>
                        </div>
                        {heightPx > 30 && (
                          <div style={{ fontSize: 10, opacity: 0.85, marginTop: 1 }}>
                            {formatEventTime(ev.start_time)} - {formatEventTime(ev.end_time)}
                          </div>
                        )}
                        {heightPx > 48 && ev.creator_name && (
                          <div style={{ fontSize: 10, opacity: 0.75, marginTop: 1 }}>{ev.creator_name}</div>
                        )}
                      </div>
                    );
                  })}

                  {/* Current time indicator */}
                  {isSameDay(day, today) && (() => {
                    const now = new Date();
                    const mins = now.getHours() * 60 + now.getMinutes();
                    const top = ((mins - HOURS_START * 60) / 60) * HOUR_HEIGHT;
                    if (top < 0 || top > (HOURS_END - HOURS_START) * HOUR_HEIGHT) return null;
                    return (
                      <div style={{
                        position: 'absolute', top, left: 0, right: 0, height: 2,
                        background: '#D13438', zIndex: 5, pointerEvents: 'none',
                      }}>
                        <div style={{
                          position: 'absolute', left: -4, top: -4, width: 10, height: 10,
                          borderRadius: '50%', background: '#D13438',
                        }} />
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ─── Event Detail Popup ─── */}
      {selectedEvent && popupPos && (
        <EventDetailPopup
          event={selectedEvent}
          position={popupPos}
          userId={user?.id || ''}
          onClose={() => setSelectedEvent(null)}
          onRsvp={handleRsvp}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      )}

      {/* ─── Create/Edit Modal ─── */}
      {showCreateModal && (
        <CreateEventModal
          editingEvent={editingEvent}
          prefillTime={prefillTime}
          onClose={() => { setShowCreateModal(false); setEditingEvent(null); setPrefillTime(null); }}
          onSaved={() => { setShowCreateModal(false); setEditingEvent(null); setPrefillTime(null); fetchEvents(); }}
        />
      )}
    </div>
  );
}

/* ===================================================================
   EVENT DETAIL POPUP
   =================================================================== */
function EventDetailPopup({ event, position, userId, onClose, onRsvp, onEdit, onDelete }: {
  event: CalendarEvent; position: { x: number; y: number }; userId: string;
  onClose: () => void;
  onRsvp: (status: 'accepted' | 'declined' | 'tentative') => void;
  onEdit: () => void; onDelete: () => void;
}) {
  const isCreator = event.created_by === userId;
  const myAttendance = event.attendees?.find(a => a.user_id === userId);
  const popupRef = useRef<HTMLDivElement>(null);
  const routerNavigate = useNavigate();

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', handler), 0);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Clamp position to viewport
  const left = Math.min(position.x, window.innerWidth - 340);
  const top = Math.min(Math.max(position.y, 10), window.innerHeight - 400);

  return (
    <div ref={popupRef} style={{
      position: 'fixed', left, top, width: 320, maxHeight: 380,
      background: '#fff', borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
      border: '1px solid #E0E0E0', zIndex: 1000, overflowY: 'auto',
    }}>
      {/* Color header */}
      <div style={{ height: 6, background: event.color || '#5B5FC7', borderRadius: '10px 10px 0 0' }} />

      <div style={{ padding: '14px 18px' }}>
        {/* Title (with online-meeting badge) */}
        <h3 style={{
          fontSize: 16, fontWeight: 700, color: '#242424', margin: '0 0 8px',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {event.is_online_meeting && (
            <span title="Online meeting" style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 22, height: 22, borderRadius: 6, background: '#E8EBFA', color: '#5B5FC7',
              flexShrink: 0,
            }}>
              <Video size={13} />
            </span>
          )}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {event.title}
          </span>
        </h3>

        {/* Join meeting CTA — only when online meeting and the link exists */}
        {event.is_online_meeting && event.livekit_call_id && (
          <button
            onClick={() => {
              onClose();
              routerNavigate(`/meeting/${event.livekit_call_id}`);
            }}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              gap: 6, width: '100%', padding: '10px 12px', marginBottom: 12,
              background: '#5B5FC7', color: '#fff', border: 'none', borderRadius: 6,
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(91,95,199,0.3)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#4F52B2'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#5B5FC7'; }}
          >
            <Video size={15} /> Join meeting
          </button>
        )}

        {/* Time */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#616161', marginBottom: 6 }}>
          <Clock size={13} color="#8B8CA7" />
          {formatEventTime(event.start_time)} - {formatEventTime(event.end_time)}
          <span style={{ color: '#B0B0B0' }}>
            {new Date(event.start_time).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>

        {/* Location */}
        {event.location && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#616161', marginBottom: 6 }}>
            <MapPin size={13} color="#8B8CA7" />
            {event.location}
          </div>
        )}

        {/* Description */}
        {event.description && (
          <p style={{ fontSize: 12, color: '#616161', margin: '8px 0', lineHeight: 1.5 }}>{event.description}</p>
        )}

        {/* Attendees */}
        {event.attendees && event.attendees.length > 0 && (
          <div style={{ marginTop: 10, borderTop: '1px solid #F0F0F0', paddingTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: '#8B8CA7', marginBottom: 6, textTransform: 'uppercase' }}>
              <Users size={12} /> Attendees ({event.attendees.length})
            </div>
            {event.attendees.map(att => {
              const statusIcon = att.status === 'accepted' ? <Check size={11} color="#107C10" />
                : att.status === 'declined' ? <X size={11} color="#D13438" />
                : att.status === 'tentative' ? <HelpCircle size={11} color="#FFB900" />
                : <Clock size={11} color="#B0B0B0" />;
              return (
                <div key={att.user_id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: '50%', background: getAvatarColor(att.display_name),
                    color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 600,
                  }}>
                    {getInitials(att.display_name)}
                  </div>
                  <span style={{ fontSize: 12, color: '#242424', flex: 1 }}>{att.display_name}</span>
                  {statusIcon}
                </div>
              );
            })}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          {!isCreator && myAttendance && myAttendance.status !== 'accepted' && (
            <PopupBtn label="Accept" color="#107C10" onClick={() => onRsvp('accepted')} />
          )}
          {!isCreator && myAttendance && myAttendance.status !== 'tentative' && (
            <PopupBtn label="Tentative" color="#FFB900" onClick={() => onRsvp('tentative')} />
          )}
          {!isCreator && myAttendance && myAttendance.status !== 'declined' && (
            <PopupBtn label="Decline" color="#D13438" onClick={() => onRsvp('declined')} />
          )}
          {isCreator && (
            <>
              <PopupBtn label="Edit" color="#5B5FC7" icon={<Edit3 size={12} />} onClick={onEdit} />
              <PopupBtn label="Delete" color="#D13438" icon={<Trash2 size={12} />} onClick={onDelete} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PopupBtn({ label, color, icon, onClick }: { label: string; color: string; icon?: React.ReactNode; onClick: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 5,
        border: `1px solid ${color}`, background: hovered ? color : 'transparent',
        color: hovered ? '#fff' : color, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        transition: 'all 0.12s',
      }}
    >
      {icon} {label}
    </button>
  );
}
