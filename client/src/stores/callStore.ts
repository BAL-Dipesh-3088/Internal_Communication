import { create } from 'zustand';
import { webrtcService, type ActiveCall, type CallType, type CallEndData } from '@/services/webrtc';
import { getSocket } from '@/services/socket';
import * as livekitApi from '@/services/livekit';
import { useAuthStore } from '@/stores/authStore';
import {
  showDesktopNotification,
  playCallRingtone,
  playOutgoingRingtone,
  playCallConnectedChime,
  playCallEndedTone,
  getNotificationPrefs,
} from '@/services/notification';

let ringtoneHandle: { stop: () => void } | null = null;
let outgoingRingtoneHandle: { stop: () => void } | null = null;

function formatCallDuration(seconds: number): string {
  if (seconds < 60) return `0:${seconds.toString().padStart(2, '0')}`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function buildCallMessage(reason: string, data?: CallEndData): { content: string; metadata: any } | null {
  if (!data?.conversationId) return null;
  const typeLabel = data.callType === 'video' ? 'Video call' : 'Audio call';

  let content: string;
  let status: string;

  if (reason === 'rejected') {
    content = data.direction === 'outgoing' ? 'Call declined' : `Missed ${typeLabel.toLowerCase()}`;
    status = data.direction === 'outgoing' ? 'declined' : 'missed';
  } else if (reason === 'media-error' || reason === 'error' || reason === 'failed') {
    content = 'Call failed';
    status = 'failed';
  } else if (data.duration > 0) {
    content = `${typeLabel} \u00B7 ${formatCallDuration(data.duration)}`;
    status = 'completed';
  } else {
    content = data.direction === 'outgoing' ? 'Call not answered' : `Missed ${typeLabel.toLowerCase()}`;
    status = 'missed';
  }

  return {
    content,
    metadata: {
      callType: data.callType,
      duration: data.duration,
      direction: data.direction,
      status,
      remoteName: data.remoteName,
    },
  };
}

export interface GroupCallParticipant {
  userId: string;
  displayName: string;
  extension: string;
  status: 'ringing' | 'connected' | 'disconnected';
  isMuted: boolean;
  stream?: MediaStream;
}

export interface GroupCallState {
  isActive: boolean;
  conversationId: string | null;
  callType: CallType;
  groupName: string;
  participants: GroupCallParticipant[];   // (legacy — LiveKit's own roster is in the component)
  startTime: Date | null;

  // New LiveKit fields — present when we're connected via SFU
  callId: string | null;
  livekitToken: string | null;
  livekitWsUrl: string | null;
  livekitRoomName: string | null;
  isHost: boolean;
}

export interface IncomingGroupCallInvite {
  callId: string;
  conversationId: string;
  callType: CallType;
  hostId: string;
  hostName: string;
  roomName: string;
  startedAt: string;
}

/**
 * Persistent "Meeting in progress" marker per conversation.
 * Populated from:
 *   - `group-call:active` socket event (broadcast at call start)
 *   - REST `getActiveGroupCall()` on conversation open (for late joiners who missed the event)
 * Cleared by `group-call:active-ended` and `group-call:ended`.
 */
export interface ActiveGroupCallInfo {
  callId: string;
  conversationId: string;
  callType: CallType;
  hostId: string;
  hostName: string;
  roomName: string;
  startedAt: string;
  participants?: Array<{ userId: string; displayName: string; joinedAt: string }>;
}

interface CallState {
  isReady: boolean;
  activeCalls: ActiveCall[];
  incomingCall: ActiveCall | null;
  currentCall: ActiveCall | null;
  isScreenSharing: boolean;
  groupCall: GroupCallState | null;
  incomingGroupInvite: IncomingGroupCallInvite | null;
  /** Per-conversation active group call markers, keyed by conversationId. */
  activeGroupCalls: Record<string, ActiveGroupCallInfo>;

  initWebRTC: (socket: any) => void;
  makeCall: (targetUserId: string, type: CallType, remoteName?: string, conversationId?: string) => Promise<void>;
  answerCall: (callId: string, type: CallType) => Promise<void>;
  rejectCall: (callId: string) => Promise<void>;
  hangup: (callId: string) => Promise<void>;
  toggleMute: (callId: string) => void;
  toggleVideo: (callId: string) => void;
  startScreenShare: (callId: string) => Promise<void>;
  stopScreenShare: (callId: string) => Promise<void>;
  dismissIncoming: () => void;

  // Group call actions (LiveKit-backed)
  startGroupCall: (conversationId: string, callType: CallType, groupName?: string) => Promise<void>;
  // Teams-style escalation: turn the active 1:1 WebRTC call into a LiveKit group
  // call and add `inviteeUserId`. The existing peer auto-transitions.
  escalateToGroup: (inviteeUserId: string) => Promise<void>;
  acceptGroupInvite: (callId: string) => Promise<void>;
  declineGroupInvite: (callId: string) => Promise<void>;
  receiveGroupInvite: (invite: IncomingGroupCallInvite) => void;
  leaveGroupCall: () => Promise<void>;
  endGroupCallForAll: () => Promise<void>;
  endGroupCall: () => void;
  // Active-meeting tracking (for late-join banner)
  refreshActiveGroupCall: (conversationId: string) => Promise<void>;
  setActiveGroupCall: (info: ActiveGroupCallInfo) => void;
  clearActiveGroupCall: (conversationId: string, callId?: string) => void;

  // (legacy helpers retained for any callers — no-ops in LiveKit mode)
  joinGroupCall: (conversationId: string, callType: CallType, groupName: string) => void;
  addGroupParticipant: (participant: GroupCallParticipant) => void;
  removeGroupParticipant: (userId: string) => void;
  updateGroupParticipant: (userId: string, updates: Partial<GroupCallParticipant>) => void;
}

export const useCallStore = create<CallState>((set, get) => {
  // Setup WebRTC event handlers
  webrtcService.onRegistered = () => {
    set({ isReady: true });
  };
  webrtcService.onUnregistered = () => {
    set({ isReady: false });
  };
  webrtcService.onIncomingCall = (call) => {
    set({ incomingCall: call, activeCalls: webrtcService.calls });

    // Play ringtone and show desktop notification
    const prefs = getNotificationPrefs();
    if (prefs.sound) {
      ringtoneHandle?.stop();
      ringtoneHandle = playCallRingtone();
    }
    if (prefs.desktop) {
      const callerName = call.remoteName || call.remoteUserId || 'Unknown';
      const callTypeLabel = call.callType === 'video' ? 'Video Call' : 'Audio Call';
      showDesktopNotification({
        title: `Incoming ${callTypeLabel}`,
        body: `${callerName} is calling you`,
        tag: 'incoming-call',
        requireInteraction: true,
      });
    }
  };
  webrtcService.onCallEstablished = (call) => {
    ringtoneHandle?.stop();
    ringtoneHandle = null;
    outgoingRingtoneHandle?.stop();
    outgoingRingtoneHandle = null;
    playCallConnectedChime();
    set({
      currentCall: call,
      incomingCall: null,
      activeCalls: webrtcService.calls,
    });
  };
  webrtcService.onCallEnded = (_callId: string, reason: string, callData?: CallEndData) => {
    ringtoneHandle?.stop();
    ringtoneHandle = null;
    outgoingRingtoneHandle?.stop();
    outgoingRingtoneHandle = null;
    playCallEndedTone();
    const calls = webrtcService.calls;
    set({
      activeCalls: calls,
      currentCall: calls.length > 0 ? calls[0] : null,
      incomingCall: null,
      isScreenSharing: false,
    });

    // Send call-ended system message — only from the CALLER side to avoid duplicates
    const msg = buildCallMessage(reason, callData);
    if (msg && callData?.conversationId && callData?.direction === 'outgoing') {
      const socket = getSocket();
      if (socket?.connected) {
        socket.emit('message:send', {
          conversationId: callData.conversationId,
          type: 'system',
          content: msg.content,
          metadata: JSON.stringify(msg.metadata),
        });
      }
    }
  };

  return {
    isReady: false,
    activeCalls: [],
    incomingCall: null,
    currentCall: null,
    isScreenSharing: false,
    groupCall: null,
    incomingGroupInvite: null,
    activeGroupCalls: {},

    initWebRTC: (socket) => {
      webrtcService.initSignaling(socket);
      set({ isReady: socket.connected });

      // Listen for group call socket events emitted by the server
      socket.on('group-call:incoming', (invite: IncomingGroupCallInvite) => {
        // Ignore if we're the one who started it (server broadcasts to whole conv room)
        const me = useAuthStore.getState().user?.id;
        if (me && invite.hostId === me) return;
        // Ignore if we're already in this call
        if (useCallStore.getState().groupCall?.callId === invite.callId) return;

        useCallStore.getState().receiveGroupInvite(invite);
      });

      // Teams-style escalation — the OTHER 1:1 participant is auto-moved from
      // the WebRTC 1:1 into the new LiveKit group room (no accept prompt: they
      // were already talking to the host). The host who started it ignores this
      // (they set up the group call locally in escalateToGroup).
      socket.on('call:escalate-to-group', async (data: {
        callId: string; conversationId: string; callType: CallType;
        roomName: string; hostId: string; hostName: string; startedAt: string;
      }) => {
        const me = useAuthStore.getState().user?.id;
        if (me && data.hostId === me) return;                       // host already handled it
        if (useCallStore.getState().groupCall?.callId === data.callId) return; // already in it
        try {
          const result = await livekitApi.joinGroupCall(data.callId);
          ringtoneHandle?.stop();
          ringtoneHandle = null;
          set({
            incomingGroupInvite: null,
            groupCall: {
              isActive: true,
              conversationId: data.conversationId,
              callType: data.callType,
              groupName: '',
              participants: [],
              startTime: new Date(),
              callId: data.callId,
              livekitToken: result.livekit.token,
              livekitWsUrl: result.livekit.wsUrl,
              livekitRoomName: result.livekit.roomName,
              isHost: false,
            },
          });
          playCallConnectedChime();
          // Tear down the existing 1:1 WebRTC call(s) — replaced by the group call.
          webrtcService.calls.forEach((c) => webrtcService.hangup(c.id));
        } catch (err: any) {
          console.error('[CallStore] escalate auto-join failed:', err?.response?.data?.error || err.message);
        }
      });

      socket.on('group-call:ended', (data: { callId: string; endedBy?: string }) => {
        const state = useCallStore.getState();
        if (state.groupCall?.callId === data.callId) {
          state.endGroupCall();
        }
        if (state.incomingGroupInvite?.callId === data.callId) {
          set({ incomingGroupInvite: null });
          ringtoneHandle?.stop();
          ringtoneHandle = null;
        }
      });

      // Persistent "meeting in progress" marker — appears as banner in chat window.
      // Lets users who weren't online when the call started discover and join it.
      socket.on('group-call:active', (info: ActiveGroupCallInfo) => {
        useCallStore.getState().setActiveGroupCall(info);
      });

      // Clears the banner when the meeting is force-ended by the host.
      socket.on('group-call:active-ended', (data: { conversationId: string; callId: string }) => {
        useCallStore.getState().clearActiveGroupCall(data.conversationId, data.callId);
      });
    },

    makeCall: async (targetUserId, type, remoteName, conversationId) => {
      try {
        const call = await webrtcService.makeCall(targetUserId, type, remoteName, conversationId);
        // Play outgoing ring-back tone (caller hears this while waiting)
        outgoingRingtoneHandle?.stop();
        outgoingRingtoneHandle = playOutgoingRingtone();
        set({ currentCall: call, activeCalls: webrtcService.calls });
      } catch (err) {
        console.error('Call failed:', err);
      }
    },

    answerCall: async (callId, type) => {
      ringtoneHandle?.stop();
      ringtoneHandle = null;
      // Set currentCall immediately so UI shows "Connecting..." overlay
      const call = webrtcService.calls.find(c => c.id === callId);
      set({ incomingCall: null, currentCall: call || null });
      await webrtcService.answerCall(callId, type);
    },

    rejectCall: async (callId) => {
      ringtoneHandle?.stop();
      ringtoneHandle = null;
      await webrtcService.rejectCall(callId);
      set({ incomingCall: null });
    },

    hangup: async (callId) => {
      await webrtcService.hangup(callId);
    },

    toggleMute: (callId) => {
      webrtcService.toggleMute(callId);
      set({ activeCalls: [...webrtcService.calls] });
    },

    toggleVideo: (callId) => {
      webrtcService.toggleVideo(callId);
      set({ activeCalls: [...webrtcService.calls] });
    },

    startScreenShare: async (callId) => {
      const stream = await webrtcService.startScreenShare(callId);
      if (stream) {
        set({ isScreenSharing: true });
        const call = get().currentCall;
        if (call?.conversationId) {
          getSocket()?.emit('screen-share:started', { conversationId: call.conversationId });
        }
      }
    },

    stopScreenShare: async (callId) => {
      const call = get().currentCall;
      await webrtcService.stopScreenShare(callId);
      set({ isScreenSharing: false });
      if (call?.conversationId) {
        getSocket()?.emit('screen-share:stopped', { conversationId: call.conversationId });
      }
    },

    dismissIncoming: () => {
      ringtoneHandle?.stop();
      ringtoneHandle = null;
      set({ incomingCall: null });
    },

    // ─── Group call actions (LiveKit-backed) ──────────────────────────────

    startGroupCall: async (conversationId, callType, groupName = '') => {
      try {
        const result = await livekitApi.startGroupCall(conversationId, callType);
        set({
          groupCall: {
            isActive: true,
            conversationId,
            callType,
            groupName,
            participants: [],
            startTime: new Date(),
            callId: result.callId,
            livekitToken: result.livekit.token,
            livekitWsUrl: result.livekit.wsUrl,
            livekitRoomName: result.livekit.roomName,
            isHost: true,
          },
        });
        playCallConnectedChime();
      } catch (err: any) {
        console.error('[CallStore] startGroupCall failed:', err?.response?.data?.error || err.message);
        alert('Failed to start group call: ' + (err?.response?.data?.error || err.message));
      }
    },

    escalateToGroup: async (inviteeUserId) => {
      const call = useCallStore.getState().currentCall;
      if (!call) return;
      if (!call.conversationId) {
        alert('Adding people requires this call to be linked to a conversation. Start the call from a chat to use this.');
        return;
      }
      try {
        const result = await livekitApi.escalateToGroupCall(
          call.conversationId, call.callType, call.remoteUserId, inviteeUserId,
        );
        set({
          groupCall: {
            isActive: true,
            conversationId: call.conversationId,
            callType: call.callType,
            groupName: '',
            participants: [],
            startTime: new Date(),
            callId: result.callId,
            livekitToken: result.livekit.token,
            livekitWsUrl: result.livekit.wsUrl,
            livekitRoomName: result.livekit.roomName,
            isHost: true,
          },
        });
        playCallConnectedChime();
        // End the 1:1 WebRTC call — the group call replaces it.
        webrtcService.hangup(call.id);
      } catch (err: any) {
        console.error('[CallStore] escalateToGroup failed:', err?.response?.data?.error || err.message);
        alert('Failed to add people: ' + (err?.response?.data?.error || err.message));
      }
    },

    receiveGroupInvite: (invite) => {
      set({ incomingGroupInvite: invite });
      const prefs = getNotificationPrefs();
      if (prefs.sound) {
        ringtoneHandle?.stop();
        ringtoneHandle = playCallRingtone();
      }
      if (prefs.desktop) {
        const callTypeLabel = invite.callType === 'video' ? 'Group Video Call' : 'Group Audio Call';
        showDesktopNotification({
          title: `Incoming ${callTypeLabel}`,
          body: `${invite.hostName} started a group call`,
          tag: `group-call-${invite.callId}`,
          requireInteraction: true,
        });
      }
    },

    acceptGroupInvite: async (callId) => {
      // Look up context from either source:
      //   1. `incomingGroupInvite` — a currently ringing call the user is being invited to
      //   2. `activeGroupCalls` — a call already in progress that the user wants to LATE JOIN
      // This makes the same flow work for both the IncomingGroupCallModal and the
      // ActiveMeetingBanner Join button.
      const state = useCallStore.getState();
      const invite = state.incomingGroupInvite;
      const activeEntry = Object.values(state.activeGroupCalls).find((c) => c.callId === callId);

      const context = invite && invite.callId === callId
        ? { conversationId: invite.conversationId, callType: invite.callType }
        : activeEntry
          ? { conversationId: activeEntry.conversationId, callType: activeEntry.callType }
          : null;

      if (!context) {
        console.warn('[CallStore] acceptGroupInvite: no invite or active call found for', callId);
        return;
      }

      ringtoneHandle?.stop();
      ringtoneHandle = null;
      try {
        const result = await livekitApi.joinGroupCall(callId);
        set({
          incomingGroupInvite: null,
          groupCall: {
            isActive: true,
            conversationId: context.conversationId,
            callType: context.callType,
            groupName: '',
            participants: [],
            startTime: new Date(),
            callId,
            livekitToken: result.livekit.token,
            livekitWsUrl: result.livekit.wsUrl,
            livekitRoomName: result.livekit.roomName,
            isHost: false,
          },
        });
        playCallConnectedChime();
      } catch (err: any) {
        console.error('[CallStore] acceptGroupInvite failed:', err?.response?.data?.error || err.message);
        alert('Failed to join call: ' + (err?.response?.data?.error || err.message));
        set({ incomingGroupInvite: null });
      }
    },

    declineGroupInvite: async (callId) => {
      ringtoneHandle?.stop();
      ringtoneHandle = null;
      set({ incomingGroupInvite: null });
      try {
        await livekitApi.declineGroupCall(callId);
      } catch (err) {
        console.warn('[CallStore] decline call failed (non-critical):', err);
      }
    },

    leaveGroupCall: async () => {
      // Just clear local state. LiveKit's <LiveKitRoom> will trigger an onDisconnected
      // handler that notifies the server. Server cleans up empty rooms automatically.
      playCallEndedTone();
      set({ groupCall: null });
    },

    endGroupCallForAll: async () => {
      const state = useCallStore.getState();
      const callId = state.groupCall?.callId;
      if (!callId) return;
      playCallEndedTone();
      try {
        await livekitApi.endGroupCall(callId);
      } catch (err: any) {
        console.error('[CallStore] endGroupCall failed:', err?.response?.data?.error || err.message);
      }
      set({ groupCall: null });
    },

    endGroupCall: () => {
      playCallEndedTone();
      set({ groupCall: null });
    },

    // ─── Active-meeting tracking (late-join banner) ───────────────────────────────

    /** Fetch current active group call for a conversation from the backend. */
    refreshActiveGroupCall: async (conversationId: string) => {
      try {
        const info = await livekitApi.getActiveGroupCall(conversationId);
        if (info) {
          set((s) => ({
            activeGroupCalls: { ...s.activeGroupCalls, [conversationId]: info as ActiveGroupCallInfo },
          }));
        } else {
          // No active call — clear any stale entry for this conv
          set((s) => {
            if (!s.activeGroupCalls[conversationId]) return s;
            const next = { ...s.activeGroupCalls };
            delete next[conversationId];
            return { activeGroupCalls: next };
          });
        }
      } catch (err: any) {
        // Non-fatal — just leave the existing state alone
        console.warn('[CallStore] refreshActiveGroupCall failed:', err?.response?.data?.error || err.message);
      }
    },

    setActiveGroupCall: (info: ActiveGroupCallInfo) => {
      set((s) => ({
        activeGroupCalls: { ...s.activeGroupCalls, [info.conversationId]: info },
      }));
    },

    clearActiveGroupCall: (conversationId: string, callId?: string) => {
      set((s) => {
        const existing = s.activeGroupCalls[conversationId];
        // If a specific callId was provided, only clear if it matches (avoid races
        // where a NEW call has already started before the OLD end event arrives).
        if (callId && existing && existing.callId !== callId) return s;
        if (!existing) return s;
        const next = { ...s.activeGroupCalls };
        delete next[conversationId];
        return { activeGroupCalls: next };
      });
    },

    // ─── Legacy no-op shims (kept for backward compat with any existing callers) ─

    joinGroupCall: () => {
      // Legacy peer-to-peer flow is replaced by acceptGroupInvite(callId).
      console.warn('[CallStore] joinGroupCall is deprecated — use acceptGroupInvite');
    },

    addGroupParticipant: () => { /* LiveKit owns participant state now */ },
    removeGroupParticipant: () => { /* LiveKit owns participant state now */ },
    updateGroupParticipant: () => { /* LiveKit owns participant state now */ },
  };
});
