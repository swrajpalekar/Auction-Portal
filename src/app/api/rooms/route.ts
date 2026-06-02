/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

import { readDb, saveRoom, ServerRoom, getDeterministicUuid } from '@/lib/db';

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      roomId: clientRoomId,
      name,
      sport,
      tournament,
      participants,
      budget,
      squadSize,
      enableBots,
      teams,
      players,
      hostId,
      scheduledAt,
    } = body;

    if (!hostId) {
      return NextResponse.json({ error: 'hostId is required' }, { status: 400 });
    }

    if (!teams || !Array.isArray(teams) || teams.length === 0) {
      return NextResponse.json({ error: 'teams are required' }, { status: 400 });
    }

    if (!players || !Array.isArray(players) || players.length === 0) {
      return NextResponse.json({ error: 'players are required' }, { status: 400 });
    }

    const db = await readDb();

    // Generate unique room ID
    let roomId = '';
    if (clientRoomId && !db[clientRoomId]) {
      roomId = clientRoomId;
    } else {
      let attempts = 0;
      while (attempts < 20) {
        const code = Math.floor(1000 + Math.random() * 9000);
        const testId = `AUC-${code}`;
        if (!db[testId]) {
          roomId = testId;
          break;
        }
        attempts++;
      }

      if (!roomId) {
        roomId = `AUC-${Date.now().toString().slice(-4)}`;
      }
    }

    const initializedParticipants = teams.slice(0, participants).map((t, idx) => {
      // The creator (host) automatically gets assigned the 'you' team (or first team)
      const isHostTeam = t.id === 'you' || idx === 0;
      return {
        ...t,
        budget: budget || 1000,
        spent: 0,
        squad: [],
        ownerId: isHostTeam ? hostId : null,
      };
    });

    const isScheduled = scheduledAt && scheduledAt > Date.now();
    const scheduledDate = isScheduled ? new Date(scheduledAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : null;

    const mappedPlayers = players.map((p, idx) => ({
      ...p,
      id: getDeterministicUuid(`${roomId}-player-${p.id || idx}`)
    }));

    const newRoom: ServerRoom = {
      id: roomId,
      name: name || 'Sports Auction',
      sport: sport || 'Custom',
      tournament: tournament || 'Custom',
      budget: budget || 1000,
      squadSize: squadSize || 11,
      enableBots: enableBots ?? true,
      phase: isScheduled ? 'scheduled' : 'lobby',
      playerIdx: 0,
      currentBid: mappedPlayers[0]?.base || 50,
      currentBidder: null,
      endsAt: null,
      bidHistory: [],
      chat: [
        {
          id: Date.now(),
          user: 'System',
          msg: isScheduled
            ? `🕐 Auction scheduled for ${scheduledDate}. Room ${roomId} created.`
            : `Room ${roomId} created by host. Welcome!`,
        },
      ],
      participants: initializedParticipants,
      soldLog: [],
      unsoldLog: [],
      players: mappedPlayers,
      hostId,
      scheduledAt: isScheduled ? scheduledAt : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveRoom(newRoom);

    return NextResponse.json({ room: newRoom });
  } catch (error: any) {
    console.error('Error creating room:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get('userId');
    if (!userId) {
      return NextResponse.json({ error: 'userId is required' }, { status: 400 });
    }

    const db = await readDb();
    const userRooms = Object.values(db).filter((room: ServerRoom) => {
      return room.participants.some(p => p.ownerId === userId);
    });

    const history = userRooms.map((r: ServerRoom) => ({
      id: r.id,
      name: r.name,
      sport: r.sport,
      phase: r.phase,
      updatedAt: r.updatedAt || Date.now(),
    })).sort((a, b) => b.updatedAt - a.updatedAt);

    return NextResponse.json({ history });
  } catch (error: any) {
    console.error('Error fetching room history:', error);
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
