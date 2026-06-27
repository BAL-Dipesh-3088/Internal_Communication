import type { Socket } from 'socket.io-client';

export type CallDirection = 'incoming' | 'outgoing';
export type CallType = 'audio' | 'video';

export interface ActiveCall {
  id: string;
  peerConnection: RTCPeerConnection;
  direction: CallDirection;
  callType: CallType;
  remoteUserId: string;
  remoteName?: string;
  conversationId?: string;
  startTime?: Date;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  isMuted: boolean;
  isOnHold: boolean;
  dataChannel?: RTCDataChannel;
}

export interface PointerEvent {
  type: 'move' | 'click';
  x: number; // 0-1 percentage
  y: number; // 0-1 percentage
}

type CallEventHandler = (call: ActiveCall) => void;
export interface CallEndData {
  callType: CallType;
  duration: number; // seconds
  conversationId?: string;
  direction: CallDirection;
  remoteName?: string;
  remoteUserId?: string;
}
type CallEndHandler = (callId: string, reason: string, callData?: CallEndData) => void;

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

class WebRTCService {
  private socket: Socket | null = null;
  private activeCalls: Map<string, ActiveCall> = new Map();
  private pendingCalls: Map<string, { callType: CallType; conversationId?: string; remoteName?: string }> = new Map();
  private cameraStream: MediaStream | null = null;

  // Event handlers — same API surface as old SIPService
  onIncomingCall: CallEventHandler | null = null;
  onCallEstablished: CallEventHandler | null = null;
  onCallEnded: CallEndHandler | null = null;
  onRegistered: (() => void) | null = null;
  onUnregistered: (() => void) | null = null;
  onRegistrationFailed: ((error: string) => void) | null = null;
  onPointerEvent: ((data: PointerEvent) => void) | null = null;

  get isRegistered(): boolean {
    return this.socket?.connected ?? false;
  }

  get calls(): ActiveCall[] {
    return Array.from(this.activeCalls.values());
  }

