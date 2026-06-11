import { useEffect, useRef, useState } from 'react';
import {
  PhoneOff,
  Mic,
  MicOff,
  Video,
  VideoOff,
  Monitor,
  MonitorOff,
  Maximize2,
  Minimize2,
  Hand,
  MousePointer2,
  Shield,
  UserPlus,
  Search,
  X,
  Loader2,
} from 'lucide-react';
import { useCallStore } from '@/stores/callStore';
import { getSocket } from '@/services/socket';
import api from '@/services/api';
import { webrtcService } from '@/services/webrtc';
import type { PointerEvent as RemotePointerEvent } from '@/services/webrtc';

export default function ActiveCallOverlay() {
  const { currentCall, hangup, toggleMute, toggleVideo, startScreenShare, stopScreenShare, isScreenSharing, escalateToGroup } = useCallStore();
  const [showAddPanel, setShowAddPanel] = useState(false);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  // Dedicated audio sink for AUDIO-ONLY calls. Without this the remote stream
  // has no media element to play through, so no one hears anyone (video calls
  // worked only because the <video> element also plays the audio track).
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const [isExpanded, setIsExpanded] = useState(true);
  const [duration, setDuration] = useState('00:00');
  const [hoveredBtn, setHoveredBtn] = useState<string | null>(null);
  const [remoteIsScreenSharing, setRemoteIsScreenSharing] = useState(false);
  const [remoteControlRequested, setRemoteControlRequested] = useState(false);
  const [remoteControlActive, setRemoteControlActive] = useState(false);
  const [remoteControlIncoming, setRemoteControlIncoming] = useState(false);
  const [controlRequester, setControlRequester] = useState('');
  const [remoteControlRole, setRemoteControlRole] = useState<'controller' | 'sharer' | null>(null);
  const [remotePointer, setRemotePointer] = useState<{ x: number; y: number } | null>(null);
  const [clickRipple, setClickRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  // Remote control socket events
  useEffect(() => {
    const socket = getSocket();
    if (!socket || !currentCall) return;

    const onControlRequest = (data: { from: string; fromName: string }) => {
      setRemoteControlIncoming(true);
      setControlRequester(data.fromName || data.from);
    };
    const onControlGranted = () => {
      setRemoteControlActive(true);
      setRemoteControlRequested(false);
      setRemoteControlRole('controller');
    };
    const onControlDenied = () => {
      setRemoteControlRequested(false);
    };
    const onControlEnded = () => {
      setRemoteControlActive(false);
      setRemoteControlIncoming(false);
      setRemoteControlRequested(false);
      setRemoteControlRole(null);
      setRemotePointer(null);
    };

    const onRemoteScreenStarted = () => setRemoteIsScreenSharing(true);
    const onRemoteScreenStopped = () => setRemoteIsScreenSharing(false);

    socket.on('remote-control:request', onControlRequest);
    socket.on('remote-control:granted', onControlGranted);
    socket.on('remote-control:denied', onControlDenied);
    socket.on('remote-control:ended', onControlEnded);
    socket.on('screen-share:started', onRemoteScreenStarted);
    socket.on('screen-share:stopped', onRemoteScreenStopped);

    return () => {
      socket.off('remote-control:request', onControlRequest);
      socket.off('remote-control:granted', onControlGranted);
      socket.off('remote-control:denied', onControlDenied);
      socket.off('remote-control:ended', onControlEnded);
      socket.off('screen-share:started', onRemoteScreenStarted);
      socket.off('screen-share:stopped', onRemoteScreenStopped);
    };
  }, [currentCall]);

  const requestRemoteControl = () => {
    const socket = getSocket();
    if (socket && currentCall) {
      socket.emit('remote-control:request', { to: currentCall.remoteUserId });
      setRemoteControlRequested(true);
    }
  };

  const grantRemoteControl = () => {
    const socket = getSocket();
    if (socket && currentCall) {
      socket.emit('remote-control:grant', { to: currentCall.remoteUserId });
      setRemoteControlActive(true);
      setRemoteControlIncoming(false);
      setRemoteControlRole('sharer');
    }
  };

  const denyRemoteControl = () => {
    const socket = getSocket();
    if (socket && currentCall) {
      socket.emit('remote-control:deny', { to: currentCall.remoteUserId });
      setRemoteControlIncoming(false);
    }
  };

  const endRemoteControl = () => {
    const socket = getSocket();
    if (socket && currentCall) {
      socket.emit('remote-control:end', { to: currentCall.remoteUserId });
      setRemoteControlActive(false);
      setRemoteControlRequested(false);
      setRemoteControlRole(null);
      setRemotePointer(null);
    }
  };

  // Pointer event listener (sharer side — receives pointer data from controller)
  useEffect(() => {
    if (remoteControlRole !== 'sharer') {
      webrtcService.onPointerEvent = null;
      return;
    }
    webrtcService.onPointerEvent = (data: RemotePointerEvent) => {
      if (data.type === 'move') {
        setRemotePointer({ x: data.x, y: data.y });
      } else if (data.type === 'click') {
        setRemotePointer({ x: data.x, y: data.y });
        setClickRipple({ x: data.x, y: data.y, id: Date.now() });
        setTimeout(() => setClickRipple(null), 600);
      }
    };
    return () => { webrtcService.onPointerEvent = null; };
  }, [remoteControlRole]);

  // Controller side — capture mouse on remote video and send pointer events
  const handlePointerMove = (e: React.MouseEvent) => {
    if (remoteControlRole !== 'controller' || !currentCall || !videoContainerRef.current) return;
    const rect = videoContainerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      webrtcService.sendPointerEvent(currentCall.id, { type: 'move', x, y });
    }
  };

  const handlePointerClick = (e: React.MouseEvent) => {
    if (remoteControlRole !== 'controller' || !currentCall || !videoContainerRef.current) return;
    const rect = videoContainerRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1) {
      webrtcService.sendPointerEvent(currentCall.id, { type: 'click', x, y });
    }
  };

  // Attach media streams — re-attach when expanding from minimized
  useEffect(() => {
    if (!currentCall) return;

    if (remoteVideoRef.current && currentCall.remoteStream) {
      remoteVideoRef.current.srcObject = currentCall.remoteStream;
      remoteVideoRef.current.play().catch(() => {});
    }
    // Audio-only calls have no <video>; route the remote stream to the <audio> sink.
    if (remoteAudioRef.current && currentCall.remoteStream) {
      remoteAudioRef.current.srcObject = currentCall.remoteStream;
      remoteAudioRef.current.play().catch(() => {});
    }
    if (localVideoRef.current && currentCall.localStream) {
      localVideoRef.current.srcObject = currentCall.localStream;
      localVideoRef.current.play().catch(() => {});
    }
  }, [currentCall, currentCall?.remoteStream, currentCall?.localStream, isExpanded]);

  // Timer
  useEffect(() => {
    if (!currentCall?.startTime) return;

    const interval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - currentCall.startTime!.getTime()) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      setDuration(`${mins}:${secs}`);
    }, 1000);

    return () => clearInterval(interval);
  }, [currentCall?.startTime]);

  if (!currentCall) return null;

  const isVideoCall = currentCall.callType === 'video';
  const isCameraOn = currentCall.localStream?.getVideoTracks().some(t => t.enabled) ?? false;
  const isConnecting = !currentCall.startTime;
  const remoteName = currentCall.remoteName || 'Unknown';
  const remoteInitial = remoteName[0]?.toUpperCase() || '?';

  // "Calling..." state — shown while waiting for receiver to answer
  if (isConnecting && currentCall.direction === 'outgoing') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 90,
        background: 'linear-gradient(135deg, #1A1A2E 0%, #2D2B55 50%, #1A1A2E 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        color: '#fff',
        animation: 'acoFadeIn 0.3s ease-out',
      }}>
        {/* Pulsing avatar */}
        <div style={{ position: 'relative', marginBottom: 28 }}>
          <div style={{
            position: 'absolute', inset: -12, borderRadius: '50%',
            border: '2px solid rgba(107,183,0,0.3)',
            animation: 'acoCallingPulse 2s ease-out infinite',
          }} />
          <div style={{
            position: 'absolute', inset: -12, borderRadius: '50%',
            border: '2px solid rgba(107,183,0,0.3)',
            animation: 'acoCallingPulse 2s ease-out infinite 1s',
          }} />
          <div style={{
            width: 100, height: 100, borderRadius: '50%',
            background: 'linear-gradient(135deg, #6264A7, #8B8DF0)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 40, fontWeight: 700, color: '#fff',
            boxShadow: '0 8px 32px rgba(98,100,167,0.4)',
          }}>
            {remoteInitial}
          </div>
        </div>

        <h2 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 6px 0' }}>{remoteName}</h2>
        <p style={{ fontSize: 14, color: 'rgba(255,255,255,0.6)', margin: '0 0 40px 0', display: 'flex', gap: 2 }}>
          <span>Calling</span>
          <span style={{ animation: 'acoDotPulse 1.4s ease-in-out infinite 0s' }}>.</span>
          <span style={{ animation: 'acoDotPulse 1.4s ease-in-out infinite 0.2s' }}>.</span>
          <span style={{ animation: 'acoDotPulse 1.4s ease-in-out infinite 0.4s' }}>.</span>
        </p>

        {/* Cancel button */}
        <button
          onClick={() => hangup(currentCall.id)}
          style={{
            width: 64, height: 64, borderRadius: '50%',
            background: '#D13438', color: '#fff', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 24,
            boxShadow: '0 4px 24px rgba(209,52,56,0.4)',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.1)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
        >
          <PhoneOff size={26} />
        </button>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 10 }}>Cancel</span>

        <style>{`
          @keyframes acoFadeIn { from { opacity: 0; } to { opacity: 1; } }
          @keyframes acoCallingPulse { 0% { transform: scale(1); opacity: 0.4; } 100% { transform: scale(2); opacity: 0; } }
          @keyframes acoDotPulse { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        `}</style>
      </div>
    );
  }

  if (!isExpanded) {
    // Minimized call bar
    return (
      <div
        style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 90,
          background: '#6BB700', color: '#fff',
          padding: '8px 16px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div
            style={{
              width: 8, height: 8, background: '#fff', borderRadius: '50%',
              animation: 'callPulse 2s infinite',
            }}
          />
          <span style={{ fontSize: 14, fontWeight: 500 }}>
            Call with {currentCall.remoteName || 'Unknown'}
          </span>
          <span style={{ fontSize: 12, opacity: 0.8 }}>{duration}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => setIsExpanded(true)}
            onMouseEnter={() => setHoveredBtn('expand')}
            onMouseLeave={() => setHoveredBtn(null)}
            style={{
              padding: 6, borderRadius: 6, border: 'none',
              background: hoveredBtn === 'expand' ? 'rgba(255,255,255,0.2)' : 'transparent',
              color: '#fff', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              transition: 'background 0.15s',
            }}
          >
            <Maximize2 size={16} />
          </button>
          <button
            onClick={() => hangup(currentCall.id)}
            onMouseEnter={() => setHoveredBtn('end-min')}
            onMouseLeave={() => setHoveredBtn(null)}
            style={{
              padding: '4px 12px', borderRadius: 20, border: 'none',
              background: hoveredBtn === 'end-min' ? '#C41E24' : '#D13438',
              color: '#fff', fontSize: 12, fontWeight: 500,
              cursor: 'pointer', transition: 'background 0.15s',
            }}
          >
            End
          </button>
        </div>

        {/* Keep audio playing while the call is minimized (audio + video calls). */}
        <audio ref={remoteAudioRef} autoPlay />

        <style>{`
          @keyframes callPulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.3; }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        background: '#1A1A2E',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 24px',
          background: 'rgba(0,0,0,0.3)',
          flexShrink: 0,
        }}
      >
        <div>
          <h3 style={{ color: '#fff', fontWeight: 600, fontSize: 18, margin: 0 }}>
            {currentCall.remoteName || 'Unknown'}
          </h3>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14, margin: '4px 0 0 0' }}>
            {duration} • {isVideoCall ? 'Video Call' : 'Audio Call'}
          </p>
        </div>
        <button
          onClick={() => setIsExpanded(false)}
          onMouseEnter={() => setHoveredBtn('minimize')}
          onMouseLeave={() => setHoveredBtn(null)}
          style={{
            padding: 8, borderRadius: 8, border: 'none',
            background: hoveredBtn === 'minimize' ? 'rgba(255,255,255,0.1)' : 'transparent',
            color: hoveredBtn === 'minimize' ? '#fff' : 'rgba(255,255,255,0.7)',
            cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s',
          }}
        >
          <Minimize2 size={20} />
        </button>
      </div>

      {/* Screen Sharing Banner */}
      {isScreenSharing && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          padding: '8px 20px', background: '#6264A7', color: '#fff', flexShrink: 0,
          fontSize: 13, fontWeight: 500,
        }}>
          <Monitor size={16} />
          <span>You are sharing your screen</span>
          <button
            onClick={() => stopScreenShare(currentCall.id)}
            style={{ marginLeft: 10, padding: '4px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.15)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            Stop Sharing
          </button>
        </div>
      )}

      {/* Remote Control Incoming Request */}
      {remoteControlIncoming && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          padding: '10px 20px', background: '#FFF4CE', color: '#6B5900', flexShrink: 0,
          fontSize: 13, fontWeight: 500,
        }}>
          <Hand size={16} />
          <span><b>{controlRequester}</b> is requesting remote control of your screen</span>
          <button
            onClick={grantRemoteControl}
            style={{ padding: '4px 14px', borderRadius: 6, border: 'none', background: '#6264A7', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            Allow
          </button>
          <button
            onClick={denyRemoteControl}
            style={{ padding: '4px 14px', borderRadius: 6, border: '1px solid #D13438', background: '#fff', color: '#D13438', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            Deny
          </button>
        </div>
      )}

      {/* Remote Control Active Banner */}
      {remoteControlActive && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          padding: '8px 20px', background: '#107C10', color: '#fff', flexShrink: 0,
          fontSize: 13, fontWeight: 500,
        }}>
          <MousePointer2 size={16} />
          <span>Remote control is active</span>
          <button
            onClick={endRemoteControl}
            style={{ marginLeft: 10, padding: '4px 14px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.15)', color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
          >
            End Control
          </button>
        </div>
      )}

      {/* Video / Audio Area */}
      <div
        style={{
          flex: 1, position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        {isVideoCall ? (
          <>
            {/* Remote Video (large) + pointer capture area */}
            <div
              ref={videoContainerRef}
              onMouseMove={remoteControlRole === 'controller' ? handlePointerMove : undefined}
              onClick={remoteControlRole === 'controller' ? handlePointerClick : undefined}
              style={{
                position: 'relative', width: '100%', height: '100%',
                cursor: remoteControlRole === 'controller' ? 'none' : 'default',
              }}
            >
              <video
                ref={remoteVideoRef}
                autoPlay
                playsInline
                style={{ width: '100%', height: '100%', objectFit: 'contain', background: '#1a1a2e' }}
              />

              {/* Remote pointer overlay (sharer sees the controller's pointer) */}
              {remoteControlRole === 'sharer' && remotePointer && (
                <div style={{
                  position: 'absolute', left: `${remotePointer.x * 100}%`, top: `${remotePointer.y * 100}%`,
                  transform: 'translate(-2px, -2px)', pointerEvents: 'none', zIndex: 20,
                  transition: 'left 0.05s linear, top 0.05s linear',
                }}>
                  {/* Pointer arrow */}
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <path d="M4 2L4 20L9.5 14.5L15 20L18 17L12.5 11.5L20 8L4 2Z" fill="#5B5FC7" stroke="#fff" strokeWidth="1.5"/>
                  </svg>
                  {/* Name label */}
                  <div style={{
                    position: 'absolute', left: 18, top: 16,
                    background: '#5B5FC7', color: '#fff', fontSize: 10, fontWeight: 600,
                    padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap',
                  }}>
                    {controlRequester || 'Remote'}
                  </div>
                </div>
              )}

              {/* Click ripple effect (sharer sees when controller clicks) */}
              {remoteControlRole === 'sharer' && clickRipple && (
                <div key={clickRipple.id} style={{
                  position: 'absolute', left: `${clickRipple.x * 100}%`, top: `${clickRipple.y * 100}%`,
                  transform: 'translate(-20px, -20px)', pointerEvents: 'none', zIndex: 21,
                }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: '50%',
                    border: '3px solid #5B5FC7',
                    animation: 'ripple 0.6s ease-out forwards',
                  }} />
                  <style>{`@keyframes ripple{0%{transform:scale(0.5);opacity:1}100%{transform:scale(2);opacity:0}}`}</style>
                </div>
              )}

              {/* Controller's own cursor indicator */}
              {remoteControlRole === 'controller' && (
                <div style={{
                  position: 'absolute', top: 8, left: '50%', transform: 'translateX(-50%)',
                  background: 'rgba(91,95,199,0.85)', color: '#fff', fontSize: 11, fontWeight: 500,
                  padding: '4px 12px', borderRadius: 12, pointerEvents: 'none', zIndex: 20,
                }}>
                  You are controlling — move mouse to point
                </div>
              )}
            </div>

            {/* Local Video (small overlay) */}
            <div
              style={{
                position: 'absolute', bottom: 16, right: 16,
                width: 192, height: 144,
                borderRadius: 12, overflow: 'hidden',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                border: '2px solid rgba(255,255,255,0.2)',
              }}
            >
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={{ width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
              />
            </div>
          </>
        ) : (
          // Audio-only — show avatar
          <div style={{ textAlign: 'center' }}>
            <div
              style={{
                width: 128, height: 128, borderRadius: '50%', margin: '0 auto 24px',
                background: 'linear-gradient(135deg, #6264A7, #5B5FC7)',
                color: '#fff',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 48, fontWeight: 700,
              }}
            >
              {currentCall.remoteName?.[0]?.toUpperCase() || '?'}
            </div>
            <h3 style={{ color: '#fff', fontSize: 24, fontWeight: 600, margin: 0 }}>
              {currentCall.remoteName || 'Unknown'}
            </h3>
            <p style={{ color: 'rgba(255,255,255,0.5)', marginTop: 8, fontSize: 16 }}>{duration}</p>
            {/* Hidden audio sink — plays the remote participant's voice */}
            <audio ref={remoteAudioRef} autoPlay />
          </div>
        )}
      </div>

      {/* Controls */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16,
          padding: '24px 0',
          background: 'rgba(0,0,0,0.3)',
          flexShrink: 0,
        }}
      >
        {/* Mute */}
        <CallButton
          icon={currentCall.isMuted ? <MicOff size={22} /> : <Mic size={22} />}
          label={currentCall.isMuted ? 'Unmute' : 'Mute'}
          active={currentCall.isMuted}
          onClick={() => toggleMute(currentCall.id)}
          id="mute"
          hoveredBtn={hoveredBtn}
          setHoveredBtn={setHoveredBtn}
        />

        {/* Video Toggle */}
        <CallButton
          icon={isCameraOn ? <Video size={22} /> : <VideoOff size={22} />}
          label={isCameraOn ? 'Stop Video' : 'Start Video'}
          active={!isCameraOn}
          onClick={() => toggleVideo(currentCall.id)}
          id="video"
          hoveredBtn={hoveredBtn}
          setHoveredBtn={setHoveredBtn}
        />

        {/* Screen Share */}
        <CallButton
          icon={isScreenSharing ? <MonitorOff size={22} /> : <Monitor size={22} />}
          label={isScreenSharing ? 'Stop Sharing' : 'Share Screen'}
          active={isScreenSharing}
          onClick={() =>
            isScreenSharing
              ? stopScreenShare(currentCall.id)
              : startScreenShare(currentCall.id)
          }
          id="screen"
          hoveredBtn={hoveredBtn}
          setHoveredBtn={setHoveredBtn}
        />

        {/* Request Remote Control */}
        <CallButton
          icon={remoteControlActive ? <Shield size={22} /> : remoteControlRequested ? <Hand size={22} /> : <MousePointer2 size={22} />}
          label={remoteControlActive ? 'End Control' : remoteControlRequested ? 'Requesting...' : 'Request Control'}
          active={remoteControlActive || remoteControlRequested}
          onClick={() => {
            if (remoteControlActive) endRemoteControl();
            else if (!remoteControlRequested) requestRemoteControl();
          }}
          id="control"
          hoveredBtn={hoveredBtn}
          setHoveredBtn={setHoveredBtn}
        />

        {/* Add people — escalates the 1:1 into a group call (Teams-style).
            Only shown when the call is linked to a conversation. */}
        {currentCall.conversationId && (
          <CallButton
            icon={<UserPlus size={22} />}
            label="Add people"
            active={showAddPanel}
            onClick={() => setShowAddPanel((v) => !v)}
            id="add"
            hoveredBtn={hoveredBtn}
            setHoveredBtn={setHoveredBtn}
          />
        )}

        {/* Hang Up */}
        <button
          onClick={() => hangup(currentCall.id)}
          onMouseEnter={() => setHoveredBtn('hangup')}
          onMouseLeave={() => setHoveredBtn(null)}
          title="End Call"
          style={{
            width: 56, height: 56, borderRadius: '50%',
            background: hoveredBtn === 'hangup' ? '#C41E24' : '#D13438',
            color: '#fff', border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
            transition: 'background 0.15s',
            boxShadow: '0 4px 16px rgba(209,52,56,0.4)',
          }}
        >
          <PhoneOff size={24} />
        </button>
      </div>

      {showAddPanel && currentCall.conversationId && (
        <AddPeoplePanel
          excludeUserId={currentCall.remoteUserId}
          onClose={() => setShowAddPanel(false)}
          onPick={async (userId) => {
            setShowAddPanel(false);
            await escalateToGroup(userId);
          }}
        />
      )}
    </div>
  );
}

// ─── Add-people panel (1:1 → group escalation) ──────────────────────────────
interface AddSearchUser {
  id: string;
  display_name: string;
  email: string;
  department: string | null;
  avatar_url: string | null;
}

function AddPeoplePanel({
  excludeUserId,
  onClose,
  onPick,
}: {
  excludeUserId: string;
  onClose: () => void;
  onPick: (userId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AddSearchUser[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = query.trim();
    setLoading(true);
    const run = () => {
      api.get('/users', { params: trimmed ? { search: trimmed } : undefined })
        .then(({ data }) => {
          setResults((data?.users || []).filter((u: AddSearchUser) => u.id !== excludeUserId));
          setLoading(false);
        })
        .catch(() => { setResults([]); setLoading(false); });
    };
    if (!trimmed) run();
    else debounceRef.current = setTimeout(run, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, excludeUserId]);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 20,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380, maxWidth: '90%', maxHeight: '70%',
          background: '#1A1A2E', border: '1px solid #2A2A45', borderRadius: 14,
          display: 'flex', flexDirection: 'column', color: '#fff',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #2A2A45' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <UserPlus size={16} />
            <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Add people to this call</h3>
          </div>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: '#8B8CA7', cursor: 'pointer', display: 'flex' }}>
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '12px 16px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#0F0F1F', border: '1px solid #2A2A45', borderRadius: 8, padding: '8px 10px' }}>
            <Search size={14} color="#8B8CA7" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or email…"
              style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#fff', fontSize: 13, fontFamily: 'inherit', minWidth: 0 }}
            />
            {loading && <Loader2 size={14} color="#8B8CA7" style={{ animation: 'spin 1s linear infinite' }} />}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '4px 8px 12px' }}>
          {!loading && results.length === 0 && (
            <div style={{ padding: '20px 8px', fontSize: 12, color: '#8B8CA7', textAlign: 'center' }}>
              {query.trim() ? `No users match "${query}".` : 'No other users found.'}
            </div>
          )}
          {results.map((u) => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8 }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', background: '#6264A7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0, overflow: 'hidden' }}>
                {u.avatar_url ? <img src={u.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : (u.display_name || u.email || '?').charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.display_name || u.email}</div>
                <div style={{ fontSize: 11, color: '#8B8CA7', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.department || u.email}</div>
              </div>
              <button
                onClick={() => onPick(u.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', borderRadius: 6, background: '#6264A7', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, fontFamily: 'inherit', flexShrink: 0 }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#7172B3'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = '#6264A7'; }}
              >
                <UserPlus size={11} /> Add
              </button>
            </div>
          ))}
        </div>
        <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}

function CallButton({
  icon,
  label,
  active,
  onClick,
  id,
  hoveredBtn,
  setHoveredBtn,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
  id: string;
  hoveredBtn: string | null;
  setHoveredBtn: (id: string | null) => void;
}) {
  const isHovered = hoveredBtn === id;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHoveredBtn(id)}
      onMouseLeave={() => setHoveredBtn(null)}
      title={label}
      style={{
        width: 48, height: 48, borderRadius: '50%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', cursor: 'pointer',
        transition: 'background 0.15s',
        color: active ? '#fff' : 'rgba(255,255,255,0.8)',
        background: active
          ? 'rgba(255,255,255,0.3)'
          : isHovered
            ? 'rgba(255,255,255,0.2)'
            : 'rgba(255,255,255,0.1)',
      }}
    >
      {icon}
    </button>
  );
}
