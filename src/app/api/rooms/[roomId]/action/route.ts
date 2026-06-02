/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { getRoom, saveRoom } from '@/lib/db';

const BID_TIMER_MS = 30000; // base round timer (30s) and the hard cap after a bid
const BID_EXTENSION_MS = 20000; // a bid adds 20s, but never beyond BID_TIMER_MS from now

export async function POST(
  req: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const body = await req.json();
    const { action, userId } = body;

    if (!action || !action.type) {
      return NextResponse.json({ error: 'Action type is required' }, { status: 400 });
    }

    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const room = await getRoom(roomId);
    if (!room) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }

    const now = Date.now();

    switch (action.type) {
      // ─────────────────────────────────────────────────────────────────
      // START: Phase transition — full saveRoom is appropriate here
      // ─────────────────────────────────────────────────────────────────
      case 'START': {
        if (room.hostId !== userId) {
          return NextResponse.json({ error: 'Only the host can start the auction' }, { status: 403 });
        }
        if (room.phase !== 'lobby' && room.phase !== 'scheduled') {
          return NextResponse.json({ error: 'Auction has already started' }, { status: 400 });
        }

        room.phase = 'bidding';
        room.playerIdx = 0;
        room.currentBid = room.players[0].base;
        room.currentBidder = null;
        room.passedBy = [];
        room.endsAt = now + BID_TIMER_MS;

        await saveRoom(room);
        break;
      }

      // ─────────────────────────────────────────────────────────────────
      // BID: Use safe saveRoom pattern to avoid DB mapping issues
      // ─────────────────────────────────────────────────────────────────
      case 'BID': {
        const { bidder, amount } = action;

        if (room.phase !== 'bidding') {
          return NextResponse.json({ error: 'Bidding is not active' }, { status: 400 });
        }

        // Validate bidder exists as a participant
        const team = room.participants.find((p: any) => p.id === bidder);
        if (!team) {
          return NextResponse.json({ error: 'Team not found' }, { status: 404 });
        }

        // Validate ownership
        if (team.ownerId !== userId) {
          return NextResponse.json({ error: 'You do not own this team' }, { status: 403 });
        }

        if (bidder === room.currentBidder) {
          return NextResponse.json({ error: 'You are already the highest bidder' }, { status: 400 });
        }

        if (room.passedBy?.includes(bidder)) {
          return NextResponse.json({ error: 'You passed on this player and can no longer bid' }, { status: 400 });
        }

        const nextBidVal = room.currentBid + amount;

        if (team.spent + nextBidVal > team.budget) {
          return NextResponse.json({ error: 'Insufficient budget' }, { status: 400 });
        }

        // Calculate new timer (extend but cap at BID_TIMER_MS from now)
        const newEndsAt = Math.min((room.endsAt || now) + BID_EXTENSION_MS, now + BID_TIMER_MS);

        // Mutate room state safely in memory
        room.currentBid = nextBidVal;
        room.currentBidder = bidder;
        room.endsAt = newEndsAt;
        room.bidHistory.unshift({ id: now, bidder, amount: nextBidVal });
        room.bidHistory = room.bidHistory.slice(0, 30);

        // Save the entire room back to database
        await saveRoom(room);

        const timeLeft = room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : 60;
        return NextResponse.json({ room: { ...room, timeLeft } });
      }

      // ─────────────────────────────────────────────────────────────────
      // SKIP: Host force-moves past the current player at any time.
      // Marks the player unsold with a short transition, then the GET
      // route's updateRoomStatus advances the queue. Any standing bid is
      // discarded (the player goes unsold, not sold).
      // ─────────────────────────────────────────────────────────────────
      case 'SKIP': {
        if (room.hostId !== userId) {
          return NextResponse.json({ error: 'Only the host can skip a player' }, { status: 403 });
        }
        if (room.phase !== 'bidding') {
          return NextResponse.json({ error: 'Can only skip during active bidding' }, { status: 400 });
        }

        const skipped = room.players[room.playerIdx];
        const hadBid = !!room.currentBidder;
        room.phase = 'unsold';
        room.currentBidder = null;
        room.endsAt = now + 1500; // brief "UNSOLD" flash, then the queue auto-advances
        room.chat.push({
          id: now,
          user: 'System',
          msg: hadBid
            ? `⏭️ Host skipped ${skipped?.name ?? 'the player'} — standing bid discarded.`
            : `⏭️ Host skipped ${skipped?.name ?? 'the player'} — no bids.`,
        });
        room.chat = room.chat.slice(-60);

        await saveRoom(room);

        const timeLeft = room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : 0;
        return NextResponse.json({ room: { ...room, timeLeft } });
      }

      // ─────────────────────────────────────────────────────────────────
      // PASS: A participant opts out of bidding on the CURRENT player.
      // They can't bid again until the next player. Purely per-player;
      // reset whenever the auction advances.
      // ─────────────────────────────────────────────────────────────────
      case 'PASS': {
        const { bidder } = action;

        if (room.phase !== 'bidding') {
          return NextResponse.json({ error: 'Bidding is not active' }, { status: 400 });
        }

        const team = room.participants.find((p: any) => p.id === bidder);
        if (!team) {
          return NextResponse.json({ error: 'Team not found' }, { status: 404 });
        }
        if (team.ownerId !== userId) {
          return NextResponse.json({ error: 'You do not own this team' }, { status: 403 });
        }
        if (bidder === room.currentBidder) {
          return NextResponse.json({ error: "You're the highest bidder — you can't pass" }, { status: 400 });
        }

        if (!room.passedBy) room.passedBy = [];
        if (!room.passedBy.includes(bidder)) {
          room.passedBy.push(bidder);
          room.chat.push({
            id: now,
            user: 'System',
            msg: `🙅 ${team.name} passed on ${room.players[room.playerIdx]?.name ?? 'this player'}.`,
          });
          room.chat = room.chat.slice(-60);
          await saveRoom(room);
        }

        const timeLeft = room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : 60;
        return NextResponse.json({ room: { ...room, timeLeft } });
      }

      // ─────────────────────────────────────────────────────────────────
      // CHAT: Direct insert — no blob saveRoom needed
      // ─────────────────────────────────────────────────────────────────
      case 'CHAT': {
        const { msg, user } = action;
        if (!msg || !msg.trim()) {
          return NextResponse.json({ error: 'Message cannot be empty' }, { status: 400 });
        }

        // Use the saveRoom pattern for chat to ensure user mapping is handled correctly by db.ts
        room.chat.push({ id: now, user: user || 'Guest', msg: msg.trim() });
        room.chat = room.chat.slice(-60);
        await saveRoom(room);
        
        const timeLeft = room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : 60;
        return NextResponse.json({ room: { ...room, timeLeft } });
      }

      default:
        return NextResponse.json({ error: `Unsupported action type: ${action.type}` }, { status: 400 });
    }

    // For START action (falls through from switch without early return)
    const freshRoom = await getRoom(roomId);
    if (!freshRoom) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }
    const timeLeft = freshRoom.endsAt
      ? Math.max(0, Math.ceil((freshRoom.endsAt - Date.now()) / 1000))
      : 60;

    return NextResponse.json({ room: { ...freshRoom, timeLeft } });
  } catch (error: any) {
    console.error('Error handling action:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
