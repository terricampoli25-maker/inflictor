// The Inflictor — Cloudflare Pages Function  (Stages 1–4)

// ─── Crypto helpers ───────────────────────────────────────────────────────────

const toHex = (arr) => Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const newId    = () => randomHex(16);
const newToken = () => randomHex(32);

async function hashPassword(password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return `${toHex(salt)}:${toHex(new Uint8Array(bits))}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, storedHash] = stored.split(':');
  if (!saltHex || !storedHash || saltHex.length !== 32 || storedHash.length !== 64) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return toHex(new Uint8Array(bits)) === storedHash;
}

async function verifyStripeSignature(payload, header, secret) {
  try {
    const enc   = new TextEncoder();
    const parts = header.split(',');
    const t     = parts.find(p => p.startsWith('t='))?.slice(2);
    const sig   = parts.find(p => p.startsWith('v1='))?.slice(3);
    if (!t || !sig) return false;
    const key  = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac  = await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`));
    return toHex(new Uint8Array(mac)) === sig;
  } catch { return false; }
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

// ─── Session ──────────────────────────────────────────────────────────────────

async function getSession(request, db) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return null;
  return db.prepare(`
    SELECT s.token, u.id AS user_id, u.username, u.email,
           u.is_guest, u.premium_status, u.premium_expires_at,
           u.stripe_customer_id, u.stripe_subscription_id
    FROM sessions s JOIN users u ON s.user_id = u.id
    WHERE s.token = ? AND s.expires_at > datetime('now')
  `).bind(auth.slice(7)).first();
}

// ─── /api/auth/* ──────────────────────────────────────────────────────────────

