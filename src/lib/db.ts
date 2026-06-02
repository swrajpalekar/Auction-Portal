/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { getFullRoomState } from './supabase-helpers';
import { ServerRoom } from './types';
export type { ServerRoom } from './types';
import { supabase } from './supabase';
import { createHash } from 'crypto';

// --- Local / File Database Configuration (Resilient Fallback) ---
const IS_VERCEL = !!process.env.VERCEL || process.env.NODE_ENV === 'production' || process.cwd().startsWith('/var/task');

// Fallback path in serverless (writable tmp) or local dev
const DB_FILE = IS_VERCEL
  ? path.join(os.tmpdir(), 'sports-auction-db.json')
  : path.join(process.cwd(), 'src', 'lib', 'db.json');

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

let writeQueue = Promise.resolve();

// Track Supabase health dynamically
let isSupabaseHealthy = true;

function checkSupabase(): boolean {
  return !!supabase && isSupabaseHealthy;
}

// MD5 based deterministic UUIDs for mapping
export function getDeterministicUuid(str: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str)) {
    return str;
  }
  const hash = createHash('md5').update(str).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(12, 15)}-8${hash.slice(15, 18)}-${hash.slice(18, 30)}`;
}

// Dynamically seed users table for relational references
export async function ensureUserExists(userId: string, name: string) {
  const dbUserId = getDeterministicUuid(userId);
  const { data } = await (supabase as any).from('users').select('id').eq('id', dbUserId).single();
  if (!data) {
    await (supabase!.from('users') as any).insert([{
      id: dbUserId,
      email: userId, // store original custom userId in email column
      name: name || 'Guest User'
    }]);
  }
  return dbUserId;
}

// Vercel KV Helper
async function kvFetch(command: any[]) {
  if (!KV_URL || !KV_TOKEN) return null;
  const url = KV_URL.endsWith('/') ? KV_URL.slice(0, -1) : KV_URL;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KV_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.result;
  } catch {
    return null;
  }
}

async function ensureDbFile() {
  try {
    await fs.access(DB_FILE);
  } catch {
    try {
      await fs.mkdir(path.dirname(DB_FILE), { recursive: true });
      await fs.writeFile(DB_FILE, JSON.stringify({}, null, 2), 'utf-8');
    } catch (err) {
      console.error('Failed to initialize local DB file:', err);
    }
  }
}

// Local File Read
async function localReadDb(): Promise<Record<string, ServerRoom>> {
  if (KV_URL && KV_TOKEN) {
    try {
      const result = await kvFetch(['GET', 'sports-auction:db']);
      if (result) return JSON.parse(result);
      return {};
    } catch {}
  }
  await ensureDbFile();
  try {
    const data = await fs.readFile(DB_FILE, 'utf-8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error reading local file database:', err);
    return {};
  }
}

// Local File Write
async function localWriteDb(data: Record<string, ServerRoom>): Promise<void> {
  if (KV_URL && KV_TOKEN) {
    try {
      await kvFetch(['SET', 'sports-auction:db', JSON.stringify(data)]);
      return;
    } catch {}
  }
  await ensureDbFile();
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error writing local file database:', err);
    }
  });
  return writeQueue;
}

// --- Public Unified DB Adapter APIs ---

/**
 * DEPRECATED: Reads all rooms. Provided for backward compatibility.
 */
export async function readDb(): Promise<Record<string, ServerRoom>> {
  if (checkSupabase()) {
    try {
      const { data: rooms } = await (supabase!.from('rooms') as any).select('id');
      if (!rooms) return {};
      
      const db: Record<string, ServerRoom> = {};
      for (const r of rooms as any[]) {
        const room = await getRoom(r.id);
        if (room) db[r.id] = room;
      }
      return db;
    } catch (e) {
      console.warn('⚠️ Supabase readDb failed, falling back to local file DB:', e);
      isSupabaseHealthy = false;
    }
  }

  return localReadDb();
}

/**
 * DEPRECATED: Write entire DB object.
 */
export async function writeDb(data: Record<string, ServerRoom>): Promise<void> {
  console.warn('writeDb is deprecated. Use saveRoom instead.');
  await localWriteDb(data);
}

/**
 * Fetches a room from active database (Supabase with dynamic fallback to local file)
 */
export async function getRoom(roomId: string): Promise<ServerRoom | null> {
  if (checkSupabase()) {
    try {
      const dbRoomId = getDeterministicUuid(roomId);
      const { room, teams, players, bids, chat } = await getFullRoomState(dbRoomId);
      if (!room) return null;

      // Extract original short code from tournament
      const match = room.tournament.match(/^\[(AUC-\d+)\](.*)$/);
      const originalId = match ? match[1] : roomId;
      const originalTournament = match ? match[2] : room.tournament;

      // Map database UUIDs of teams back to original IDs ('you', 't0', etc.)
      const getOriginalTeamId = (dbTeamId: string) => {
        if (dbTeamId === getDeterministicUuid(`${originalId}-you`)) return 'you';
        for (let i = 0; i < 20; i++) {
          const tid = `t${i}`;
          if (dbTeamId === getDeterministicUuid(`${originalId}-${tid}`)) return tid;
        }
        return dbTeamId;
      };

      // Fetch user details for mapping back original user ID strings (from email column)
      const { data: dbUsers } = await (supabase!.from('users') as any).select('id, email, name');
      const userMap = new Map(dbUsers?.map((u: any) => [u.id, u.email || u.name]) || []);
      const userDisplayNameMap = new Map(dbUsers?.map((u: any) => [u.id, u.name]) || []);

      const mappedParticipants = teams.map(t => ({
        id: getOriginalTeamId(t.id),
        name: t.name,
        color: t.color,
        photo: t.photo || undefined,
        budget: t.budget,
        spent: t.spent,
        squad: players.filter(p => p.team_id === t.id).map(p => ({
          id: p.id,
          name: p.name,
          country: p.country,
          role: p.role,
          tier: p.tier,
          base: p.base_price,
          img: p.image || '',
          nat: p.nat || '',
          bio: p.bio || '',
          soldPrice: p.sold_price || undefined
        })),
        ownerId: t.owner_id ? (userMap.get(t.owner_id) || null) : null
      }));

      return {
        id: originalId,
        name: room.name,
        sport: room.sport,
        tournament: originalTournament,
        budget: room.budget,
        squadSize: room.squad_size,
        enableBots: room.enable_bots,
        phase: room.phase as any,
        playerIdx: room.player_idx,
        currentBid: room.current_bid,
        currentBidder: room.current_bidder ? getOriginalTeamId(room.current_bidder) : null,
        endsAt: room.ends_at,
        scheduledAt: room.scheduled_at,
        hostId: userMap.get(room.host_id) || room.host_id,
        createdAt: new Date(room.created_at).getTime(),
        updatedAt: new Date(room.updated_at).getTime(),
        participants: mappedParticipants,
        players: players.map(p => ({
          id: p.id,
          name: p.name,
          country: p.country,
          role: p.role,
          tier: p.tier,
          base: p.base_price,
          img: p.image || '',
          nat: p.nat || '',
          bio: p.bio || '',
          soldPrice: p.sold_price || undefined
        })),
        chat: chat.map(c => ({
          id: new Date(c.created_at).getTime(),
          user: c.user_id ? (userDisplayNameMap.get(c.user_id) || 'Guest') : 'System',
          msg: c.message
        })),
        bidHistory: bids.map(b => ({
          id: new Date(b.created_at).getTime(),
          bidder: getOriginalTeamId(b.team_id),
          amount: b.amount
        })),
        soldLog: players.filter(p => p.status === 'sold').map(p => ({
          player: {
            id: p.id,
            name: p.name,
            country: p.country,
            role: p.role,
            tier: p.tier,
            base: p.base_price,
            img: p.image || '',
            nat: p.nat || '',
            bio: p.bio || '',
            soldPrice: p.sold_price || undefined
          } as any,
          buyer: p.team_id ? getOriginalTeamId(p.team_id) : '',
          price: p.sold_price || 0
        })),
        unsoldLog: players.filter(p => p.status === 'unsold').map(p => ({
          id: p.id,
          name: p.name,
          country: p.country,
          role: p.role,
          tier: p.tier,
          base: p.base_price,
          img: p.image || '',
          nat: p.nat || '',
          bio: p.bio || '',
          soldPrice: p.sold_price || undefined
        })) as any,
      } as ServerRoom;
    } catch (e) {
      console.warn('⚠️ Supabase getRoom failed, falling back to local file DB:', e);
      isSupabaseHealthy = false;
    }
  }

  // Local File Database Fallback
  const db = await localReadDb();
  return db[roomId.toUpperCase()] || null;
}

/**
 * Saves a ServerRoom object (Supabase with dynamic fallback to local file)
 */
export async function saveRoom(room: ServerRoom): Promise<void> {
  if (checkSupabase()) {
    try {
      // 1. Ensure host exists in users table
      const dbHostId = await ensureUserExists(room.hostId || '00000000-0000-0000-0000-000000000000', 'Host');

      // 2. Upsert room
      const dbRoomId = getDeterministicUuid(room.id);
      const { error: roomErr } = await (supabase!.from('rooms') as any).upsert({
        id: dbRoomId,
        name: room.name,
        sport: room.sport,
        tournament: `[${room.id}]${room.tournament}`, // prefix to preserve original room.id
        budget: room.budget,
        squad_size: room.squadSize,
        enable_bots: room.enableBots,
        phase: room.phase,
        host_id: dbHostId,
        player_idx: room.playerIdx,
        current_bid: room.currentBid,
        current_bidder: room.currentBidder ? getDeterministicUuid(`${room.id}-${room.currentBidder}`) : null,
        ends_at: room.endsAt,
        scheduled_at: room.scheduledAt,
        updated_at: new Date().toISOString()
      });
      if (roomErr) throw roomErr;

      // 3. Ensure team owners exist and upsert teams
      if (room.participants && room.participants.length > 0) {
        const teamsData = [];
        for (const p of room.participants) {
          let dbOwnerId = null;
          if (p.ownerId) {
            dbOwnerId = await ensureUserExists(p.ownerId, p.name);
          }
          const dbTeamId = getDeterministicUuid(`${room.id}-${p.id}`);
          teamsData.push({
            id: dbTeamId,
            room_id: dbRoomId,
            owner_id: dbOwnerId,
            name: p.name,
            color: p.color,
            photo: p.photo || null,
            budget: p.budget,
            spent: p.spent
          });
        }
        const { error: teamsErr } = await (supabase!.from('teams') as any).upsert(teamsData);
        if (teamsErr) throw teamsErr;
      }

      // 4. Upsert players
      if (room.players && room.players.length > 0) {
        const playersData = room.players.map(p => {
          const buyerTeam = room.participants.find(t => t.squad.some(s => s.id === p.id));
          const dbTeamId = buyerTeam ? getDeterministicUuid(`${room.id}-${buyerTeam.id}`) : null;
          
          let status: 'unsold' | 'sold' | 'current' = 'unsold';
          if (dbTeamId) {
            status = 'sold';
          } else if (room.phase === 'bidding' && room.players[room.playerIdx]?.id === p.id) {
            status = 'current';
          }

          const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(p.id));
          const dbPlayerId = isUuid ? String(p.id) : getDeterministicUuid(`${room.id}-player-${p.id}`);

          return {
            id: dbPlayerId,
            room_id: dbRoomId,
            name: p.name,
            country: p.country,
            role: p.role,
            tier: p.tier,
            base_price: p.base,
            sold_price: p.soldPrice || null,
            status,
            team_id: dbTeamId,
            image: p.img || null,
            nat: p.nat || null,
            bio: p.bio || null
          };
        });
        const { error: playersErr } = await (supabase!.from('players') as any).upsert(playersData);
        if (playersErr) throw playersErr;
      }

      // 5. Ensure chat senders exist and upsert chat
      if (room.chat && room.chat.length > 0) {
        const chatData = [];
        for (const c of room.chat) {
          let dbSenderId = null;
          if (c.user && c.user !== 'System') {
            const userUuid = getDeterministicUuid(c.user);
            dbSenderId = await ensureUserExists(userUuid, c.user);
          }
          const msgId = getDeterministicUuid(`${room.id}-chat-${c.id}-${c.msg}`);
          chatData.push({
            id: msgId,
            room_id: dbRoomId,
            user_id: dbSenderId,
            message: c.msg,
            created_at: new Date(c.id).toISOString()
          });
        }
        const { error: chatErr } = await (supabase!.from('chat_messages') as any).upsert(chatData);
        if (chatErr) throw chatErr;
      }

      // 6. Upsert bids
      if (room.bidHistory && room.bidHistory.length > 0) {
        const bidsData = room.bidHistory.map(b => {
          const bidId = getDeterministicUuid(`${room.id}-bid-${b.id}-${b.bidder}-${b.amount}`);
          const dbTeamId = getDeterministicUuid(`${room.id}-${b.bidder}`);
          const activePlayer = room.players[room.playerIdx] || room.players[0];
          const dbPlayerId = getDeterministicUuid(`${room.id}-player-${activePlayer.id}`);
          return {
            id: bidId,
            room_id: dbRoomId,
            player_id: dbPlayerId,
            team_id: dbTeamId,
            amount: b.amount,
            created_at: new Date(b.id).toISOString()
          };
        });
        const { error: bidsErr } = await (supabase!.from('bids') as any).upsert(bidsData);
        if (bidsErr) throw bidsErr;
      }
      return;
    } catch (e) {
      console.warn('⚠️ Supabase saveRoom failed, falling back to local file DB:', e);
      isSupabaseHealthy = false;
    }
  }

  // Local File Database Fallback
  const db = await localReadDb();
  db[room.id.toUpperCase()] = {
    ...room,
    updatedAt: Date.now(),
  };
  await localWriteDb(db);
}

/**
 * Clean inactive rooms (Supabase with fallback to local file)
 */
export async function cleanInactiveRooms(): Promise<void> {
  if (checkSupabase()) {
    try {
      // Supabase handled via triggers/pg_cron in prod
      return;
    } catch (e) {
      console.warn('⚠️ Supabase cleanInactiveRooms failed, falling back to local file DB:', e);
      isSupabaseHealthy = false;
    }
  }

  const db = await localReadDb();
  const now = Date.now();
  const INACTIVITY_TIMEOUT = 30 * 24 * 60 * 60 * 1000; // 30 days
  let changed = false;

  for (const id of Object.keys(db)) {
    const room = db[id];
    if (room && room.updatedAt && now - room.updatedAt > INACTIVITY_TIMEOUT) {
      delete db[id];
      changed = true;
    }
  }

  if (changed) {
    await localWriteDb(db);
  }
}
