/**
 * LiveKit API client — wraps the BAL Connect backend endpoints.
 *
 * The actual LiveKit WebSocket / WebRTC connection is established inside the
 * <LiveKitRoom> React component (from @livekit/components-react) — this file
 * only handles the BAL Connect REST API that mints tokens and tracks call state.
 */

import api from './api';

export interface GroupCallStartResponse {
  callId: string;
  livekit: {
    wsUrl: string;
    token: string;
    roomName: string;
  };
}

export interface GroupCallJoinResponse {
  livekit: {
    wsUrl: string;
    token: string;
    roomName: string;
  };
}

/** Host starts a new group call. Backend mints token + rings every conversation member. */
export async function startGroupCall(
  conversationId: string,
  callType: 'audio' | 'video',
): Promise<GroupCallStartResponse> {
  const { data } = await api.post('/calls/group/start', { conversationId, callType });
  return data;
}

/** Callee accepts an incoming ring — mint their own token for the room. */
export async function joinGroupCall(callId: string): Promise<GroupCallJoinResponse> {
  const { data } = await api.post(`/calls/group/${callId}/join`);
  return data;
}

/** Callee declines an incoming ring — backend marks declined for analytics. */
export async function declineGroupCall(callId: string): Promise<void> {
  await api.post(`/calls/group/${callId}/decline`);
}

/** Host force-ends the call for everyone. */
export async function endGroupCall(callId: string): Promise<void> {
  await api.post(`/calls/group/${callId}/end`);
}

/** Host removes a single participant. */
export async function kickGroupParticipant(callId: string, targetUserId: string): Promise<void> {
  await api.post(`/calls/group/${callId}/kick`, { targetUserId });
}

/** Host server-side mutes a participant's audio. */
export async function muteGroupParticipant(callId: string, targetUserId: string, mute: boolean): Promise<void> {
  await api.post(`/calls/group/${callId}/mute-user`, { targetUserId, mute });
}

/**
 * Invite a user to an ongoing group call. Anyone already in the call can invite —
 * not just the host (matches Microsoft Teams behaviour). The invited user gets
 * an incoming-call ring on their personal socket and can accept just like a
 * normal incoming invite. They don't need to be a member of the underlying
 * conversation.
 */
export async function inviteToGroupCall(callId: string, targetUserId: string): Promise<{ userId: string; displayName: string }> {
  const { data } = await api.post(`/calls/group/${callId}/invite`, { userId: targetUserId });
  return data?.invited;
}

// ─── In-call chat ────────────────────────────────────────────────────────────

export interface CallChatMessage {
  id: string;                  // DB id
  senderId: string | null;
  senderDisplayName: string;
  clientMsgId: string;         // UUID from sender — primary dedup key
  content: string;
  createdAt: string;           // ISO timestamp from server
}

/**
 * Fetch chat history for a call. Used when the chat panel mounts so the user
 * sees prior messages even if they joined late. Pass `since` for delta sync
 * (only newer messages).
 */
export async function getCallChatHistory(callId: string, since?: string): Promise<CallChatMessage[]> {
  const { data } = await api.get(`/calls/group/${callId}/chat`, {
    params: since ? { since } : undefined,
  });
  return data?.messages || [];
}

/**
 * Persist a chat message to the backend. The client should ALSO send the same
 * message via LiveKit's data channel (useChat.send) for real-time delivery —
 * this endpoint is only for persistence so late joiners can fetch history.
 *
 * Idempotent: re-POSTing the same clientMsgId returns the existing row (no
 * duplicate row created). Safe to retry on network failure.
 */
export async function sendCallChatMessage(
  callId: string,
  clientMsgId: string,
  content: string,
): Promise<CallChatMessage> {
  const { data } = await api.post(`/calls/group/${callId}/chat`, { clientMsgId, content });
  return data?.message;
}

// ─── Meeting info + title (used by /meeting/:callId join page and host title edit) ───

export interface MeetingInfo {
  callId: string;
  callType: 'audio' | 'video';
  hostId: string;
  hostName: string;
  conversationId: string | null;
  conversationName: string | null;
  /** Custom title set by host (via room metadata). Null if never set. */
  title: string | null;
  startedAt: string;
  status: 'ringing' | 'answered' | 'ended' | string;
  participantCount: number;
}

/**
 * Fetch lightweight meeting info. Used by the join page to render a preview
 * BEFORE the user clicks Join.
 */
export async function getMeetingInfo(callId: string): Promise<MeetingInfo> {
  const { data } = await api.get(`/calls/group/${callId}/info`);
  return data;
}

/**
 * Host action: rename the meeting. Updates LiveKit room metadata, which
 * auto-syncs to every connected client.
 */
export async function updateMeetingTitle(callId: string, title: string): Promise<void> {
  await api.post(`/calls/group/${callId}/title`, { title });
}

// ─── Raise hand (host action only — lowering own hand is done client-side) ───

/**
 * Host action: lower another participant's raised hand. Pass `'all'` to clear
 * every raised hand in the call (Teams-style "Lower all hands"). Clients can
 * only modify their OWN attributes via the LiveKit client SDK, so this goes
 * through the backend which uses the LiveKit server API.
 */
export async function lowerHand(callId: string, targetUserId: string | 'all'): Promise<{ lowered: number }> {
  const { data } = await api.post(`/calls/group/${callId}/lower-hand`, { targetUserId });
  return { lowered: data?.lowered ?? 0 };
}

export interface ActiveCallInfo {
  callId: string;
  callType: 'audio' | 'video';
  hostId: string;
  hostName: string;
  roomName: string;
  startedAt: string;
  participants: Array<{ userId: string; displayName: string; joinedAt: string }>;
}

/**
 * Find the currently active group call (if any) for a conversation.
 *
 * Used to render the "Meeting in progress — Join" banner so users who weren't
 * online when the call started can still discover and join it.
 *
 * Returns null if no active call.
 */
export async function getActiveGroupCall(conversationId: string): Promise<ActiveCallInfo | null> {
  const { data } = await api.get('/calls/group/active', { params: { conversationId } });
  return data?.call || null;
}