async function handleAuth(segments, request, env) {
  const db = env.DB, action = segments[1];

  if (action === 'register' && request.method === 'POST') {
    const { username = '', password = '', email = '' } = await request.json().catch(() => ({}));
    if (!username || !password)                  return json({ error: 'Username and password required' }, 400);
    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) return json({ error: 'Username must be 3–30 chars (letters, numbers, _)' }, 400);
    if (password.length < 8)                     return json({ error: 'Password must be at least 8 characters' }, 400);
    if (await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first()) return json({ error: 'That name is already taken' }, 409);
    if (email && await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()) return json({ error: 'That email is already registered' }, 409);
    const id = newId(), hash = await hashPassword(password), token = newToken(), sid = newId();
    const exp = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await db.prepare('INSERT INTO users (id,username,email,password_hash) VALUES (?,?,?,?)').bind(id, username, email||null, hash).run();
    await db.prepare('INSERT INTO settings (user_id) VALUES (?)').bind(id).run();
    await db.prepare('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,?)').bind(sid, id, token, exp).run();
    return json({ token, user: { id, username, email: email||null, is_guest: false, premium_status: 'free' } }, 201);
  }

  if (action === 'login' && request.method === 'POST') {
    const { username = '', password = '' } = await request.json().catch(() => ({}));
    const user = await db.prepare('SELECT * FROM users WHERE username = ? AND is_guest = 0').bind(username).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) return json({ error: 'Invalid name or password' }, 401);
    const token = newToken(), sid = newId(), exp = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await db.prepare('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,?)').bind(sid, user.id, token, exp).run();
    return json({ token, user: { id: user.id, username: user.username, email: user.email, is_guest: false, premium_status: user.premium_status } });
  }

  if (action === 'guest' && request.method === 'POST') {
    const id = newId(), username = `groundling_${newId().slice(0,8)}`, hash = await hashPassword(newToken());
    const token = newToken(), sid = newId(), exp = new Date(Date.now() + 86_400_000).toISOString();
    await db.prepare('INSERT INTO users (id,username,password_hash,is_guest) VALUES (?,?,?,1)').bind(id, username, hash).run();
    await db.prepare('INSERT INTO settings (user_id) VALUES (?)').bind(id).run();
    await db.prepare('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,?)').bind(sid, id, token, exp).run();
    return json({ token, user: { id, username, email: null, is_guest: true, premium_status: 'free' } }, 201);
  }

  if (action === 'logout' && request.method === 'POST') {
    const s = await getSession(request, db);
    if (s) await db.prepare('DELETE FROM sessions WHERE token = ?').bind(s.token).run();
    return json({ message: 'Exited stage' });
  }

  if (action === 'me' && request.method === 'GET') {
    const s = await getSession(request, db);
    if (!s) return json({ error: 'Unauthorized' }, 401);
    // Graceful downgrade: check if premium has expired
    let premiumStatus = s.premium_status;
    if (s.premium_expires_at && new Date(s.premium_expires_at) < new Date() && premiumStatus !== 'free') {
      premiumStatus = 'free';
      await db.prepare("UPDATE users SET premium_status = 'free' WHERE id = ?").bind(s.user_id).run();
    }
    return json({ user: { id: s.user_id, username: s.username, email: s.email, is_guest: s.is_guest === 1, premium_status: premiumStatus } });
  }

  if (action === 'forgot-password' && request.method === 'POST') {
    const { email = '' } = await request.json().catch(() => ({}));
    if (!email) return json({ error: 'Email required' }, 400);
    const user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
    if (user) {
      const rt = newToken(), rid = newId(), exp = new Date(Date.now() + 3_600_000).toISOString();
      await db.prepare('INSERT INTO password_resets (id,user_id,token,expires_at) VALUES (?,?,?,?)').bind(rid, user.id, rt, exp).run();
      if (env.RESEND_API_KEY) {
        const url = `https://${env.APP_DOMAIN||'inflictor.pages.dev'}/?reset=${rt}`;
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: env.FROM_EMAIL||'noreply@inflictor.app', to: email, subject: 'The Inflictor — Reset Thy Password',
            html: `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:2rem;background:#110800;color:#d4af37;border:1px solid #5a3010"><h1 style="text-align:center;letter-spacing:.1em">THE INFLICTOR</h1><p style="text-align:center;font-style:italic;color:#a07840;margin-bottom:2rem">"What's done cannot be undone — but thy password can be restored."</p><div style="text-align:center;margin:2rem 0"><a href="${url}" style="display:inline-block;background:#d4af37;color:#110800;padding:.9rem 2.5rem;text-decoration:none;font-weight:bold">RESET THY PASSWORD</a></div><p style="font-size:.8rem;color:#6a5030;text-align:center">This link expires in one hour.</p></div>` }),
        });
      }
    }
    return json({ message: 'If that address is registered, a messenger hath been dispatched.' });
  }

  if (action === 'reset-password' && request.method === 'POST') {
    const { token = '', password = '' } = await request.json().catch(() => ({}));
    if (!token || !password || password.length < 8) return json({ error: 'Token and password (≥8 chars) required' }, 400);
    const reset = await db.prepare(`SELECT * FROM password_resets WHERE token=? AND expires_at>datetime('now') AND used=0`).bind(token).first();
    if (!reset) return json({ error: 'This token hath expired or been used already' }, 400);
    await db.prepare(`UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?`).bind(await hashPassword(password), reset.user_id).run();
    await db.prepare('UPDATE password_resets SET used=1 WHERE id=?').bind(reset.id).run();
    await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(reset.user_id).run();
    return json({ message: 'Password hath been reset. Please enter the stage anew.' });
  }

  return json({ error: 'Not found' }, 404);
}

// ─── /api/settings ────────────────────────────────────────────────────────────

