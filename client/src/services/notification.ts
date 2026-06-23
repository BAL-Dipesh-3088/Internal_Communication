// ============================================
// Desktop Notification Service
// Browser-native Notification API + Web Audio API
// No dependencies needed
// ============================================

// --- Module state ---
let _tabFocused = true;
let _audioCtx: AudioContext | null = null;
let _baseTitle = '';

// --- Types ---
interface NotificationPrefs {
  sound: boolean;
  desktop: boolean;
  preview: boolean;
}

interface NotifyOptions {
  title: string;
  body: string;
  tag: string;
  onClick?: () => void;
  requireInteraction?: boolean;
}

interface ShouldNotifyParams {
  senderId: string;
  currentUserId: string;
  conversationId: string;
  activeConversationId: string | null;
  userStatus: string;
  mentionedUserIds?: string[];
}

// ============================================
// Notification Preferences
// ============================================

export function getNotificationPrefs(): NotificationPrefs {
  try {
    const stored = localStorage.getItem('notificationPrefs');
    if (stored) {
      const parsed = JSON.parse(stored);
      return {
        sound: parsed.sound !== false,
        desktop: parsed.desktop !== false,
        preview: parsed.preview !== false,
      };
    }
  } catch { /* ignore */ }
  return { sound: true, desktop: true, preview: true };
}

// ============================================
// Tab Focus Tracking
// ============================================

export function isTabFocused(): boolean {
  return _tabFocused;
}

export function initFocusTracking(): () => void {
  _tabFocused = document.visibilityState === 'visible' && document.hasFocus();

  const onVisibilityChange = () => {
    _tabFocused = document.visibilityState === 'visible' && document.hasFocus();
  };
  const onFocus = () => { _tabFocused = true; };
  const onBlur = () => { _tabFocused = false; };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onFocus);
  window.addEventListener('blur', onBlur);

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('blur', onBlur);
  };
}

// ============================================
// Title Badge (unread count in tab title)
// ============================================

export function updateTitleBadge(unreadCount: number): void {
  if (!_baseTitle) {
    // Strip any existing badge to get the base title
    _baseTitle = document.title.replace(/^\(\d+\)\s*/, '') || 'BAL Connect';
  }
  document.title = unreadCount > 0 ? `(${unreadCount}) ${_baseTitle}` : _baseTitle;
}

// ============================================
// Suppression Logic
// ============================================

export function shouldNotify(params: ShouldNotifyParams): boolean {
  const { senderId, currentUserId, conversationId, activeConversationId, userStatus, mentionedUserIds } = params;

  // Don't notify for own messages
  if (senderId === currentUserId) return false;

  // Check if user is mentioned — @mentions always force-notify (override active chat + DND)
  const isMentioned = mentionedUserIds && (
    mentionedUserIds.includes(currentUserId) || mentionedUserIds.includes('everyone')
  );
  if (isMentioned) return true;

  // Don't notify if viewing this conversation and tab is focused
  if (conversationId === activeConversationId && _tabFocused) return false;

  // Don't notify in DND mode
  if (userStatus === 'dnd') return false;

  // Don't notify if desktop notifications disabled
  const prefs = getNotificationPrefs();
  if (!prefs.desktop) return false;

  return true;
}

// ============================================
// Desktop Notification (Browser Notification API)
// ============================================

export function showDesktopNotification(options: NotifyOptions): void {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  try {
    const notification = new Notification(options.title, {
      body: options.body,
      tag: options.tag,
      icon: '/favicon.svg',
      silent: true, // We handle sound separately
      requireInteraction: options.requireInteraction ?? false,
    });

    notification.onclick = () => {
      window.focus();
      options.onClick?.();
      notification.close();
    };

    // Auto-close after 5 seconds
    setTimeout(() => notification.close(), 5000);
  } catch (err) {
    console.error('[Notification] Failed to show:', err);
  }
}

