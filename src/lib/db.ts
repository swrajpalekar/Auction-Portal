import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { Player, Participant } from './types';

export interface ServerRoom {
  id: string;
  name: string;
  sport: string;
  tournament: string;
  budget: number;
  squadSize: number;
  enableBots: boolean;
  phase: 'scheduled' | 'lobby' | 'bidding' | 'sold' | 'unsold' | 'done';
  playerIdx: number;
  currentBid: number;
  currentBidder: string | null;
  endsAt: number | null; // timestamp in ms
  bidHistory: any[];
  chat: any[];
  participants: Array<
    Participant & {
      ownerId: string | null; // User ID controlling this team, or null if CPU
    }
  >;
  soldLog: any[];
  unsoldLog: any[];
  players: Player[];
  hostId: string;
  scheduledAt: number | null; // timestamp in ms — when to auto-launch
  createdAt: number;
  updatedAt: number;
}

// Determine if we are running in a Vercel serverless environment
const IS_VERCEL = !!process.env.VERCEL || process.env.NODE_ENV === 'production' || process.cwd().startsWith('/var/task');

// In serverless environments, the local filesystem is read-only.
// We fall back to os.tmpdir() (which resolves to /tmp on Vercel) which is writable.
const DB_FILE = IS_VERCEL
  ? path.join(os.tmpdir(), 'sports-auction-db.json')
  : path.join(process.cwd(), 'src', 'lib', 'db.json');

// Vercel KV environment variables (set automatically when KV is connected via the Vercel Dashboard)
const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

// Memory queue to prevent race conditions in local file-based DB
let writeQueue = Promise.resolve();

// Standard helper to call Vercel KV (Redis) REST API directly with fetch (no external packages required!)
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
      // Add a 5 second request timeout
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error(`Vercel KV Error: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error('Vercel KV fetch failed:', err);
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

export async function readDb(): Promise<Record<string, ServerRoom>> {
  // 1. Try Vercel KV if configured (Production persistent database)
  if (KV_URL && KV_TOKEN) {
    try {
      const result = await kvFetch(['GET', 'sports-auction:db']);
      if (result) {
        return JSON.parse(result);
      }
      return {};
    } catch (err) {
      console.error('Error reading from Vercel KV:', err);
    }
  }

  // 2. Fallback to local file or /tmp/db.json
  await ensureDbFile();
  try {
    const data = await fs.readFile(DB_FILE, 'utf-8');
    return JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error reading DB:', err);
    return {};
  }
}

export async function writeDb(data: Record<string, ServerRoom>): Promise<void> {
  // 1. Try Vercel KV if configured (Production persistent database)
  if (KV_URL && KV_TOKEN) {
    try {
      await kvFetch(['SET', 'sports-auction:db', JSON.stringify(data)]);
      return;
    } catch (err) {
      console.error('Error writing to Vercel KV:', err);
    }
  }

  // 2. Fallback to local file or /tmp/db.json
  await ensureDbFile();
  writeQueue = writeQueue.then(async () => {
    try {
      await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
      console.error('Error writing DB:', err);
    }
  });
  return writeQueue;
}

export async function getRoom(roomId: string): Promise<ServerRoom | null> {
  const db = await readDb();
  return db[roomId.toUpperCase()] || null;
}

export async function saveRoom(room: ServerRoom): Promise<void> {
  const db = await readDb();
  db[room.id.toUpperCase()] = {
    ...room,
    updatedAt: Date.now(),
  };
  await writeDb(db);
}

export async function cleanInactiveRooms(): Promise<void> {
  const db = await readDb();
  const now = Date.now();
  const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes
  let changed = false;

  for (const id of Object.keys(db)) {
    const room = db[id];
    if (room && room.updatedAt && now - room.updatedAt > INACTIVITY_TIMEOUT) {
      delete db[id];
      changed = true;
    }
  }

  if (changed) {
    await writeDb(db);
  }
}

// vercel ready 