  // ─── Signaling Setup ─────────────────────────────────────
  initSignaling(socket: Socket) {
    // Prevent duplicate listener registration on reconnect
    if (this.socket === socket) return;

    // Remove old listeners if switching sockets
    if (this.socket) {
      this.socket.off('call:incoming');
      this.socket.off('call:accepted');
      this.socket.off('call:rejected');
      this.socket.off('call:ended');
      this.socket.off('webrtc:offer');
      this.socket.off('webrtc:answer');
      this.socket.off('webrtc:ice-candidate');
    }

    this.socket = socket;
    console.log('[WebRTC] Signaling initialized on socket', socket.id);

    // We are "registered" when socket is connected (no SIP needed)
    this.onRegistered?.();

    socket.on('call:incoming', (data: { callerId: string; callerName: string; callType: CallType; conversationId: string }) => {
      console.log('[WebRTC] Incoming call from', data.callerName);
      // Create a placeholder call (no PeerConnection yet — created on accept)
      const callId = `call-${Date.now()}`;
      const call: ActiveCall = {
        id: callId,
        peerConnection: null as any, // Created when user accepts
        direction: 'incoming',
        callType: data.callType,
        remoteUserId: data.callerId,
        remoteName: data.callerName,
        conversationId: data.conversationId,
        isMuted: false,
        isOnHold: false,
      };
      this.pendingCalls.set(data.callerId, { callType: data.callType, conversationId: data.conversationId, remoteName: data.callerName });
      this.activeCalls.set(callId, call);
      this.onIncomingCall?.(call);
    });

    socket.on('call:accepted', (data: { userId: string; username: string }) => {
      console.log('[WebRTC] Call accepted by', data.username);
      // We are the caller — initiate WebRTC negotiation
      const pending = this.pendingCalls.get(data.userId);
      if (!pending) return;
      const callId = this.findCallIdByRemoteUser(data.userId);
      if (!callId) return;
      this.startPeerConnection(callId, data.userId, pending.callType, true);
    });

    socket.on('call:rejected', (data: { userId: string }) => {
      console.log('[WebRTC] Call rejected');
      const callId = this.findCallIdByRemoteUser(data.userId);
      if (callId) {
        const callData = this.captureCallData(callId);
        this.cleanupCall(callId);
        this.onCallEnded?.(callId, 'rejected', callData);
      }
      this.pendingCalls.delete(data.userId);
    });

    socket.on('call:ended', (data: { userId: string }) => {
      for (const [callId, call] of this.activeCalls) {
        if (call.remoteUserId === data.userId) {
          const callData = this.captureCallData(callId);
          this.cleanupCall(callId);
          this.onCallEnded?.(callId, 'ended', callData);
          break;
        }
      }
    });

    socket.on('webrtc:offer', async (data: { from: string; offer: RTCSessionDescriptionInit }) => {
      console.log('[WebRTC] Received offer from', data.from);
      const callId = this.findCallIdByRemoteUser(data.from);
      if (!callId) { console.warn('[WebRTC] No active call found for offer from', data.from); return; }
      const call = this.activeCalls.get(callId);
      if (!call) { console.warn('[WebRTC] Call object missing for', callId); return; }

      const pending = this.pendingCalls.get(data.from);
      const callType = pending?.callType || call.callType;

      try {
        const pc = this.createPeerConnection(callId);
        call.peerConnection = pc;

        // Get local media — try audio+video first, fallback to audio-only
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            video: callType === 'video' ? {
              width: { ideal: 1920, min: 1280 },
              height: { ideal: 1080, min: 720 },
              frameRate: { ideal: 30, max: 30 },
              facingMode: 'user',
            } : false,
          });
        } catch (mediaErr: any) {
          console.warn('[WebRTC] camera unavailable for', callType, '- answering with camera OFF (call stays', callType + '):', mediaErr.message);
          // Camera unavailable (permission denied, no device, or — common in
          // multi-tab testing — already held by another browser tab). CRUCIAL:
          // we do NOT flip the call TYPE to audio. Doing so hid the caller's
          // video entirely and showed the receiver an "Audio Call". We keep it a
          // video call with our camera off: the caller's offer already carries a
          // video m-line, so setRemoteDescription auto-creates a recvonly video
          // transceiver and we still RECEIVE and render the caller's video.
          try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          } catch (audioErr: any) {
            console.error('[WebRTC] Cannot get any media device:', audioErr.message);
            this.cleanupCall(callId);
            this.onCallEnded?.(callId, 'media-error');
            return;
          }
        }
        call.localStream = stream;
        stream.getTracks().forEach(track => pc.addTrack(track, stream));

        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this.socket?.emit('webrtc:answer', { to: data.from, answer: pc.localDescription });
        console.log('[WebRTC] Answer sent to', data.from);
      } catch (err: any) {
        console.error('[WebRTC] Error handling offer:', err.message || err);
        this.cleanupCall(callId);
        this.onCallEnded?.(callId, 'error');
      }
    });

    socket.on('webrtc:answer', async (data: { from: string; answer: RTCSessionDescriptionInit }) => {
      console.log('[WebRTC] Received answer from', data.from);
      const callId = this.findCallIdByRemoteUser(data.from);
      if (!callId) return;
      const call = this.activeCalls.get(callId);
      if (!call?.peerConnection) return;

      try {
        await call.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
      } catch (err) {
        console.error('[WebRTC] Error setting answer:', err);
      }
    });

    socket.on('webrtc:ice-candidate', async (data: { from: string; candidate: RTCIceCandidateInit }) => {
      const callId = this.findCallIdByRemoteUser(data.from);
      if (!callId) return;
      const call = this.activeCalls.get(callId);
      if (!call?.peerConnection) return;

      try {
        await call.peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      } catch (err) {
        // ICE candidate errors are common during setup, ignore silently
      }
    });

    socket.on('disconnect', () => {
      this.onUnregistered?.();
    });

    socket.on('connect', () => {
      this.onRegistered?.();
    });
  }

  // ─── Call Actions ─────────────────────────────────────────

  async makeCall(targetUserId: string, callType: CallType, remoteName?: string, conversationId?: string): Promise<ActiveCall> {
    if (!this.socket) throw new Error('Not connected');

    const callId = `call-${Date.now()}`;
    const call: ActiveCall = {
      id: callId,
      peerConnection: null as any,
      direction: 'outgoing',
      callType,
      remoteUserId: targetUserId,
      remoteName,
      conversationId,
      isMuted: false,
      isOnHold: false,
    };

    this.activeCalls.set(callId, call);
    this.pendingCalls.set(targetUserId, { callType, conversationId, remoteName });

    this.socket.emit('call:initiate', { targetUserId, callType, conversationId });
    console.log(`[WebRTC] Calling ${remoteName || targetUserId} (${callType})`);

    return call;
  }

  async answerCall(callId: string, callType?: CallType): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) throw new Error('Call not found');

    if (callType) call.callType = callType;

    // Tell the caller we accepted — they will send the WebRTC offer
    this.socket?.emit('call:accept', { callerId: call.remoteUserId });
    console.log('[WebRTC] Answered call from', call.remoteName || call.remoteUserId);
  }

  async rejectCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    this.socket?.emit('call:reject', { callerId: call.remoteUserId });
    this.pendingCalls.delete(call.remoteUserId);
    this.cleanupCall(callId);
  }

  async hangup(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    const callData = this.captureCallData(callId);
    this.socket?.emit('call:end', { conversationId: call.conversationId, targetUserId: call.remoteUserId });
    this.cleanupCall(callId);
    this.onCallEnded?.(callId, 'ended', callData);
  }

  toggleMute(callId: string): boolean {
    const call = this.activeCalls.get(callId);
    if (!call) return false;

    call.isMuted = !call.isMuted;
    call.localStream?.getAudioTracks().forEach(track => {
      track.enabled = !call.isMuted;
    });
    return call.isMuted;
  }

  toggleVideo(callId: string): boolean {
    const call = this.activeCalls.get(callId);
    if (!call) return false;

    const videoTracks = call.localStream?.getVideoTracks() || [];
    const isEnabled = videoTracks[0]?.enabled ?? false;
    videoTracks.forEach(track => { track.enabled = !isEnabled; });
    return !isEnabled;
  }

  async startScreenShare(callId: string): Promise<MediaStream | null> {
    const call = this.activeCalls.get(callId);
    if (!call?.peerConnection) return null;

    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
        audio: false,
      });
      const screenTrack = screenStream.getVideoTracks()[0];

      // Save camera stream for later restoration
      const videoSender = call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
      if (videoSender) {
        this.cameraStream = call.localStream || null;
        await videoSender.replaceTrack(screenTrack);
      }

      screenTrack.onended = () => {
        this.stopScreenShare(callId);
      };

      return screenStream;
    } catch (err) {
      console.error('[WebRTC] Screen share failed:', err);
      return null;
    }
  }

  async stopScreenShare(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call?.peerConnection || !this.cameraStream) return;

    const videoSender = call.peerConnection.getSenders().find(s => s.track?.kind === 'video');
    const cameraTrack = this.cameraStream.getVideoTracks()[0];
    if (videoSender && cameraTrack) {
      await videoSender.replaceTrack(cameraTrack);
    }
    this.cameraStream = null;
  }

  sendPointerEvent(callId: string, data: PointerEvent): void {
    const call = this.activeCalls.get(callId);
    if (call?.dataChannel?.readyState === 'open') {
      call.dataChannel.send(JSON.stringify(data));
    }
  }

  // ─── Private Helpers ──────────────────────────────────────

  private createPeerConnection(callId: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const call = this.activeCalls.get(callId);

    pc.onicecandidate = (event) => {
      if (event.candidate && call) {
        this.socket?.emit('webrtc:ice-candidate', {
          to: call.remoteUserId,
          candidate: event.candidate,
        });
      }
    };

    pc.ontrack = (event) => {
      if (!call) return;
      if (!call.remoteStream) {
        call.remoteStream = new MediaStream();
      }
      event.streams[0]?.getTracks().forEach(track => {
        call.remoteStream!.addTrack(track);
      });

      // Fire established callback when we get remote media
      if (!call.startTime) {
        call.startTime = new Date();
        console.log('[WebRTC] Call established with', call.remoteName || call.remoteUserId);
        this.onCallEstablished?.(call);
      }
    };

    // DataChannel for remote control pointer events
    const setupDataChannel = (dc: RTCDataChannel) => {
      dc.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as PointerEvent;
          this.onPointerEvent?.(data);
        } catch { /* ignore invalid data */ }
      };
      dc.onopen = () => console.log('[WebRTC] DataChannel open');
      dc.onclose = () => console.log('[WebRTC] DataChannel closed');
      if (call) call.dataChannel = dc;
    };

    // Caller creates the DataChannel
    const dc = pc.createDataChannel('remote-control');
    setupDataChannel(dc);

    // Callee accepts the DataChannel
    pc.ondatachannel = (event) => {
      setupDataChannel(event.channel);
    };

    pc.onconnectionstatechange = () => {
      console.log('[WebRTC] Connection state:', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (call && this.activeCalls.has(callId)) {
          const callData = this.captureCallData(callId);
          this.cleanupCall(callId);
          this.onCallEnded?.(callId, pc.connectionState, callData);
        }
      }
    };

    return pc;
  }

  private async startPeerConnection(callId: string, remoteUserId: string, callType: CallType, isOfferer: boolean) {
    const call = this.activeCalls.get(callId);
    if (!call) return;

    try {
      const pc = this.createPeerConnection(callId);
      call.peerConnection = pc;

      // Get local media — try requested type, fallback to audio-only
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: callType === 'video' ? {
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            frameRate: { ideal: 30, max: 30 },
            facingMode: 'user',
          } : false,
        });
      } catch (mediaErr: any) {
        console.warn('[WebRTC] camera unavailable for', callType, '- continuing with camera OFF (call stays', callType + '):', mediaErr.message);
        try {
          // Keep the call TYPE unchanged (do NOT downgrade video→audio). Continue
          // with audio only; the recvonly video m-line added below lets us still
          // RECEIVE the other party's video.
          stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch (audioErr: any) {
          console.error('[WebRTC] Cannot access microphone:', audioErr.message);
          this.cleanupCall(callId);
          this.onCallEnded?.(callId, 'media-error');
          return;
        }
      }
      call.localStream = stream;
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      // Video call but no local camera track (camera unavailable): still
      // negotiate a recvonly video m-line so the offer carries video and we
      // RECEIVE the remote party's camera even though we send none.
      if (call.callType === 'video' && stream.getVideoTracks().length === 0) {
        try { pc.addTransceiver('video', { direction: 'recvonly' }); } catch { /* older browsers */ }
      }
      console.log('[WebRTC] Local media acquired:', stream.getTracks().map(t => t.kind).join(', '));

      if (isOfferer) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket?.emit('webrtc:offer', { to: remoteUserId, offer: pc.localDescription });
        console.log('[WebRTC] Offer sent to', remoteUserId);
      }
    } catch (err: any) {
      console.error('[WebRTC] Error starting peer connection:', err.message || err);
      this.cleanupCall(callId);
      this.onCallEnded?.(callId, 'error');
    }
  }

  private findCallIdByRemoteUser(userId: string): string | null {
    for (const [callId, call] of this.activeCalls) {
      if (call.remoteUserId === userId) return callId;
    }
    return null;
  }

  private captureCallData(callId: string): CallEndData | undefined {
    const call = this.activeCalls.get(callId);
    if (!call) return undefined;
    const duration = call.startTime ? Math.round((Date.now() - call.startTime.getTime()) / 1000) : 0;
    return {
      callType: call.callType,
      duration,
      conversationId: call.conversationId,
      direction: call.direction,
      remoteName: call.remoteName,
      remoteUserId: call.remoteUserId,
    };
  }

  private cleanupCall(callId: string) {
    const call = this.activeCalls.get(callId);
    if (call) {
      call.localStream?.getTracks().forEach(t => t.stop());
      call.remoteStream?.getTracks().forEach(t => t.stop());
      if (call.peerConnection) {
        call.peerConnection.close();
      }
      this.pendingCalls.delete(call.remoteUserId);
      this.activeCalls.delete(callId);
    }
  }
}

// Singleton
export const webrtcService = new WebRTCService();