async function handleSettings(segments, request, env) {
  const db = env.DB, s = await getSession(request, db);
  if (!s) return json({ error: 'Unauthorized' }, 401);

  if (request.method === 'GET') return json(await db.prepare('SELECT * FROM settings WHERE user_id=?').bind(s.user_id).first() || {});

  if (request.method === 'PUT') {
    const { theme, wake_time, sound_enabled, notification_enabled, notification_repeat, week_start_day, avatar_color, font_style,
            cheer_enabled, aww_enabled, avatar_data } =
      await request.json().catch(() => ({}));
    // The settings row always exists (created at registration). Ensure it, then UPDATE only the
    // fields provided — COALESCE keeps the rest. A plain UPDATE avoids the INSERT path's NOT NULL
    // check tripping on the columns this PUT didn't send (that was returning 500 on every save).
    await db.prepare('INSERT OR IGNORE INTO settings (user_id) VALUES (?)').bind(s.user_id).run();
    await db.prepare(`
      UPDATE settings SET
        theme=COALESCE(?,theme), wake_time=COALESCE(?,wake_time),
        sound_enabled=COALESCE(?,sound_enabled),
        notification_enabled=COALESCE(?,notification_enabled),
        notification_repeat=COALESCE(?,notification_repeat),
        week_start_day=COALESCE(?,week_start_day),
        avatar_color=COALESCE(?,avatar_color),
        font_style=COALESCE(?,font_style),
        cheer_enabled=COALESCE(?,cheer_enabled),
        aww_enabled=COALESCE(?,aww_enabled),
        avatar_data=COALESCE(?,avatar_data),
        updated_at=datetime('now')
      WHERE user_id=?
    `).bind(theme??null, wake_time??null, sound_enabled??null, notification_enabled??null,
            notification_repeat??null, week_start_day??null, avatar_color??null, font_style??null,
            cheer_enabled??null, aww_enabled??null, avatar_data??null, s.user_id).run();
    return json(await db.prepare('SELECT * FROM settings WHERE user_id=?').bind(s.user_id).first());
  }
  return json({ error: 'Method not allowed' }, 405);
}

// ─── /api/week  /schedule  /day-override  /note  /task-log ───────────────────

