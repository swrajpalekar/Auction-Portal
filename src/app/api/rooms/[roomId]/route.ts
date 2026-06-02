/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { getRoom, saveRoom, cleanInactiveRooms, ServerRoom } from '@/lib/db';
import { Player } from '@/lib/types';

const BID_TIMER_MS = 30000; // base round timer (30s) and the hard cap after a bid
const BID_EXTENSION_MS = 20000; // a bid adds 20s, but never beyond BID_TIMER_MS from now

function updateRoomStatus(room: ServerRoom): boolean {
  let changed = false;
  if (!room.endsAt) return false;

  const now = Date.now();

  // 1. If bidding is active and timer has expired
  if (room.phase === 'bidding' && now >= room.endsAt) {
    if (room.currentBidder) {
      room.phase = 'sold';
      // Set transition timer for 3.2 seconds
      room.endsAt = now + 3200;
      room.chat.push({
        id: now,
        user: 'System',
        msg: `🔨 SOLD! ${room.players[room.playerIdx].name} sold to ${
          room.participants.find((p: any) => p.id === room.currentBidder)?.name
        } for ₹${room.currentBid}L!`,
      });
    } else {
      room.phase = 'unsold';
      room.endsAt = now + 3200;
      room.chat.push({
        id: now,
        user: 'System',
        msg: `🔨 UNSOLD! No bids for ${room.players[room.playerIdx].name}.`,
      });
    }
    changed = true;
  }

  // 2. If transition screen (sold/unsold) has completed, advance to NEXT player
  if ((room.phase === 'sold' || room.phase === 'unsold') && now >= room.endsAt) {
    const ni = room.playerIdx + 1;

    // Process budget changes and squad additions for the player who was just sold
    if (room.phase === 'sold' && room.currentBidder) {
      const bid = room.currentBid;
      const who = room.currentBidder;
      const soldPlayer: Player = { ...room.players[room.playerIdx], soldPrice: bid };

      room.participants = room.participants.map((p: any) =>
        p.id === who
          ? {
              ...p,
              spent: p.spent + bid,
              squad: [...p.squad, soldPlayer],
            }
          : p
      );
      room.soldLog.push({ player: room.players[room.playerIdx], buyer: who, price: bid });
    } else {
      room.unsoldLog.push(room.players[room.playerIdx]);
    }

    if (ni >= room.players.length) {
      room.phase = 'done';
      room.endsAt = null;
      room.chat.push({
        id: now,
        user: 'System',
        msg: `🎉 Auction complete! Thank you for participating.`,
      });
    } else {
      room.phase = 'bidding';
      room.playerIdx = ni;
      room.currentBid = room.players[ni].base;
      room.currentBidder = null;
      room.passedBy = [];
      room.endsAt = now + BID_TIMER_MS;
    }
    changed = true;
  }

  return changed;
}

