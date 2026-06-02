/* eslint-disable @typescript-eslint/no-explicit-any */
import { supabaseAdmin as supabase } from './supabase-admin';
import { Database } from './supabase-types';

export type RoomRow = Database['public']['Tables']['rooms']['Row'];
export type TeamRow = Database['public']['Tables']['teams']['Row'];
export type PlayerRow = Database['public']['Tables']['players']['Row'];
export type BidRow = Database['public']['Tables']['bids']['Row'];
export type ChatRow = Database['public']['Tables']['chat_messages']['Row'];

/**
 * Returns a specific room by ID.
 */
export async function getRoom(roomId: string) {
  const { data, error } = await (supabase as any)
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (error) {
    console.error('Error fetching room:', error);
    return null;
  }
  return data;
}

/**
 * Get all related data for an active room (teams, players, bids, chat)
 */
export async function getFullRoomState(roomId: string) {
  const [roomReq, teamsReq, playersReq, bidsReq, chatReq] = await Promise.all([
    // maybeSingle (not single): a missing room returns { data: null } instead of
    // erroring with "Cannot coerce the result to a single JSON object", so an
    // unknown/stale room code resolves to a clean 404 rather than a 500 loop.
    (supabase as any).from('rooms').select('*').eq('id', roomId).maybeSingle(),
    (supabase as any).from('teams').select('*').eq('room_id', roomId),
    (supabase as any).from('players').select('*').eq('room_id', roomId).order('id', { ascending: true }),
    (supabase as any).from('bids').select('*').eq('room_id', roomId).order('created_at', { ascending: true }),
    (supabase as any).from('chat_messages').select('*').eq('room_id', roomId).order('created_at', { ascending: true })
  ]);

  if (roomReq.error) throw roomReq.error;

  return {
    room: roomReq.data as RoomRow,
    teams: (teamsReq.data || []) as TeamRow[],
    players: (playersReq.data || []) as PlayerRow[],
    bids: (bidsReq.data || []) as BidRow[],
    chat: (chatReq.data || []) as ChatRow[]
  };
}

/**
 * Creates a new room along with its initial configuration.
 */
export async function createRoom(roomData: Database['public']['Tables']['rooms']['Insert']) {
  const { data, error } = await (supabase as any)
    .from('rooms')
    .insert(roomData)
    .select()
    .single();

  if (error) {
    console.error('Error creating room:', error);
    throw error;
  }
  return data;
}

/**
 * Updates a room state (e.g., ticking the clock, changing phases, etc.)
 */
export async function updateRoom(roomId: string, updates: Database['public']['Tables']['rooms']['Update']) {
  const { data, error } = await (supabase as any)
    .from('rooms')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', roomId)
    .select()
    .single();

  if (error) {
    console.error('Error updating room:', error);
    throw error;
  }
  return data;
}

/**
 * Places a bid on a player and updates the room's current state in a transaction-like manner.
 * Note: For 100% ACID consistency on concurrent bids, an RPC function in Supabase is recommended.
 */
export async function placeBid(roomId: string, teamId: string, playerId: string, amount: number) {
  // 1. Record the bid
  const bidRes = await (supabase as any).from('bids').insert({
    room_id: roomId,
    team_id: teamId,
    player_id: playerId,
    amount
  });
  if (bidRes.error) throw bidRes.error;

  // 2. Update room current state
  const roomRes = await (supabase as any).from('rooms').update({
    current_bid: amount,
    current_bidder: teamId,
    ends_at: Date.now() + 15000 // Reset timer to 15s for example
  }).eq('id', roomId);
  if (roomRes.error) throw roomRes.error;

  return true;
}

/**
 * Mark a player as sold.
 */
export async function markPlayerSold(roomId: string, playerId: string, teamId: string, amount: number) {
  // 1. Update player status
  const playerRes = await (supabase as any).from('players').update({
    status: 'sold',
    sold_price: amount,
    team_id: teamId
  }).eq('id', playerId);
  if (playerRes.error) throw playerRes.error;

  // 2. Update team budget/spent
  const { data: teamData } = await (supabase as any).from('teams').select('spent').eq('id', teamId).single();
  const currentSpent = teamData?.spent || 0;
  
  await (supabase as any).from('teams').update({
    spent: currentSpent + amount
  }).eq('id', teamId);
  
  // 3. Move room to next player index & reset bid
  const { data: roomData } = await (supabase as any).from('rooms').select('player_idx').eq('id', roomId).single();
  const currentIdx = roomData?.player_idx || 0;
  
  await (supabase as any).from('rooms').update({
    current_bid: 0,
    current_bidder: null,
    player_idx: currentIdx + 1,
    ends_at: null,
    phase: 'scheduled' // or 'bidding' based on your logic
  }).eq('id', roomId);
  
  return true;
}
