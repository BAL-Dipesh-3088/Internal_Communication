/**
 * mailStore — app-wide inbox watcher.
 *
 * Why a store and not EmailWindow: the Email tab only polls while the user is
 * LOOKING at it. The unread badge on the sidebar and the "new mail" sound must
 * work wherever the user is (chat, calls, another browser tab), so the
 * polling + notification logic lives here, started once from AppLayout.
 *
 * Unread definition: inbox emails whose id is NOT in the localStorage read-set
 * ('bal_read_emails' — the same key EmailWindow maintains when a mail is
 * opened). This keeps the badge and the inbox list perfectly in sync without a
 * server-side read-state migration.
 *
 * Sound policy: exactly ONE place plays the new-mail sound (here). EmailWindow
 * feeds its own fetches into ingestInbox() so a mail the user is already
 * looking at never re-triggers the sound from the background poller.
 */

import { create } from 'zustand';
import api from '@/services/api';
import { playMessageSound, showDesktopNotification, getNotificationPrefs } from '@/services/notification';

const READ_KEY = 'bal_read_emails';
const POLL_MS = 30_000;

function getReadIds(): Set<string> {
  try {
    const stored = localStorage.getItem(READ_KEY);
    return stored ? new Set(JSON.parse(stored)) : new Set();
  } catch {
    return new Set();
  }
}

interface InboxMail {
  id: string;
  from: string;
  subject: string;
}

interface MailState {
  unreadCount: number;

  /** Fetch the inbox and update the badge; notifies on genuinely new mail. */
  refreshInbox: () => Promise<void>;
  /** Feed inbox rows fetched elsewhere (EmailWindow) into the watcher. */
  ingestInbox: (mails: InboxMail[]) => void;
  /** Recompute the badge after read-state changed (user opened a mail). */
  recomputeUnread: () => void;
  /** Start/stop the global polling loop (AppLayout lifecycle). */
  startPolling: () => void;
  stopPolling: () => void;
}

// Module-level internals (not reactive state)
let knownIds: Set<string> | null = null; // null = first load not done (no sound yet)
let lastSnapshot: InboxMail[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

export const useMailStore = create<MailState>((set, get) => {
  function processInbox(mails: InboxMail[]) {
    lastSnapshot = mails;
    const readIds = getReadIds();
    const unread = mails.filter((m) => !readIds.has(m.id)).length;

    // New-mail detection by id — robust against deletions (count can shrink
    // while new mail still arrives) unlike the old count-based check.
    if (knownIds !== null) {
      const fresh = mails.filter((m) => !knownIds!.has(m.id));
      if (fresh.length > 0) {
        const prefs = getNotificationPrefs();
        if (prefs.sound) playMessageSound();
        if (prefs.desktop) {
          showDesktopNotification({
            title: 'New Email',
            body: fresh.length === 1
              ? `From: ${fresh[0].from} — ${fresh[0].subject}`
              : `You have ${fresh.length} new emails`,
            tag: 'email-new',
          });
        }
      }
      fresh.forEach((m) => knownIds!.add(m.id));
    } else {
      knownIds = new Set(mails.map((m) => m.id));
    }

    set({ unreadCount: unread });
  }

  return {
    unreadCount: 0,

    refreshInbox: async () => {
      try {
        const { data } = await api.get('/email/inbox');
        const mails: InboxMail[] = (data.emails || []).map((e: any) => ({
          id: (e.id || e.uid)?.toString() || '',
          from: e.from || 'Unknown',
          subject: e.subject || '(No subject)',
        })).filter((m: InboxMail) => m.id);
        processInbox(mails);
      } catch {
        // Inbox unavailable (IMAP hiccup) — keep the last badge, retry next tick.
      }
    },

    ingestInbox: (mails) => processInbox(mails),

    recomputeUnread: () => {
      const readIds = getReadIds();
      set({ unreadCount: lastSnapshot.filter((m) => !readIds.has(m.id)).length });
    },

    startPolling: () => {
      if (pollTimer) return; // already running
      get().refreshInbox();
      pollTimer = setInterval(() => get().refreshInbox(), POLL_MS);
    },

    stopPolling: () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      knownIds = null; // fresh session next time (e.g. after logout/login)
    },
  };
});
