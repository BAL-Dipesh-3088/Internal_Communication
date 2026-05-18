/**
 * LiveKit Server Service — wraps livekit-server-sdk for room + token operations.
 *
 * All group calls go through this service. 1:1 WebRTC calls (the existing
 * peer-to-peer flow) are NOT affected by this service — they continue to work
 * exactly as before via `socket.service.ts` and `webrtc.ts`.
 *
 * Configured via env:
 *   LIVEKIT_WS_URL     — URL the BROWSER uses to connect (e.g. ws://192.168.10.15:7880)
 *   LIVEKIT_HTTP_URL   — URL the BACKEND uses (e.g. http://192.168.10.15:7880 or http://livekit:7880)
 *   LIVEKIT_API_KEY    — must match livekit.yaml `keys:`
 *   LIVEKIT_API_SECRET — must match livekit.yaml `keys:`
 */

import {
  AccessToken,
  RoomServiceClient,
  Room,
  ParticipantInfo,
} from 'livekit-server-sdk';

const WS_URL = process.env.LIVEKIT_WS_URL || 'ws://192.168.10.15:7880';
const HTTP_URL = process.env.LIVEKIT_HTTP_URL || 'http://192.168.10.15:7880';
const API_KEY = process.env.LIVEKIT_API_KEY || '';
const API_SECRET = process.env.LIVEKIT_API_SECRET || '';

if (!API_KEY || !API_SECRET) {
  console.warn('[LiveKit] LIVEKIT_API_KEY / LIVEKIT_API_SECRET not set — group calls will fail');
} else {
  console.log(`[LiveKit] Configured (ws=${WS_URL})`);
}

const roomService = new RoomServiceClient(HTTP_URL, API_KEY, API_SECRET);

export interface MintTokenOptions {
  roomName: string;
  identity: string;        // unique user id (we use BAL Connect user.id)
  name: string;            // display name
  isHost?: boolean;        // host can end room + kick + mute others
  ttlSeconds?: number;     // token lifetime (default 1 hour)
}

/**
 * Mint a JWT access token for the user to join a LiveKit room.
 * Token is short-lived and scoped to a single room.
 */
export function generateAccessToken(opts: MintTokenOptions): Promise<string> {
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: opts.identity,
    name: opts.name,
    ttl: opts.ttlSeconds ?? 3600, // seconds
  });

  // Permissions — every participant can publish + subscribe.
  // Host gets extra admin grant so they can kick/mute others via server API.
  //
  // `canUpdateOwnMetadata: true` is required for the participant to call
  // `setAttributes` on themselves. We use that to store `handRaised` state
  // for the Phase 4 raise-hand feature. Without this grant, LiveKit returns
  // "does not have permission to update own metadata" and the call breaks.
  at.addGrant({
    room: opts.roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
    roomAdmin: !!opts.isHost,
    roomCreate: !!opts.isHost,
  });

  return at.toJwt();
}

/** The WS URL the browser should connect to. Provided to clients alongside the token. */
export function getClientWsUrl(): string {
  return WS_URL;
}

/**
 * Create a room ahead of time. Optional — LiveKit auto-creates rooms when the
 * first participant joins. We pre-create so we can set max_participants and
 * lock down the room metadata before anyone joins.
 */
export async function createRoom(name: string, maxParticipants = 30): Promise<Room> {
  return await roomService.createRoom({
    name,
    maxParticipants,
    emptyTimeout: 300, // 5 min auto-cleanup if empty
  });
}

/** List all currently active rooms (for diagnostics / admin views). */
export async function listRooms(): Promise<Room[]> {
  return await roomService.listRooms();
}

/** List participants in a specific room. */
export async function listParticipants(roomName: string): Promise<ParticipantInfo[]> {
  return await roomService.listParticipants(roomName);
}

/**
 * Host action: update a participant's attributes from the server side.
 *
 * Used by the "lower hand" flow — clients can only modify their OWN attributes
 * via the client SDK, so to clear someone else's `handRaised` flag we go
 * through the LiveKit server API (which is authenticated with API_SECRET).
 *
 * Passing an empty-string value for a key effectively unsets that attribute
 * on the participant.
 */
export async function updateParticipantAttributes(
  roomName: string,
  identity: string,
  attributes: Record<string, string>,
): Promise<void> {
  // livekit-server-sdk's updateParticipant has two overloads — we use the
  // options-object form to pass attributes (the positional form only supports
  // metadata/permission/name).
  await roomService.updateParticipant(roomName, identity, { attributes });
}

/** Host action: force-end the room. All participants are kicked. */
export async function endRoom(roomName: string): Promise<void> {
  await roomService.deleteRoom(roomName);
}

/**
 * Update the room-level metadata. We use this to carry the meeting title
 * (and potentially other future fields like agenda). The metadata is a
 * single string — we JSON-stringify a small object server-side and the
 * client parses it from useRoomInfo().metadata.
 *
 * Auto-synced to every participant in real-time by LiveKit (no extra socket plumbing).
 */
export async function updateRoomMetadata(roomName: string, metadata: string): Promise<void> {
  await roomService.updateRoomMetadata(roomName, metadata);
}

/** Host action: remove a single participant. */
export async function kickParticipant(roomName: string, identity: string): Promise<void> {
  await roomService.removeParticipant(roomName, identity);
}

/**
 * Host action: server-side mute a participant's track (audio or video).
 * Use `trackSid` from the participant's track list. If you only have the
 * identity, fetch participant info first to find the track sid.
 */
export async function muteParticipantTrack(
  roomName: string,
  identity: string,
  trackSid: string,
  muted: boolean,
): Promise<void> {
  await roomService.mutePublishedTrack(roomName, identity, trackSid, muted);
}

/**
 * Convenience: mute all audio tracks of a participant. We look up the
 * participant, find the first audio track, then mute it.
 */
export async function muteParticipantAudio(roomName: string, identity: string, muted: boolean): Promise<void> {
  const participants = await roomService.listParticipants(roomName);
  const target = participants.find((p) => p.identity === identity);
  if (!target) throw new Error(`Participant ${identity} not in room ${roomName}`);
  const audioTrack = target.tracks.find((t) => t.type === 0); // 0 = AUDIO in proto enum
  if (!audioTrack) throw new Error(`Participant ${identity} has no audio track`);
  await roomService.mutePublishedTrack(roomName, identity, audioTrack.sid, muted);
}

/**
 * Health check — verifies admin credentials work by calling listRooms.
 */
export async function ping(): Promise<{ ok: boolean; error?: string; rooms?: number }> {
  try {
    const rooms = await roomService.listRooms();
    return { ok: true, rooms: rooms.length };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}