async function handlePlanner(segments, request, env) {
  const db = env.DB, s = await getSession(request, db);
  if (!s) return json({ error: 'Unauthorized' }, 401);
  const uid = s.user_id, url = new URL(request.url), seg = segments[0];

  if (seg === 'week' && request.method === 'GET') {
    const start = url.searchParams.get('start');
    if (!start) return json({ error: 'start param required' }, 400);
    const days = Array.from({length:7},(_,i)=>{ const d=new Date(`${start}T12:00:00Z`); d.setUTCDate(d.getUTCDate()+i); return d.toISOString().split('T')[0]; });
    const end = days[6];
    // Find Monday-aligned week key for schedule lookup
    const sd=new Date(`${start}T12:00:00Z`), dow=sd.getUTCDay(), monDate=new Date(sd);
    monDate.setUTCDate(sd.getUTCDate()+(dow===0?-6:1-dow));
    const monStr=monDate.toISOString().split('T')[0];
    const [schedRow,ovr,notes,logs,memosR] = await Promise.all([
      db.prepare('SELECT schedule_data FROM weekly_schedules WHERE user_id=? AND week_start=?').bind(uid,monStr).first(),
      db.prepare('SELECT date,schedule_data FROM daily_schedules WHERE user_id=? AND date>=? AND date<=?').bind(uid,start,end).all(),
      db.prepare('SELECT date,content FROM notes WHERE user_id=? AND date>=? AND date<=?').bind(uid,start,end).all(),
      db.prepare('SELECT date,task_id,task_name,status FROM task_logs WHERE user_id=? AND date>=? AND date<=? ORDER BY logged_at DESC').bind(uid,start,end).all(),
      db.prepare('SELECT date,item_id,content FROM memos WHERE user_id=? AND date>=? AND date<=?').bind(uid,start,end).all(),
    ]);
    const parse = s => { try{return JSON.parse(s);}catch{return s;} };
    const dailyOverrides={}, noteMap={}, memoMap={}, seen=new Set(), taskLogs=[];
    for (const r of ovr.results||[]) dailyOverrides[r.date]=parse(r.schedule_data);
    for (const r of notes.results||[]) noteMap[r.date]=r.content;
    for (const r of memosR.results||[]) memoMap[`${r.date}:${r.item_id}`]=r.content;
    for (const l of logs.results||[]) { const k=`${l.date}:${l.task_id||l.task_name}`; if(!seen.has(k)){seen.add(k);taskLogs.push(l);} }
    return json({ schedule: schedRow?parse(schedRow.schedule_data):null, dailyOverrides, notes:noteMap, memos:memoMap, taskLogs });
  }
  if (seg==='schedule'&&request.method==='PUT') {
    const {week_start,schedule_data}=await request.json().catch(()=>({}));
    if (!week_start||!schedule_data) return json({error:'week_start and schedule_data required'},400);
    const raw=typeof schedule_data==='string'?schedule_data:JSON.stringify(schedule_data);
    await db.prepare(`INSERT INTO weekly_schedules (id,user_id,week_start,schedule_data,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(user_id,week_start) DO UPDATE SET schedule_data=excluded.schedule_data,updated_at=datetime('now')`).bind(newId(),uid,week_start,raw).run();
    return json({ok:true});
  }
  if (seg==='day-override'&&request.method==='PUT') {
    const {date,schedule_data}=await request.json().catch(()=>({}));
    if (!date||schedule_data===undefined) return json({error:'date and schedule_data required'},400);
    const raw=typeof schedule_data==='string'?schedule_data:JSON.stringify(schedule_data);
    await db.prepare(`INSERT INTO daily_schedules (id,user_id,date,schedule_data,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(user_id,date) DO UPDATE SET schedule_data=excluded.schedule_data,updated_at=datetime('now')`).bind(newId(),uid,date,raw).run();
    return json({ok:true});
  }
  if (seg==='note'&&request.method==='PUT') {
    const {date,content=''}=await request.json().catch(()=>({}));
    if (!date) return json({error:'date required'},400);
    await db.prepare(`INSERT INTO notes (id,user_id,date,content,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(user_id,date) DO UPDATE SET content=excluded.content,updated_at=datetime('now')`).bind(newId(),uid,date,content).run();
    return json({ok:true});
  }
  if (seg==='memo'&&request.method==='PUT') {
    const {date,item_id,content=''}=await request.json().catch(()=>({}));
    if (!date||!item_id) return json({error:'date and item_id required'},400);
    if (!content) {
      await db.prepare('DELETE FROM memos WHERE user_id=? AND date=? AND item_id=?').bind(uid,date,item_id).run();
    } else {
      await db.prepare(`INSERT INTO memos (id,user_id,date,item_id,content,updated_at) VALUES (?,?,?,?,?,datetime('now')) ON CONFLICT(user_id,date,item_id) DO UPDATE SET content=excluded.content,updated_at=datetime('now')`).bind(newId(),uid,date,item_id,content).run();
    }
    return json({ok:true});
  }
  if (seg==='task-log'&&request.method==='POST') {
    const {date,task_id,task_name,status}=await request.json().catch(()=>({}));
    if (!date||!task_name||!status) return json({error:'date, task_name, status required'},400);
    await db.prepare('INSERT INTO task_logs (id,user_id,date,task_id,task_name,status) VALUES (?,?,?,?,?,?)').bind(newId(),uid,date,task_id||null,task_name,status).run();
    return json({ok:true});
  }
  return json({error:'Not found'},404);
}

// ─── /api/history ─────────────────────────────────────────────────────────────