// ============================================
// Audio: Message Notification Sound
// Two-tone chime using Web Audio API
// ============================================

function getAudioContext(): AudioContext {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  if (_audioCtx.state === 'suspended') {
    _audioCtx.resume();
  }
  return _audioCtx;
}

export function playMessageSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    // Tone 1: E5 (659Hz), 80ms
    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.value = 659;
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.08);

    // Tone 2: C6 (1046Hz), 100ms, starts after tone 1
    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.type = 'sine';
    osc2.frequency.value = 1046;
    gain2.gain.setValueAtTime(0.3, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.2);
  } catch (err) {
    console.error('[Notification] Sound playback failed:', err);
  }
}

// ============================================
// Audio: Meeting Reminder Chime — gentle 3-note rise (G5→C6→E6)
// Distinct from the message chime so a reminder is recognisable.
// ============================================

export function playReminderSound(): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    playNote(ctx, 783.99, now, 0.35, 0.22);        // G5
    playNote(ctx, 1046.5, now + 0.16, 0.35, 0.22); // C6
    playNote(ctx, 1318.51, now + 0.32, 0.5, 0.18);  // E6 (longer, softer)
  } catch (err) {
    console.error('[Notification] Reminder sound failed:', err);
  }
}

// ============================================
// Audio: Call Ringtone — Melodic Teams-like arpeggio
// E5→G5→B5→E6 ascending chord, loops every 3s
// ============================================

function playNote(ctx: AudioContext, freq: number, startAt: number, duration: number, volume: number = 0.25) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(volume, startAt + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, startAt + duration);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(startAt + duration);
}

export function playCallRingtone(): { stop: () => void } {
  let stopped = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function ringOnce() {
    if (stopped) return;
    try {
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      // Melodic ascending arpeggio: E5 → G5 → B5 → E6
      playNote(ctx, 659.25, now, 0.3, 0.22);        // E5
      playNote(ctx, 783.99, now + 0.18, 0.3, 0.22);  // G5
      playNote(ctx, 987.77, now + 0.36, 0.3, 0.22);  // B5
      playNote(ctx, 1318.51, now + 0.54, 0.45, 0.18); // E6 (longer, softer)
    } catch { /* ignore */ }
  }

  ringOnce();
  intervalId = setInterval(ringOnce, 3000);

  return {
    stop: () => {
      stopped = true;
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    },
  };
}

// ============================================
// Audio: Outgoing Call Tone — Soft repeating ring-back
// Single 440Hz pulse every 4s (like phone ringing on other end)
// ============================================

export function playOutgoingRingtone(): { stop: () => void } {
  let stopped = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  function ringOnce() {
    if (stopped) return;
    try {
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      // Ring-back tone: 440Hz + 480Hz (standard North American ring-back)
      for (const freq of [440, 480]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.setValueAtTime(0.12, now + 1.8);
        gain.gain.linearRampToValueAtTime(0, now + 2.0);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 2.0);
      }
    } catch { /* ignore */ }
  }

  ringOnce();
  intervalId = setInterval(ringOnce, 4000);

  return {
    stop: () => {
      stopped = true;
      if (intervalId) { clearInterval(intervalId); intervalId = null; }
    },
  };
}

// ============================================
// Audio: Call Connected Chime — Short ascending C5→E5
// ============================================

export function playCallConnectedChime() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    playNote(ctx, 523.25, now, 0.2, 0.3);       // C5
    playNote(ctx, 659.25, now + 0.12, 0.3, 0.3); // E5
  } catch { /* ignore */ }
}

// ============================================
// Audio: Call Ended Tone — Short descending E5→C5
// ============================================

export function playCallEndedTone() {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    playNote(ctx, 659.25, now, 0.15, 0.2);       // E5
    playNote(ctx, 523.25, now + 0.1, 0.25, 0.2); // C5
  } catch { /* ignore */ }
}
