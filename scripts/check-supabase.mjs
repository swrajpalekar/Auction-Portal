// One-off Supabase live-schema inspector.
// Reads .env directly, never prints secrets. Compares the live DB (via PostgREST
// OpenAPI spec) against the tables/columns expected by supabase_schema.sql.

import { readFileSync } from 'node:fs';

// --- load .env (simple parser, no deps) ---
const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].trim();
}

const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const key = serviceKey || anonKey;
if (!key) { console.error('No key found in .env'); process.exit(1); }

// --- derive project ref from the JWT (source of truth) ---
function jwtRef(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString('utf8'));
    return payload.ref;
  } catch { return null; }
}
const refFromKey = serviceKey ? jwtRef(serviceKey) : null;

// --- figure out the correct base URL ---
let url = env.NEXT_PUBLIC_SUPABASE_URL || '';
const urlHost = url.replace(/^https?:\/\//, '').split('.')[0];
let baseUrl = url.replace(/\/+$/, '');
const notes = [];

if (refFromKey) {
  const correct = `https://${refFromKey}.supabase.co`;
  if (baseUrl !== correct) {
    notes.push(`URL in .env is "${url}" but the key's project ref is "${refFromKey}" → correct URL is ${correct}`);
    baseUrl = correct;
  }
  if (urlHost && urlHost !== refFromKey) {
    notes.push(`Host in .env ("${urlHost}") does not match key ref ("${refFromKey}") — possible typo.`);
  }
} else if (/\.supabase\.com$/.test(url)) {
  baseUrl = url.replace(/\.supabase\.com/, '.supabase.co');
  notes.push(`URL ended in .supabase.com — corrected to .supabase.co`);
}

console.log('Project ref (from key):', refFromKey || '(anon key — ref not shown)');
console.log('Using base URL       :', baseUrl);
console.log('Using key            :', serviceKey ? 'service_role' : 'anon');
if (notes.length) { console.log('\n⚠️  URL notes:'); notes.forEach(n => console.log('  - ' + n)); }

// --- expected schema (from supabase_schema.sql) ---
const expected = {
  users: ['id','email','name','avatar_url','created_at'],
  rooms: ['id','name','sport','tournament','budget','squad_size','enable_bots','phase','host_id','player_idx','current_bid','current_bidder','ends_at','scheduled_at','passed_by','created_at','updated_at'],
  teams: ['id','room_id','owner_id','name','color','photo','budget','spent','created_at'],
  players: ['id','room_id','name','country','role','tier','base_price','sold_price','status','team_id','image','nat','bio','created_at'],
  bids: ['id','room_id','player_id','team_id','amount','created_at'],
  chat_messages: ['id','room_id','user_id','message','created_at'],
};

// --- fetch the PostgREST OpenAPI spec (lists all exposed tables + columns) ---
const headers = { apikey: key, Authorization: `Bearer ${key}` };

async function main() {
  console.log('\nConnecting to', baseUrl + '/rest/v1/ ...');
  let res;
  try {
    res = await fetch(baseUrl + '/rest/v1/', { headers });
  } catch (e) {
    console.error('\n❌ Could not reach the project:', e.message);
    console.error('   Double-check the URL/ref and that the project is active.');
    process.exit(2);
  }
  console.log('HTTP status:', res.status, res.statusText);
  if (!res.ok) {
    const body = await res.text();
    console.error('\n❌ Request failed. Body:\n', body.slice(0, 500));
    process.exit(2);
  }
  const spec = await res.json();
  const liveTables = spec.definitions ? Object.keys(spec.definitions) : Object.keys(spec.components?.schemas || {});

  console.log('\n=== TABLE CHECK ===');
  const missingTables = [];
  for (const t of Object.keys(expected)) {
    const present = liveTables.includes(t);
    console.log(`${present ? '✅' : '❌'} ${t}${present ? '' : '  (MISSING)'}`);
    if (!present) missingTables.push(t);
  }
  const extra = liveTables.filter(t => !Object.keys(expected).includes(t));
  if (extra.length) console.log('\nℹ️  Extra tables in live DB not in schema file:', extra.join(', '));

  console.log('\n=== COLUMN CHECK ===');
  const defs = spec.definitions || spec.components?.schemas || {};
  for (const [t, cols] of Object.entries(expected)) {
    if (missingTables.includes(t)) continue;
    const liveCols = Object.keys(defs[t]?.properties || {});
    const missingCols = cols.filter(c => !liveCols.includes(c));
    const extraCols = liveCols.filter(c => !cols.includes(c));
    if (!missingCols.length && !extraCols.length) {
      console.log(`✅ ${t}: all ${cols.length} columns match`);
    } else {
      console.log(`⚠️  ${t}:`);
      if (missingCols.length) console.log(`     missing in live DB: ${missingCols.join(', ')}`);
      if (extraCols.length) console.log(`     extra in live DB   : ${extraCols.join(', ')}`);
    }
  }

  console.log('\n=== RPC CHECK ===');
  // place_auction_bid is defined in the SQL but unused by current code
  const rpcRes = await fetch(baseUrl + '/rest/v1/rpc/place_auction_bid', {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (rpcRes.status === 404) console.log('❌ place_auction_bid RPC: NOT deployed (404)');
  else console.log(`✅ place_auction_bid RPC: exists (responded ${rpcRes.status})`);

  console.log('\nDone.');
}
main().catch(e => { console.error(e); process.exit(1); });