async function handleHistory(segments, request, env) {
  const db=env.DB, s=await getSession(request,db);
  if (!s) return json({error:'Unauthorized'},401);
  const uid=s.user_id, url=new URL(request.url);
  const limit=Math.min(50,parseInt(url.searchParams.get('limit')||'20'));
  const offset=parseInt(url.searchParams.get('offset')||'0');
  const datesRes=await db.prepare('SELECT DISTINCT date FROM task_logs WHERE user_id=? ORDER BY date DESC LIMIT ? OFFSET ?').bind(uid,limit,offset).all();
  const dates=(datesRes.results||[]).map(r=>r.date);
  if (!dates.length) return json({days:[],has_more:false});
  const ph=dates.map(()=>'?').join(',');
  const [logsR,notesR]=await Promise.all([
    db.prepare(`SELECT date,task_id,task_name,status FROM task_logs WHERE user_id=? AND date IN (${ph}) ORDER BY logged_at DESC`).bind(uid,...dates).all(),
    db.prepare(`SELECT date,content FROM notes WHERE user_id=? AND date IN (${ph})`).bind(uid,...dates).all(),
  ]);
  const byDate={},seen={};
  for (const l of logsR.results||[]) {
    const k=l.task_id||l.task_name; if(!seen[l.date]) seen[l.date]=new Set();
    if(seen[l.date].has(k)) continue; seen[l.date].add(k);
    if(!byDate[l.date]) byDate[l.date]=[];byDate[l.date].push(l);
  }
  const nMap={}; for (const r of notesR.results||[]) nMap[r.date]=r.content;
  const days=dates.map(d=>{const ls=byDate[d]||[];return{date:d,tasks_completed:ls.filter(l=>l.status==='completed').length,tasks_failed:ls.filter(l=>l.status==='failed').length,note:nMap[d]||'',logs:ls};});
  return json({days,has_more:dates.length===limit});
}

// ─── /api/account ─────────────────────────────────────────────────────────────

async function handleAccount(segments, request, env) {
  const db=env.DB, s=await getSession(request,db);
  if (!s) return json({error:'Unauthorized'},401);
  const uid=s.user_id;
  if (request.method==='PUT') {
    const {new_username,current_password,new_password}=await request.json().catch(()=>({}));
    if (new_username) {
      if (!/^[a-zA-Z0-9_]{3,30}$/.test(new_username)) return json({error:'Username must be 3–30 chars'},400);
      if (await db.prepare('SELECT id FROM users WHERE username=? AND id!=?').bind(new_username,uid).first()) return json({error:'That name is already taken'},409);
      await db.prepare(`UPDATE users SET username=?,updated_at=datetime('now') WHERE id=?`).bind(new_username,uid).run();
      return json({ok:true,username:new_username});
    }
    if (current_password&&new_password) {
      const user=await db.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
      if (!user||!(await verifyPassword(current_password,user.password_hash))) return json({error:'Current secret is incorrect'},401);
      if (new_password.length<8) return json({error:'New secret must be at least 8 characters'},400);
      await db.prepare(`UPDATE users SET password_hash=?,updated_at=datetime('now') WHERE id=?`).bind(await hashPassword(new_password),uid).run();
      return json({ok:true});
    }
    return json({error:'Nothing to update'},400);
  }
  if (request.method==='DELETE') {
    const {password}=await request.json().catch(()=>({}));
    const user=await db.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
    if (!user) return json({error:'User not found'},404);
    if (!user.is_guest) {
      if (!password) return json({error:'Password required to confirm deletion'},400);
      if (!(await verifyPassword(password,user.password_hash))) return json({error:'Incorrect password'},401);
    }
    // Cancel Stripe subscription if exists
    if (user.stripe_subscription_id&&env.STRIPE_SECRET_KEY) {
      await fetch(`https://api.stripe.com/v1/subscriptions/${user.stripe_subscription_id}`,{method:'DELETE',headers:{'Authorization':`Bearer ${env.STRIPE_SECRET_KEY}`}}).catch(()=>{});
    }
    await db.prepare('DELETE FROM users WHERE id=?').bind(uid).run();
    return json({ok:true});
  }
  return json({error:'Method not allowed'},405);
}

// ─── /api/export ──────────────────────────────────────────────────────────────

async function handleExport(segments, request, env) {
  const db=env.DB, s=await getSession(request,db);
  if (!s) return json({error:'Unauthorized'},401);
  const uid=s.user_id;
  const [user,settings,weekly,daily,notes,logs]=await Promise.all([
    db.prepare('SELECT id,username,email,created_at FROM users WHERE id=?').bind(uid).first(),
    db.prepare('SELECT * FROM settings WHERE user_id=?').bind(uid).first(),
    db.prepare('SELECT week_start,schedule_data,created_at FROM weekly_schedules WHERE user_id=? ORDER BY week_start DESC').bind(uid).all(),
    db.prepare('SELECT date,schedule_data,created_at FROM daily_schedules WHERE user_id=? ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT date,content,updated_at FROM notes WHERE user_id=? ORDER BY date DESC').bind(uid).all(),
    db.prepare('SELECT date,task_name,status,logged_at FROM task_logs WHERE user_id=? ORDER BY logged_at DESC').bind(uid).all(),
  ]);
  return json({exported_at:new Date().toISOString(),user,settings,weekly_schedules:weekly.results||[],daily_schedules:daily.results||[],notes:notes.results||[],task_logs:logs.results||[]});
}

