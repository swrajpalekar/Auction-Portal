/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps, react/no-unescaped-entities */
'use client';
import { useState, useEffect, useRef } from 'react';
import { Player } from '@/lib/types';
import { ROLE_COLORS } from '@/lib/data';
import Avatar from '@/components/ui/Avatar';
import { RBadge, TBadge } from '@/components/ui/Badges';
import BarChart from '@/components/charts/BarChart';
import DonutChart from '@/components/charts/DonutChart';
import Spinner from '@/components/ui/Spinner';
import { ServerRoom } from '@/lib/db';
import { supabase } from '@/lib/supabase';
import { playBidSound, playCountdownSound, playSoldSound } from '@/lib/sounds';

const BID_TIMER_SECONDS = 30;

interface AuctionRoomProps {
  roomId: string;
  userId: string;
  teamId: string;
  userName: string;
  onLeave: () => void;
}

type Tab = 'live' | 'myteam' | 'allteams' | 'analytics';

const TABS: { id: Tab; label: string }[] = [
  { id: 'live', label: '🔴 Live Auction' },
  { id: 'myteam', label: '👤 My Team' },
  { id: 'allteams', label: '🏆 All Teams' },
  { id: 'analytics', label: '📊 Analytics' },
];

export default function AuctionRoom({ roomId, userId, teamId, userName, onLeave }: AuctionRoomProps) {
  const [roomState, setRoomState] = useState<ServerRoom | null>(null);
  const [tab, setTab] = useState<Tab>('live');
  const [chatMsg, setChatMsg] = useState('');
  const [customBid, setCustomBid] = useState('');
  const [selTeam, setSelTeam] = useState(teamId);
  const [timeLeft, setTimeLeft] = useState(BID_TIMER_SECONDS);
  const [submitting, setSubmitting] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const [splitPct, setSplitPct] = useState(42); // percentage for bid history height
  const [timeToStart, setTimeToStart] = useState<number>(0);
  const [launchOverlay, setLaunchOverlay] = useState<number | string | null>(null);
  const lastPhaseRef = useRef<string | null>(null);

  const formatTimeToStart = (ms: number) => {
    if (ms <= 0) return '00:00:00';
    const totalSecs = Math.floor(ms / 1000);
    const secs = totalSecs % 60;
    const mins = Math.floor(totalSecs / 60) % 60;
    const hours = Math.floor(totalSecs / 3600);

    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  };

  const getParticipantStatus = (ownerId: string | null | undefined) => {
    if (ownerId === userId) return '👤 Connected (You)';
    if (ownerId) return '👤 Connected';
    if (roomState?.phase === 'lobby' || roomState?.phase === 'scheduled') {
      return roomState?.enableBots ? '🪑 Open slot / bot slot' : '🪑 Open slot';
    }
    return roomState?.enableBots ? '🤖 CPU Bot' : '🪑 Open slot';
  };

  const handleDownloadResults = () => {
    if (!roomState) return;

    const rows = [
      ['Team Name', 'Player Name', 'Role', 'Country', 'Sold Price (₹L)'],
    ];

    roomState.participants.forEach((team: any) => {
      if (team.squad.length === 0) {
        rows.push([team.name, 'No players', '', '', '']);
        return;
      }

      team.squad.forEach((player: any) => {
        rows.push([
          team.name,
          player.name,
          player.role,
          player.country,
          String(player.soldPrice ?? ''),
        ]);
      });
    });

    const csv = rows
      .map((row) =>
        row
          .map((value) => `"${String(value).replace(/"/g, '""')}"`)
          .join(',')
      )
      .join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${roomState.id.toLowerCase()}-results.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Subscribe to Supabase Realtime for instant updates; initial fetch on mount
  useEffect(() => {
    let active = true;

    async function fetchState() {
      try {
        const res = await fetch(`/api/rooms/${roomId}?t=${Date.now()}`, { cache: 'no-store' });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (active) setRoomState(data.room);
      } catch (err) {
        console.error('Error fetching room state:', err);
      }
    }

    // Fetch once immediately
    fetchState();

    // Subscribe via WebSocket — triggers fetchState() when room row changes.
    // This replaces the 1-second HTTP polling loop and eliminates the DB hammering.
    // Guard: supabase is null when NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are missing (local file fallback mode).
    if (!supabase) {
      return () => { active = false; };
    }

    const channelName = `room-changes-${roomId}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rooms' },
        () => {
          // Re-fetch full room state (includes teams, bids, chat via getRoom)
          if (active) fetchState();
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'chat_messages' },
        () => {
          if (active) fetchState();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'bids' },
        () => {
          if (active) fetchState();
        }
      )
      .subscribe();

    // Fallback polling every 3 seconds
    // This guarantees the UI updates even if WebSockets disconnect or Supabase Replication isn't fully enabled
    const fallbackInterval = setInterval(() => {
      if (active) fetchState();
    }, 3000);

    return () => {
      active = false;
      clearInterval(fallbackInterval);
      supabase!.removeChannel(channel);
    };
  }, [roomId]);

  const transitionRef = useRef(false);

  // Smooth client-side timer tick sync from server's endsAt timestamp
  useEffect(() => {
    let mounted = true;
    transitionRef.current = false; // Reset when roomState updates
    const timer = setInterval(() => {
      if (roomState && roomState.endsAt) {
        const left = Math.max(0, Math.ceil((roomState.endsAt - Date.now()) / 1000));
        if (roomState.phase === 'bidding') setTimeLeft(left);

        // When timer hits 0, ping server once to process phase transition (sold/unsold/next)
        if (left === 0 && !transitionRef.current && (roomState.phase === 'bidding' || roomState.phase === 'sold' || roomState.phase === 'unsold')) {
          transitionRef.current = true;
          fetch(`/api/rooms/${roomState.id}?t=${Date.now()}`, { cache: 'no-store' })
            .then(res => res.json())
            .then(data => {
              if (data.room) {
                // ALWAYS update the UI with the fresh server state.
                // This instantly fixes the timer if we missed a Realtime WebSocket event 
                // (e.g. someone bid, extending the timer, but our browser didn't get the ping).
                if (mounted) setRoomState(data.room);
                
                if (data.room.phase === roomState.phase) {
                  // If phase didn't advance (clock skew or timer was extended), reset ref to allow future pings
                  setTimeout(() => { transitionRef.current = false; }, 500);
                } else {
                  // Server successfully advanced the phase
                  transitionRef.current = false;
                }
              }
            })
            .catch(() => {
              setTimeout(() => { transitionRef.current = false; }, 1000);
            });
        }
      }
    }, 100);

    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [roomState]);

  // Timer for scheduled auto-start countdown
  useEffect(() => {
    if (roomState && roomState.phase === 'scheduled' && roomState.scheduledAt) {
      const update = () => {
        setTimeToStart(Math.max(0, roomState.scheduledAt! - Date.now()));
      };
      update();
      const timer = setInterval(update, 250);
      return () => clearInterval(timer);
    }
  }, [roomState?.phase, roomState?.scheduledAt]);

  // Monitor phase transitions to trigger 3-2-1 launch animation
  useEffect(() => {
    if (!roomState) return;

    if (roomState.phase === 'bidding' &&
        (lastPhaseRef.current === 'lobby' || lastPhaseRef.current === 'scheduled')) {
      
      let val = 3;
      setLaunchOverlay(3);
      playCountdownSound();

      const timer = setInterval(() => {
        val -= 1;
        if (val > 0) {
          setLaunchOverlay(val);
          playCountdownSound();
        } else if (val === 0) {
          setLaunchOverlay('GO!');
          playBidSound();
        } else {
          clearInterval(timer);
          setLaunchOverlay(null);
        }
      }, 900);
    }

    lastPhaseRef.current = roomState.phase;
  }, [roomState?.phase]);

  // Auto-scroll chat on change
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [roomState?.chat]);

  // Auto-switch to analytics tab when auction ends
  useEffect(() => {
    if (roomState?.phase === 'done') {
      const t = setTimeout(() => setTab('analytics'), 0);
      return () => clearTimeout(t);
    }
  }, [roomState?.phase]);

  // --- SOUND EFFECTS ---
  const lastBidRef = useRef(roomState?.currentBid);
  useEffect(() => {
    if (roomState?.phase === 'bidding' && roomState.currentBid > (lastBidRef.current || 0)) {
      playBidSound();
    }
    lastBidRef.current = roomState?.currentBid;
  }, [roomState?.currentBid, roomState?.phase]);

  const lastTimeRef = useRef(timeLeft);
  useEffect(() => {
    if (roomState?.phase === 'bidding' && timeLeft > 0 && timeLeft <= 5 && timeLeft !== lastTimeRef.current) {
      playCountdownSound();
    }
    lastTimeRef.current = timeLeft;
  }, [timeLeft, roomState?.phase]);

  useEffect(() => {
    if (roomState?.phase === 'sold') {
      playSoldSound();
    }
  }, [roomState?.phase]);

  async function handleStartAuction() {
    if (!roomState || roomState.phase !== 'lobby' || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { type: 'START' },
          userId,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setRoomState(data.room);
      }
    } catch (err) {
      console.error('Failed to start auction:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBid(increment: number) {
    if (!roomState || roomState.phase !== 'bidding' || submitting) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { type: 'BID', bidder: teamId, amount: increment },
          userId,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setRoomState(data.room);
      }
    } catch (err) {
      console.error('Failed to place bid:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    if (!roomState || roomState.phase !== 'bidding' || submitting) return;
    const msg = roomState.currentBidder
      ? 'Skip this player? The current standing bid will be discarded and the player marked unsold.'
      : 'Skip this player? With no bids placed, they will be marked unsold and the auction moves on.';
    if (!confirm(msg)) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { type: 'SKIP' },
          userId,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setRoomState(data.room);
      }
    } catch (err) {
      console.error('Failed to skip player:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePass() {
    if (!roomState || roomState.phase !== 'bidding' || submitting) return;
    if (roomState.currentBidder === teamId) return; // can't pass while winning
    setSubmitting(true);
    try {
      const res = await fetch(`/api/rooms/${roomId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { type: 'PASS', bidder: teamId },
          userId,
        }),
      });
      const data = await res.json();
      if (data.error) {
        alert(data.error);
      } else {
        setRoomState(data.room);
      }
    } catch (err) {
      console.error('Failed to pass:', err);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSendChat() {
    if (!chatMsg.trim() || !roomState) return;
    const msgToSend = chatMsg.trim();
    setChatMsg(''); // clear locally instantly
    try {
      const res = await fetch(`/api/rooms/${roomId}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: { type: 'CHAT', msg: msgToSend, user: userName || 'Guest' },
          userId,
        }),
      });
      const data = await res.json();
      if (data.error) {
        console.error(data.error);
      } else {
        setRoomState(data.room);
      }
    } catch (err) {
      console.error('Failed to send chat message:', err);
    }
  }

  if (!roomState) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14 }}>
        <Spinner />
        <span style={{ fontFamily: "'Rajdhani', sans-serif", color: 'var(--t2)', fontSize: 14 }}>Connecting to room {roomId}...</span>
      </div>
    );
  }

  // ── LOBBY / SCHEDULED SCREEN ──
  if (roomState.phase === 'lobby' || roomState.phase === 'scheduled') {
    const isHost = roomState.hostId === userId;
    const isScheduled = roomState.phase === 'scheduled';
    const totalTeams = roomState.participants.length;
    const joinedTeams = roomState.participants.filter((p) => p.ownerId !== null).length;
    const allTeamsJoined = roomState.enableBots ? (joinedTeams >= 1) : (joinedTeams === totalTeams);
    return (
      <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)' }}>
        {/* Header */}
        <div style={{ padding: '13px 36px', borderBottom: '1px solid var(--bd)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 24, color: 'var(--g)', letterSpacing: 2 }}>SAR</span>
            <span style={{ color: 'var(--t3)' }}>/</span>
            <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, color: 'var(--t2)' }}>Lobby - {roomState.name}</span>
          </div>
          <button className="btn bs bsm" onClick={onLeave}>Leave Room</button>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20, padding: 24, maxWidth: 1100, width: '100%', margin: '0 auto', overflow: 'hidden', minHeight: 0 }}>
          {/* Left Panel: Teams & Players */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'auto' }}>
            <div className="card" style={{ flex: 1, padding: 20 }}>
              <h3 style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 24, letterSpacing: 2, marginBottom: 12 }}>Connected Teams</h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {roomState.participants.map((p) => {
                  const isUserTeam = p.id === teamId;
                  return (
                    <div key={p.id} className="card hover-lift" style={{ padding: 12, border: `1px solid ${p.color}${isUserTeam ? '' : '33'}`, background: isUserTeam ? `${p.color}08` : 'var(--bg3)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Avatar name={p.name} size={36} color={p.color} photo={p.photo} />
                        <div style={{ overflow: 'hidden' }}>
                          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 14, color: p.color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--t3)', marginTop: 2 }}>
                            {getParticipantStatus(p.ownerId)}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Config Box */}
            <div className="card hover-lift" style={{ padding: 16 }}>
              <h4 style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 12, color: 'var(--t3)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>Room Settings</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                <div style={{ background: 'var(--bg3)', padding: 8, borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>SPORT</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, color: 'var(--t1)', marginTop: 2 }}>{roomState.sport}</div>
                </div>
                <div style={{ background: 'var(--bg3)', padding: 8, borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>BUDGET</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, color: 'var(--g)', marginTop: 2 }}>₹{roomState.budget}L</div>
                </div>
                <div style={{ background: 'var(--bg3)', padding: 8, borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>PLAYERS</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, color: 'var(--t1)', marginTop: 2 }}>{roomState.players.length}</div>
                </div>
                <div style={{ background: 'var(--bg3)', padding: 8, borderRadius: 8, textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: 'var(--t3)' }}>BOTS</div>
                  <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, color: roomState.enableBots ? 'var(--am)' : 'var(--t3)', marginTop: 2 }}>
                    {roomState.enableBots ? 'ON' : 'OFF'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Panel: Lobby Chat & Start Action */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflow: 'hidden' }}>
            {/* Action Box */}
            <div className="card hover-lift" style={{ padding: 20, textAlign: 'center', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 10 }}>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, color: 'var(--t2)' }}>INVITE CODE</div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 36, color: 'var(--g)', letterSpacing: 4, background: 'var(--bg3)', padding: '8px 0', borderRadius: 8, border: '1px solid var(--bd2)' }}>
                {roomState.id}
              </div>
              <p style={{ fontSize: 11, color: 'var(--t3)' }}>Share this code with friends so they can join and bid.</p>

              {isScheduled ? (
                <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <div style={{
                    background: 'var(--bg3)',
                    border: '1px solid var(--bd2)',
                    borderRadius: 10,
                    padding: 14,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 6
                  }}>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 11, fontWeight: 700, color: 'var(--am)', letterSpacing: 1.5, textTransform: 'uppercase' }}>
                      📅 Scheduled Auction
                    </div>
                    {allTeamsJoined ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div style={{ fontSize: 11, color: 'var(--t3)', letterSpacing: 0.5 }}>AUTO-STARTING IN</div>
                        <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 38, color: 'var(--am)', letterSpacing: 2, textShadow: '0 0 12px rgba(245,158,11,0.4)', lineHeight: 1.1 }}>
                          {formatTimeToStart(timeToStart)}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--g)', fontWeight: 600 }}>✓ {joinedTeams} {joinedTeams === 1 ? 'team' : 'teams'} joined!</div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                        <div style={{ fontSize: 12, color: 'var(--t2)', fontWeight: 600 }}>
                          Waiting for teams ({joinedTeams}/{totalTeams})
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--t3)' }}>
                          Starts once everyone joins & scheduled time arrives
                        </div>
                      </div>
                    )}
                  </div>
                  {isHost && (
                    <button className="btn bp" onClick={handleStartAuction} disabled={submitting} style={{ fontSize: 14, padding: 12, width: '100%', marginTop: 4 }}>
                      {submitting ? 'Starting...' : '🚀 START AUCTION NOW'}
                    </button>
                  )}
                </div>
              ) : (
                isHost ? (
                  <button className="btn bp" onClick={handleStartAuction} disabled={submitting} style={{ fontSize: 14, padding: 12, width: '100%', marginTop: 8 }}>
                    {submitting ? 'Starting...' : '🚀 START AUCTION'}
                  </button>
                ) : (
                  <div style={{ padding: 10, borderRadius: 8, background: 'var(--bg3)', border: '1px solid var(--bd2)', color: 'var(--am)', fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, animation: 'pulse 2s infinite', fontSize: 13, marginTop: 8 }}>
                    ⏳ Waiting for host to start...
                  </div>
                )
              )}
            </div>

            {/* Chat Box */}
            <div className="card" style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: 16, overflow: 'hidden', minHeight: 0 }}>
              <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 8 }}>Lobby Chat</div>
              <div ref={chatRef} style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 5, paddingRight: 4 }}>
                {roomState.chat.map((c) => (
                  <div key={c.id} style={{ fontSize: 12, lineHeight: 1.4 }}>
                    <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, marginRight: 4, color: c.user === userName ? 'var(--g)' : c.user === 'System' ? 'var(--am)' : 'var(--t2)' }}>{c.user}:</span>
                    <span style={{ color: 'var(--t2)' }}>{c.msg}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <input className="inp" placeholder="Type a message..." value={chatMsg} onChange={(e) => setChatMsg(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat(); }} style={{ flex: 1, fontSize: 12, padding: '7px 10px' }} />
                <button className="btn bp bsm" onClick={handleSendChat}>Send</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const pl = roomState.players[roomState.playerIdx];
  const me = roomState.participants.find((p) => p.id === teamId) || roomState.participants[0];
  const win = roomState.participants.find((p) => p.id === roomState.currentBidder);
  const tc = timeLeft > 10 ? 'var(--g)' : timeLeft > 5 ? 'var(--am)' : 'var(--re)';
  const isEnd = roomState.phase === 'sold' || roomState.phase === 'unsold' || roomState.phase === 'done';
  const isHost = roomState.hostId === userId;
  const canSkip = roomState.phase === 'bidding';
  const hasPassed = !!roomState.passedBy?.includes(teamId);
  const isHighBidder = roomState.currentBidder === teamId;

  // Effective budget left — subtracts a participant's standing bid so their
  // available budget visibly drops the moment they become the highest bidder
  // (the actual `spent` only updates once the player is sold).
  const availLeft = (p: { id: string; budget: number; spent: number }) => {
    const pending = (roomState.currentBidder === p.id && (roomState.phase === 'bidding' || roomState.phase === 'sold'))
      ? roomState.currentBid
      : 0;
    return p.budget - p.spent - pending;
  };

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg)', overflow: 'hidden' }}>
      {/* Top nav + tabs */}
      <div style={{ borderBottom: '1px solid var(--bd)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', height: 54, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, color: 'var(--g)', letterSpacing: 2 }}>SAR</span>
          <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 12, color: 'var(--t3)', background: 'var(--bg3)', padding: '2px 8px', borderRadius: 6 }}>Code: {roomState.id}</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{ padding: '6px 14px', border: 'none', background: tab === t.id ? 'var(--bg3)' : 'transparent', color: tab === t.id ? 'var(--t1)' : 'var(--t3)', fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 13, letterSpacing: .5, cursor: 'pointer', borderRadius: 7, borderBottom: tab === t.id ? `2px solid var(--g)` : '2px solid transparent', transition: 'all .2s' }}>
              {t.label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 12, color: 'var(--t3)' }}>
            {roomState.playerIdx + 1}/{roomState.players.length} players
          </div>
          <button className="btn bs bsm" onClick={onLeave} style={{ padding: '4px 10px' }}>Leave</button>
        </div>
      </div>

      {/* ── LIVE TAB ── */}
      {tab === 'live' && (
        <div className="auction-grid" style={{ flex: 1 }}>
          {/* Left: Team sidebar */}
          <div style={{ background: 'var(--bg2)', borderRight: '1px solid var(--bd)', overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 4 }}>Teams</div>
            {roomState.participants.map((p) => {
              const isBidder = roomState.currentBidder === p.id;
              return (
                <div key={p.id} className="card hover-lift" style={{ 
                  padding: '10px 12px', 
                  border: `1px solid ${isBidder ? p.color : p.color + '44'}`, 
                  background: isBidder ? p.color + '11' : p.id === teamId ? 'rgba(0, 220, 114, 0.04)' : 'var(--bg2)',
                  boxShadow: isBidder ? `0 0 16px ${p.color}44, inset 0 0 8px ${p.color}22` : 'none',
                  transform: isBidder ? 'scale(1.02)' : 'none',
                  transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Avatar name={p.name} size={28} color={p.color} photo={p.photo} />
                    <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 13, color: p.color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.name} {p.ownerId === userId ? '(You)' : ''}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t2)', alignItems: 'center' }}>
                    <span>
                      <strong style={{ color: isBidder ? p.color : 'var(--t1)', fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, letterSpacing: 1 }}>₹{availLeft(p)}L</strong> left
                    </span>
                    <span>
                      <strong style={{ color: 'var(--t1)', fontFamily: "'Bebas Neue', sans-serif", fontSize: 15, letterSpacing: 1 }}>{p.squad.length}</strong>/{roomState.squadSize}
                    </span>
                  </div>
                  <div style={{ marginTop: 5, height: 3, background: 'var(--bd2)', borderRadius: 2 }}>
                    <div style={{ height: '100%', width: `${((p.budget - availLeft(p)) / p.budget) * 100}%`, background: p.color, borderRadius: 2, transition: 'width .4s' }} />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Center: Bidding */}
          <div style={{ display: 'flex', flexDirection: 'column', overflow: 'auto', padding: 14, gap: 11 }}>
            {isEnd ? (
              <div key={`end${roomState.playerIdx}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
                <div key={roomState.phase} className={roomState.phase === 'sold' ? 'anim-stamp' : ''} style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 80, letterSpacing: 5, color: roomState.phase === 'sold' ? 'var(--g)' : roomState.phase === 'done' ? 'var(--g)' : 'var(--t3)', textShadow: roomState.phase === 'sold' ? '0 0 44px rgba(0,220,114,.4)' : 'none' }}>
                  {roomState.phase === 'sold' ? 'SOLD!' : roomState.phase === 'done' ? 'AUCTION OVER!' : 'UNSOLD'}
                </div>
                {roomState.phase === 'sold' && (
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 20, color: 'var(--t1)' }}>{pl?.name}</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 46, color: 'var(--g)', letterSpacing: 3 }}>₹{roomState.currentBid}L</div>
                    {win && (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 8 }}>
                        <Avatar name={win.name} size={32} color={win.color} photo={win.photo} />
                        <div style={{ color: win.color, fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 18 }}>{win.name}</div>
                      </div>
                    )}
                  </div>
                )}
                <div style={{ color: 'var(--t3)', fontSize: 12 }}>{roomState.phase === 'done' ? 'All players have been auctioned.' : 'Preparing next round…'}</div>
              </div>
            ) : (
              <div key={`bid${roomState.playerIdx}`} style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
                {/* Player card */}
                {pl && (
                  <div className="card hover-lift" style={{ border: `2px solid ${(ROLE_COLORS[pl.role] || '#888')}33`, padding: 18, display: 'flex', gap: 14, alignItems: 'center', animation: 'slideIn .4s cubic-bezier(0.4, 0, 0.2, 1)' }}>
                    <div style={{ width: 64, height: 64, borderRadius: 12, background: (ROLE_COLORS[pl.role] || '#888') + '22', border: `2px solid ${ROLE_COLORS[pl.role] || '#888'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Bebas Neue', sans-serif", fontSize: 16, color: ROLE_COLORS[pl.role] || '#888', flexShrink: 0 }}>
                      {pl.img}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
                        <TBadge tier={pl.tier} /><RBadge role={pl.role} />
                        <span style={{ fontSize: 13 }}>{pl.nat || '🌍'}</span>
                      </div>
                      <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 32, letterSpacing: 2, lineHeight: 1 }}>{pl.name}</div>
                      <div style={{ color: 'var(--t2)', fontSize: 12, fontFamily: "'Rajdhani', sans-serif", marginTop: 2 }}>{pl.country}</div>
                    </div>
                    <div style={{ textAlign: 'right', flexShrink: 0 }}>
                      <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: 1 }}>Base</div>
                      <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, color: 'var(--t2)', letterSpacing: 2 }}>₹{pl.base}L</div>
                      <div style={{ color: 'var(--t3)', fontSize: 10, marginTop: 2 }}>{roomState.playerIdx + 1}/{roomState.players.length}</div>
                    </div>
                  </div>
                )}

                {/* Timer + Bid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <div className={`card ${timeLeft <= 5 ? 'anim-urgent' : 'hover-lift'}`} style={{ textAlign: 'center', padding: 14 }}>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, color: 'var(--t3)', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 1 }}>Time Left</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 62, color: tc, letterSpacing: 2, lineHeight: 1, transition: 'color .3s' }}>
                      {String(timeLeft).padStart(2, '0')}
                    </div>
                  </div>
                  <div className="card hover-lift" style={{ textAlign: 'center', padding: 14 }}>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, color: 'var(--t3)', letterSpacing: 2, textTransform: 'uppercase', marginBottom: 1 }}>Current Bid</div>
                    <div key={roomState.currentBid} className="anim-pop" style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 62, color: 'var(--g)', letterSpacing: 2, lineHeight: 1 }}>₹{roomState.currentBid}L</div>
                    {win
                      ? <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 17, color: win.color, marginTop: 4, letterSpacing: .5 }}>Now {win.name}'s turn</div>
                      : <div style={{ color: 'var(--t3)', fontSize: 12, marginTop: 2 }}>No bids yet</div>
                    }
                  </div>
                </div>

                {/* Bid controls */}
                <div className="card" style={{ padding: 13 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 }}>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, color: 'var(--t3)', letterSpacing: 2, textTransform: 'uppercase' }}>Your Bid</div>
                    {hasPassed && (
                      <span style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--re)', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, padding: '3px 8px' }}>
                        🙅 You passed
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 9 }}>
                    {[10, 20].map((inc) => (
                      <button key={inc} className="btn bp"
                        onClick={() => handleBid(inc)}
                        disabled={roomState.phase !== 'bidding' || roomState.currentBidder === teamId || hasPassed || submitting || (me && me.spent + roomState.currentBid + inc > me.budget)}
                        style={{
                          flex: 1,
                          padding: '18px 6px',
                          fontSize: 24,
                          fontFamily: "'Bebas Neue', sans-serif",
                          letterSpacing: 1.5,
                          borderWidth: 2,
                        }}>
                        +₹{inc}L
                      </button>
                    ))}
                  </div>

                  {/* Pass — opt out of the current player */}
                  {!isHighBidder && (
                    <button
                      className="btn bs"
                      onClick={handlePass}
                      disabled={roomState.phase !== 'bidding' || hasPassed || submitting}
                      title={hasPassed ? 'You have passed on this player' : 'Pass — opt out of bidding on this player'}
                      style={{
                        width: '100%',
                        marginTop: 9,
                        padding: '11px 6px',
                        fontSize: 13,
                        fontFamily: "'Rajdhani', sans-serif",
                        fontWeight: 700,
                        letterSpacing: 1,
                        borderWidth: 2,
                        borderColor: 'var(--bd2)',
                        opacity: (hasPassed || roomState.phase !== 'bidding') ? 0.45 : 1,
                        cursor: (hasPassed || roomState.phase !== 'bidding') ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {hasPassed ? '🙅 Passed' : '🙅 Pass on this player'}
                    </button>
                  )}
                  {isHost && (
                    <button
                      className="btn bs"
                      onClick={handleSkip}
                      disabled={!canSkip || submitting}
                      title={roomState.currentBidder ? 'Skip — discards the standing bid and moves to the next player' : 'Skip this player and move on (no bids)'}
                      style={{
                        width: '100%',
                        marginTop: 9,
                        padding: '12px 6px',
                        fontSize: 14,
                        fontFamily: "'Rajdhani', sans-serif",
                        fontWeight: 700,
                        letterSpacing: 1,
                        borderWidth: 2,
                        borderColor: 'var(--am)',
                        color: 'var(--am)',
                        opacity: canSkip ? 1 : 0.45,
                        cursor: canSkip ? 'pointer' : 'not-allowed',
                      }}
                    >
                      ⏭️ {roomState.currentBidder ? 'Skip Player (discard bid)' : 'Skip Player — No Bids'}
                    </button>
                  )}
                  {me && (
                    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--t2)', fontSize: 11, alignItems: 'center', background: 'var(--bg3)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--bd2)' }}>
                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                          <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--t3)', marginBottom: 2 }}>Budget Left{isHighBidder ? ' (incl. bid)' : ''}</span>
                          <span><strong style={{ color: 'var(--g)', fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, letterSpacing: 1 }}>₹{availLeft(me)}L</strong></span>
                        </div>
                        <div style={{ width: 1, height: 30, background: 'var(--bd2)' }} />
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                          <span style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--t3)', marginBottom: 2 }}>Squad Size</span>
                          <span><strong style={{ color: 'var(--t1)', fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, letterSpacing: 1 }}>{me.squad.length}</strong><span style={{ opacity: 0.5 }}>/{roomState.squadSize}</span></span>
                        </div>
                      </div>

                      {/* 1. ROLE DISTRIBUTION */}
                      {me.squad.length > 0 && (
                        <div style={{ padding: 10, background: 'var(--bg3)', borderRadius: 8, border: '1px solid var(--bd2)' }}>
                          <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 1, marginBottom: 6 }}>Your Squad Balance</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                            {Object.entries(me.squad.reduce((acc, p) => ({ ...acc, [p.role]: (acc[p.role] || 0) + 1 }), {} as Record<string, number>)).map(([r, c]) => (
                              <span key={r} style={{ fontSize: 12, padding: '6px 12px', background: 'var(--bg2)', borderRadius: 6, border: '1px solid var(--bd)', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
                                <span style={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>{r}</span> <strong style={{ color: 'var(--t1)', fontSize: 15 }}>{c as number}</strong>
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* 3. UPCOMING PLAYERS */}
                      {(() => {
                        const upcoming = roomState.players.slice(roomState.playerIdx + 1, roomState.playerIdx + 4);
                        if (upcoming.length === 0) return null;
                        return (
                          <div style={{ padding: 10, background: 'var(--bg3)', borderRadius: 8, border: '1px solid var(--bd2)' }}>
                            <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--t3)', letterSpacing: 1, marginBottom: 6 }}>Next In Queue</div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {upcoming.map((p, idx) => (
                                <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--t2)', background: 'var(--bg2)', padding: '6px 10px', borderRadius: 4, border: '1px solid var(--bd)' }}>
                                  <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <span style={{ opacity: 0.5, fontSize: 10 }}>#{roomState.playerIdx + 2 + idx}</span>
                                    <span style={{ fontWeight: 600, color: 'var(--t1)', textTransform: 'uppercase' }}>{p.name}</span> 
                                    <span style={{ fontSize: 10, padding: '2px 6px', background: 'var(--bg3)', borderRadius: 4 }}>{p.role}</span>
                                  </span>
                                  <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 14, letterSpacing: 0.5, color: 'var(--t3)' }}>₹{p.base}L</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Right: History + Chat */}
          <div ref={rightPanelRef} style={{ background: 'var(--bg2)', borderLeft: '1px solid var(--bd)', display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
            {/* Bid History */}
            <div style={{ height: `${splitPct}%`, overflow: 'auto', padding: 10, flexShrink: 0 }}>
              <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 7 }}>Bid History</div>
              {roomState.bidHistory.length === 0
                ? <div style={{ color: 'var(--t3)', fontSize: 12, textAlign: 'center', padding: '12px 0' }}>No bids yet</div>
                : roomState.bidHistory.map((b, i) => {
                  const tm = roomState.participants.find((p) => p.id === b.bidder);
                  return (
                    <div key={b.id || i} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', borderBottom: '1px solid var(--bd)', opacity: Math.max(.2, 1 - i * .08), animation: i === 0 ? 'slideIn .4s cubic-bezier(0.4, 0, 0.2, 1)' : 'none' }}>
                      <div style={{ width: 4, height: 4, borderRadius: '50%', background: tm?.color || 'var(--t3)', flexShrink: 0 }} />
                      <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 600, fontSize: 11, color: tm?.color || 'var(--t2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tm?.name || b.bidder}</span>
                      <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 13, color: 'var(--g)', letterSpacing: .5 }}>₹{b.amount}L</span>
                    </div>
                  );
                })
              }
            </div>

            {/* Drag Handle */}
            <div
              style={{ height: 6, cursor: 'row-resize', background: 'var(--bd)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, userSelect: 'none', transition: 'background 0.2s' }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--g)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--bd)')}
              onMouseDown={(e) => {
                e.preventDefault();
                const panel = rightPanelRef.current;
                if (!panel) return;
                const startY = e.clientY;
                const startPct = splitPct;
                const panelH = panel.getBoundingClientRect().height;
                const onMove = (ev: MouseEvent) => {
                  const delta = ev.clientY - startY;
                  const newPct = Math.min(80, Math.max(15, startPct + (delta / panelH) * 100));
                  setSplitPct(newPct);
                };
                const onUp = () => {
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                };
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
            >
              <div style={{ width: 30, height: 2, borderRadius: 1, background: 'var(--t3)' }} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              <div ref={chatRef} style={{ flex: 1, overflow: 'auto', padding: 9, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 5 }}>Chat</div>
                {roomState.chat.map((c, i) => (
                  <div key={c.id} style={{ fontSize: 12, lineHeight: 1.4, animation: i === roomState.chat.length - 1 ? 'slideIn .3s cubic-bezier(0.4, 0, 0.2, 1)' : 'none' }}>
                    <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, marginRight: 4, color: c.user === userName ? 'var(--g)' : c.user === 'System' ? 'var(--am)' : 'var(--t2)' }}>{c.user}:</span>
                    <span style={{ color: 'var(--t2)' }}>{c.msg}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: 7, borderTop: '1px solid var(--bd)', display: 'flex', gap: 6 }}>
                <input className="inp" placeholder="Chat…" value={chatMsg} onChange={(e) => setChatMsg(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSendChat(); }}
                  style={{ flex: 1, fontSize: 12, padding: '6px 10px' }} />
                <button className="btn bp bsm" onClick={handleSendChat}>↑</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── MY TEAM TAB ── */}
      {tab === 'myteam' && me && (
        <div style={{ padding: 22, maxWidth: 900, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 18 }}>
            {[
              { l: 'Budget Left', v: `₹${me.budget - me.spent}L`, c: 'var(--g)' },
              { l: 'Spent', v: `₹${me.spent}L`, c: 'var(--or)' },
              { l: 'Players', v: `${me.squad.length}/${roomState.squadSize}`, c: 'var(--bl)' },
              { l: 'Avg Price', v: me.squad.length ? `₹${Math.round(me.spent / me.squad.length)}L` : '—', c: 'var(--pu)' },
            ].map((s) => (
              <div key={s.l} className="card" style={{ textAlign: 'center', padding: 13 }}>
                <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, color: 'var(--t3)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 3 }}>{s.l}</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: s.c, letterSpacing: 2 }}>{s.v}</div>
              </div>
            ))}
          </div>
          {me.squad.length === 0
            ? <div style={{ textAlign: 'center', color: 'var(--t3)', padding: 70, fontFamily: "'Rajdhani', sans-serif", fontSize: 15 }}>No players yet — start bidding!</div>
            : <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(185px,1fr))', gap: 10 }}>
              {me.squad.map((p, i) => (
                <div key={String(p.id)} className="card hover-lift" style={{ padding: 13, border: `1px solid ${(ROLE_COLORS[p.role] || '#888')}33`, animation: `fadeUp 0.4s ease forwards`, animationDelay: `${i * 0.05}s`, opacity: 0 }}>
                  <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}><RBadge role={p.role} /><TBadge tier={p.tier} /></div>
                  <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 14, color: 'var(--t1)', marginBottom: 2 }}>{p.name}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--t3)' }}>{p.nat || '🌍'}</span>
                    <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, color: 'var(--g)', letterSpacing: 1 }}>₹{p.soldPrice}L</span>
                  </div>
                </div>
              ))}
            </div>
          }
        </div>
      )}

      {/* ── ALL TEAMS TAB ── */}
      {tab === 'allteams' && (
        <div style={{ padding: 22, maxWidth: 1400, margin: '0 auto', width: '100%', overflowX: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 24, alignItems: 'start' }}>
            {roomState.participants.map((t) => (
              <div key={t.id} style={{ border: `1px solid ${t.color}33`, borderRadius: 12, padding: 18, background: 'var(--bg2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 13, marginBottom: 16 }}>
                  <Avatar name={t.name} size={46} color={t.color} photo={t.photo} />
                  <div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 24, color: t.color, letterSpacing: 1.5 }}>{t.name}</div>
                    <div style={{ color: 'var(--t3)', fontSize: 12 }}>{t.squad.length} players · ₹{t.spent}L spent of ₹{t.budget}L</div>
                  </div>
                </div>
                {t.squad.length === 0
                  ? <div style={{ textAlign: 'center', color: 'var(--t3)', padding: '30px 0', fontFamily: "'Rajdhani', sans-serif" }}>No players yet</div>
                  : <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
                    {t.squad.map((p) => (
                      <div key={String(p.id)} className="card" style={{ padding: '12px 14px', border: `1px solid ${t.color}22`, background: 'var(--bg1)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 15, color: 'var(--t1)' }}>{p.name}</div>
                          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                            <RBadge role={p.role} />
                            <TBadge tier={p.tier} />
                          </div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 2 }}>{p.nat || '🌍'}</div>
                          <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 20, color: 'var(--g)' }}>₹{p.soldPrice}L</div>
                        </div>
                      </div>
                    ))}
                  </div>
                }
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ANALYTICS TAB ── */}
      {tab === 'analytics' && (
        <div style={{ padding: 22, maxWidth: 1000, margin: '0 auto', width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <div>
              <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 34, letterSpacing: 2 }}>FINAL RESULTS</div>
              <div style={{ color: 'var(--t3)', fontSize: 12 }}>Download a team-wise list of players from this auction.</div>
            </div>
            <button className="btn bp" onClick={handleDownloadResults}>
              Download Results
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 18 }}>
            {[
              { l: 'Players Sold', v: roomState.soldLog.length, c: 'var(--g)' },
              { l: 'Unsold', v: roomState.unsoldLog.length, c: 'var(--re)' },
              { l: 'Total Spent', v: `₹${roomState.participants.reduce((a, b) => a + b.spent, 0)}L`, c: 'var(--or)' },
              { l: 'Avg Sale', v: roomState.soldLog.length ? `₹${Math.round(roomState.soldLog.reduce((a, b) => a + b.price, 0) / roomState.soldLog.length)}L` : '—', c: 'var(--bl)' },
            ].map((s) => (
              <div key={s.l} className="card" style={{ textAlign: 'center', padding: 13 }}>
                <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 9, color: 'var(--t3)', letterSpacing: 1, textTransform: 'uppercase', marginBottom: 3 }}>{s.l}</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: s.c, letterSpacing: 2 }}>{s.v}</div>
              </div>
            ))}
          </div>

          {/* Winner Banner */}
          {roomState.phase === 'done' && (() => {
            const ranked = [...roomState.participants].sort((a, b) => {
              if (b.squad.length !== a.squad.length) return b.squad.length - a.squad.length;
              return (b.budget - b.spent) - (a.budget - a.spent);
            });
            const winner = ranked[0];
            if (!winner) return null;
            return (
              <div className="card" style={{
                padding: 24,
                marginBottom: 18,
                textAlign: 'center',
                background: `linear-gradient(135deg, ${winner.color}15, ${winner.color}05)`,
                border: `2px solid ${winner.color}`,
                boxShadow: `0 0 30px ${winner.color}22`,
                animation: 'fadeUp 0.6s ease'
              }}>
                <div style={{ fontSize: 40, marginBottom: 6 }}>🏆</div>
                <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 4 }}>Auction Winner</div>
                <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 48, color: winner.color, letterSpacing: 3, lineHeight: 1.1 }}>{winner.name}</div>
                <div style={{ display: 'flex', justifyContent: 'center', gap: 24, marginTop: 14 }}>
                  <div>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--t3)' }}>Players</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: 'var(--bl)' }}>{winner.squad.length}</div>
                  </div>
                  <div>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--t3)' }}>Spent</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: 'var(--or)' }}>₹{winner.spent}L</div>
                  </div>
                  <div>
                    <div style={{ fontFamily: "'Rajdhani', sans-serif", fontSize: 10, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--t3)' }}>Budget Left</div>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 28, color: 'var(--g)' }}>₹{winner.budget - winner.spent}L</div>
                  </div>
                </div>
                {ranked.length > 1 && (
                  <div style={{ marginTop: 16, display: 'flex', justifyContent: 'center', gap: 16 }}>
                    {ranked.slice(1, 4).map((t, i) => (
                      <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)' }}>
                        <span style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 18, color: 'var(--t3)' }}>{i === 0 ? '🥈' : i === 1 ? '🥉' : `#${i + 2}`}</span>
                        <Avatar name={t.name} size={22} color={t.color} photo={t.photo} />
                        <span style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, color: t.color }}>{t.name}</span>
                        <span style={{ color: 'var(--t3)' }}>({t.squad.length} players)</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Budget Spending</div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--t3)', marginBottom: 10 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: 'var(--g)', borderRadius: 2, display: 'inline-block' }} /> Spent</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 10, height: 10, background: 'var(--bd2)', borderRadius: 2, display: 'inline-block' }} /> Remaining</span>
              </div>
              <BarChart data={roomState.participants.map((p) => ({ name: p.name, spent: p.spent, remaining: p.budget - p.spent }))} />
            </div>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 15, marginBottom: 10 }}>Spend Distribution</div>
              <DonutChart data={roomState.participants.filter((p) => p.spent > 0).map((p) => ({ name: p.name, value: p.spent, color: p.color }))} />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                {roomState.participants.filter((p) => p.spent > 0).map((p) => (
                  <span key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--t2)' }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, display: 'inline-block' }} />
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 18 }}>
            <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 15, marginBottom: 12 }}>💰 Top 5 Most Expensive</div>
            {(() => {
              const sorted = [...roomState.soldLog].sort((a, b) => b.price - a.price).slice(0, 5);
              if (sorted.length === 0) return <div style={{ color: 'var(--t3)', textAlign: 'center', padding: 18, fontSize: 13 }}>No players sold yet</div>;
              return sorted.map((s, i) => {
                const b = roomState.participants.find((p) => p.id === s.buyer);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '9px 0', borderBottom: i < sorted.length - 1 ? '1px solid var(--bd)' : 'none' }}>
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, color: 'var(--t3)', width: 24, textAlign: 'center' }}>{i + 1}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontFamily: "'Rajdhani', sans-serif", fontWeight: 700, fontSize: 14 }}>{s.player.name}</div>
                      {b && <div style={{ fontSize: 11, color: b.color, fontFamily: "'Rajdhani', sans-serif" }}>→ {b.name}</div>}
                    </div>
                    <RBadge role={s.player.role} />
                    <div style={{ fontFamily: "'Bebas Neue', sans-serif", fontSize: 22, color: 'var(--g)', letterSpacing: 1 }}>₹{s.price}L</div>
                  </div>
                );
              });
            })()}
          </div>
        </div>
      )}

      {/* ── LAUNCH COUNTDOWN OVERLAY ── */}
      {launchOverlay !== null && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(5, 7, 14, 0.88)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          zIndex: 9999,
          color: '#fff',
          fontFamily: "'Bebas Neue', sans-serif"
        }}>
          <style dangerouslySetInnerHTML={{__html: `
            @keyframes launchNumber {
              0% { transform: scale(3.5); opacity: 0; filter: blur(12px); }
              25% { transform: scale(1); opacity: 1; filter: blur(0); }
              75% { transform: scale(1); opacity: 1; filter: blur(0); }
              100% { transform: scale(0.7); opacity: 0; filter: blur(8px); }
            }
            .launch-num {
              font-size: 160px;
              letter-spacing: 4px;
              color: var(--g);
              text-shadow: 0 0 50px rgba(0, 220, 114, 0.6);
              animation: launchNumber 0.9s cubic-bezier(0.16, 1, 0.3, 1) infinite;
            }
            .launch-num-go {
              font-size: 160px;
              letter-spacing: 4px;
              color: var(--am);
              text-shadow: 0 0 50px rgba(245, 158, 11, 0.6);
              animation: launchNumber 0.9s cubic-bezier(0.16, 1, 0.3, 1) infinite;
            }
          `}} />
          <div style={{ fontSize: 24, letterSpacing: 6, color: 'var(--t3)', textTransform: 'uppercase', marginBottom: 20, fontFamily: "'Rajdhani', sans-serif", fontWeight: 700 }}>
            Prepare to Bid
          </div>
          <div key={launchOverlay} className={launchOverlay === 'GO!' ? 'launch-num-go' : 'launch-num'}>
            {launchOverlay}
          </div>
          {roomState.players && roomState.players[roomState.playerIdx] && (
            <div style={{ fontSize: 16, letterSpacing: 2, color: 'var(--t3)', textTransform: 'uppercase', marginTop: 20, textAlign: 'center', fontFamily: "'Rajdhani', sans-serif", fontWeight: 600 }}>
              First Up: <b style={{ color: '#fff' }}>{roomState.players[roomState.playerIdx].name}</b> ({roomState.players[roomState.playerIdx].role})
            </div>
          )}
        </div>
      )}
    </div>
  );
}