function processBotBidding(room: ServerRoom): boolean {
  if (room.phase !== 'bidding' || !room.enableBots || !room.endsAt) return false;

  const now = Date.now();
  const timeLeft = Math.max(0, Math.ceil((room.endsAt - now) / 1000));
  
  // Bots shouldn't bid at the very last moment to avoid network lag issues
  if (timeLeft < 3) return false;

  // Get last bid time. If no bids yet, use the room createdAt/updatedAt
  const lastBidTime = room.bidHistory.length > 0 ? room.bidHistory[0].id : (room.updatedAt || now);
  const secSinceLastBid = (now - lastBidTime) / 1000;

  // Wait a random duration of 3.5 to 8.5 seconds between bids
  if (secSinceLastBid < 3.5 + Math.random() * 5.0) return false;

  // Filter CPU participants (where ownerId is null) who are NOT already the high bidder
  const cpuTeams = room.participants.filter(
    (p: any) => p.ownerId === null && p.id !== room.currentBidder
  );
  if (cpuTeams.length === 0) return false;

  // Choose a random bot
  const botTeam = cpuTeams[Math.floor(Math.random() * cpuTeams.length)];
  const activePlayer = room.players[room.playerIdx];

  // Random bot valuation cap (between 1.4x and 2.8x of base price)
  const seedMultiplier = 1.4 + ((botTeam.name.charCodeAt(0) + botTeam.name.charCodeAt(1)) % 10) * 0.15;
  const maxW = activePlayer.base * (seedMultiplier + Math.random() * 0.5);

  const increment = [10, 25, 50][Math.floor(Math.random() * 3)];
  const nextBidAmount = room.currentBid + increment;

  if (nextBidAmount <= maxW && nextBidAmount <= (botTeam.budget - botTeam.spent)) {
    room.currentBid = nextBidAmount;
    room.currentBidder = botTeam.id;
    room.endsAt = Math.min(room.endsAt + BID_EXTENSION_MS, now + BID_TIMER_MS);

    room.bidHistory.unshift({
      id: now,
      bidder: botTeam.id,
      amount: nextBidAmount,
    });
    room.bidHistory = room.bidHistory.slice(0, 30);

    // No chat push for bot bids as requested

    return true;
  }

  return false;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const room = await getRoom(roomId);
    if (!room) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }

    let modified = false;

    // Heartbeat update for room activity: update updatedAt every 15s to keep it active
    if (!room.updatedAt || Date.now() - room.updatedAt > 15000) {
      room.updatedAt = Date.now();
      modified = true;
    }

    // Clean up inactive rooms periodically (10% chance per poll check)
    if (Math.random() < 0.1) {
      await cleanInactiveRooms();
    }

    // Auto-start scheduled rooms when their time arrives and all teams have joined
    const totalTeams = room.participants.length;
    const joinedTeams = room.participants.filter((p: any) => p.ownerId !== null).length;
    const allTeamsJoined = room.enableBots ? (joinedTeams >= 1) : (joinedTeams === totalTeams);

    if (room.phase === 'scheduled' && allTeamsJoined && room.scheduledAt && Date.now() >= room.scheduledAt) {
      room.phase = 'bidding';
      room.playerIdx = 0;
      room.currentBid = room.players[0]?.base || 50;
      room.currentBidder = null;
      room.passedBy = [];
      room.endsAt = Date.now() + BID_TIMER_MS;
      modified = true;
    }

    // Check if we need to auto-advance timer or resolve player
    if (updateRoomStatus(room)) {
      modified = true;
    }

    // Process bot bidding if enabled
    if (processBotBidding(room)) {
      modified = true;
    }

    if (modified) {
      await saveRoom(room);
    }

    // Calculate time left to return to client
    const timeLeft = room.endsAt ? Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000)) : 60;

    return NextResponse.json({
      room: {
        ...room,
        timeLeft,
      },
    });
  } catch (error: any) {
    console.error('Error fetching room state:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ roomId: string }> }
) {
  try {
    const { roomId } = await params;
    const body = await req.json();
    const { userId, userName, teamName, teamPhoto } = body;

    if (!userId || !teamName?.trim()) {
      return NextResponse.json({ error: 'userId and teamName are required' }, { status: 400 });
    }

    const room = await getRoom(roomId);
    if (!room) {
      return NextResponse.json({ error: 'Room not found' }, { status: 404 });
    }

    const existingTeam = room.participants.find((participant: any) => participant.ownerId === userId);
    const team = existingTeam || room.participants.find((participant: any) => participant.ownerId === null);
    if (!team) {
      return NextResponse.json({ error: 'No team slots are available in this room' }, { status: 400 });
    }

    team.ownerId = userId;
    team.name = teamName.trim();
    if (typeof teamPhoto === 'string' && teamPhoto.trim()) {
      team.photo = teamPhoto;
    }

    room.chat.push({
      id: Date.now(),
      user: 'System',
      msg: `👤 ${userName || 'A user'} joined as "${team.name}"`,
    });

    await saveRoom(room);

    return NextResponse.json({ room, teamId: team.id });
  } catch (error: any) {
    console.error('Error joining room:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