// ─── /api/stripe/* ────────────────────────────────────────────────────────────

async function handleStripe(segments, request, env) {
  const db=env.DB, action=segments[1];

  // POST /api/stripe/create-checkout
  if (action==='create-checkout'&&request.method==='POST') {
    const s=await getSession(request,db);
    if (!s) return json({error:'Unauthorized'},401);
    if (!env.STRIPE_SECRET_KEY||!env.STRIPE_PRICE_ID) return json({error:'Stripe is not yet configured on this server.'},503);
    const user=await db.prepare('SELECT * FROM users WHERE id=?').bind(s.user_id).first();
    if (!user) return json({error:'User not found'},404);
    const domain=env.APP_DOMAIN||'inflictor.pages.dev';
    const params=new URLSearchParams({
      mode:'subscription',
      'payment_method_types[0]':'card',
      'line_items[0][price]':env.STRIPE_PRICE_ID,
      'line_items[0][quantity]':'1',
      'subscription_data[trial_period_days]':'7',
      success_url:`https://${domain}/?premium=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:`https://${domain}/?premium=cancelled`,
      client_reference_id:s.user_id,
    });
    if (user.stripe_customer_id) params.set('customer',user.stripe_customer_id);
    else if (user.email) params.set('customer_email',user.email);
    const res=await fetch('https://api.stripe.com/v1/checkout/sessions',{method:'POST',headers:{'Authorization':`Bearer ${env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},body:params.toString()});
    const data=await res.json();
    if (!res.ok) return json({error:data.error?.message||'Stripe checkout failed'},500);
    return json({url:data.url});
  }

  // POST /api/stripe/portal  — customer billing portal
  if (action==='portal'&&request.method==='POST') {
    const s=await getSession(request,db);
    if (!s) return json({error:'Unauthorized'},401);
    if (!env.STRIPE_SECRET_KEY) return json({error:'Stripe is not configured'},503);
    const user=await db.prepare('SELECT * FROM users WHERE id=?').bind(s.user_id).first();
    if (!user?.stripe_customer_id) return json({error:'No Stripe account found for this user'},404);
    const domain=env.APP_DOMAIN||'inflictor.pages.dev';
    const res=await fetch('https://api.stripe.com/v1/billing_portal/sessions',{method:'POST',headers:{'Authorization':`Bearer ${env.STRIPE_SECRET_KEY}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({customer:user.stripe_customer_id,return_url:`https://${domain}/`}).toString()});
    const data=await res.json();
    if (!res.ok) return json({error:data.error?.message||'Stripe portal failed'},500);
    return json({url:data.url});
  }

  return json({error:'Not found'},404);
}

// ─── /api/webhooks/stripe ─────────────────────────────────────────────────────

async function handleStripeWebhook(request, env) {
  const rawBody=await request.text();

  if (env.STRIPE_WEBHOOK_SECRET) {
    const sig=request.headers.get('Stripe-Signature')||'';
    if (!(await verifyStripeSignature(rawBody,sig,env.STRIPE_WEBHOOK_SECRET)))
      return json({error:'Invalid Stripe signature'},400);
  }

  let event;
  try { event=JSON.parse(rawBody); } catch { return json({error:'Invalid JSON'},400); }

  const db=env.DB;

  switch (event.type) {
    case 'checkout.session.completed': {
      const session=event.data.object;
      const userId=session.client_reference_id; if (!userId) break;
      // Save customer + subscription IDs
      await db.prepare('UPDATE users SET stripe_customer_id=?,stripe_subscription_id=? WHERE id=?').bind(session.customer,session.subscription,userId).run();
      // Trial starts — will update to 'premium' on invoice.payment_succeeded after trial
      const trialEnd=new Date(Date.now()+7*86_400_000).toISOString();
      await db.prepare(`UPDATE users SET premium_status='trial',premium_expires_at=? WHERE id=?`).bind(trialEnd,userId).run();
      break;
    }

    case 'customer.subscription.updated': {
      const sub=event.data.object;
      const user=await db.prepare('SELECT id FROM users WHERE stripe_subscription_id=?').bind(sub.id).first(); if(!user) break;
      let status='free', exp=null;
      if (sub.status==='active') { status='premium'; exp=new Date(sub.current_period_end*1000).toISOString(); }
      else if (sub.status==='trialing') { status='trial'; exp=new Date(sub.trial_end*1000).toISOString(); }
      else if (sub.status==='past_due') { status='past_due'; exp=new Date(sub.current_period_end*1000).toISOString(); }
      else if (sub.cancel_at_period_end) { status='premium'; exp=new Date(sub.current_period_end*1000).toISOString(); }
      await db.prepare('UPDATE users SET premium_status=?,premium_expires_at=? WHERE id=?').bind(status,exp,user.id).run();
      break;
    }

    case 'customer.subscription.deleted': {
      const sub=event.data.object;
      const user=await db.prepare('SELECT id FROM users WHERE stripe_subscription_id=?').bind(sub.id).first(); if(!user) break;
      await db.prepare(`UPDATE users SET premium_status='free',premium_expires_at=NULL,stripe_subscription_id=NULL WHERE id=?`).bind(user.id).run();
      break;
    }

    case 'invoice.payment_succeeded': {
      const inv=event.data.object; if (!inv.subscription) break;
      const user=await db.prepare('SELECT id FROM users WHERE stripe_subscription_id=?').bind(inv.subscription).first(); if(!user) break;
      const pe=inv.lines?.data?.[0]?.period?.end;
      if (pe) await db.prepare(`UPDATE users SET premium_status='premium',premium_expires_at=? WHERE id=?`).bind(new Date(pe*1000).toISOString(),user.id).run();
      break;
    }

    case 'invoice.payment_failed': {
      const inv=event.data.object; if (!inv.subscription) break;
      const user=await db.prepare('SELECT id FROM users WHERE stripe_subscription_id=?').bind(inv.subscription).first(); if(!user) break;
      await db.prepare(`UPDATE users SET premium_status='past_due' WHERE id=?`).bind(user.id).run();
      break;
    }
  }

  return json({received:true});
}

// ─── Main export ──────────────────────────────────────────────────────────────

const PLANNER_SEGS=new Set(['week','schedule','day-override','note','task-log','memo']);

export async function onRequest(context) {
  const {request,env,params}=context;
  const origin=request.headers.get('Origin'), cors=corsHeaders(origin), segments=params.route||[];
  if (request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
  let response;
  try {
    const seg=segments[0];
    if      (seg==='auth')                           response=await handleAuth(segments,request,env);
    else if (seg==='settings')                       response=await handleSettings(segments,request,env);
    else if (PLANNER_SEGS.has(seg))                  response=await handlePlanner(segments,request,env);
    else if (seg==='history')                        response=await handleHistory(segments,request,env);
    else if (seg==='account')                        response=await handleAccount(segments,request,env);
    else if (seg==='export')                         response=await handleExport(segments,request,env);
    else if (seg==='stripe')                         response=await handleStripe(segments,request,env);
    else if (seg==='webhooks'&&segments[1]==='stripe') response=await handleStripeWebhook(request,env);
    else                                             response=json({error:'Not found'},404);
  } catch(err) { console.error('API error:',err); response=json({error:'Internal server error'},500); }
  const headers=new Headers(response.headers);
  for (const [k,v] of Object.entries(cors)) headers.set(k,v);
  return new Response(response.body,{status:response.status,headers});
}
