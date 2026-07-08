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

// ─── Rate limiting (D1-backed fixed window) — throttles brute-force, signup/email spam, and hammering ──
const clientIp = (request) => request.headers.get('CF-Connecting-IP') || (request.headers.get('X-Forwarded-For')||'').split(',')[0].trim() || 'unknown';
// Returns true if ALLOWED, false if `id` has exceeded `limit` hits within `windowSec`. Fails OPEN on any
// DB error so a limiter hiccup can never lock out real users.
async function rateLimit(db, bucket, id, limit, windowSec) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSec);
    const k = `${bucket}:${String(id).slice(0,200)}:${windowStart}`;
    const row = await db.prepare(
      `INSERT INTO rate_limits (k, hits, expires_at) VALUES (?, 1, ?)
       ON CONFLICT(k) DO UPDATE SET hits = hits + 1 RETURNING hits`
    ).bind(k, windowStart + windowSec).first();
    if (Math.random() < 0.02) { try { await db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now).run(); } catch {} }
    return (row?.hits || 1) <= limit;
  } catch { return true; }
}
const tooMany = (retrySec = 60) => json({ error: 'Too many attempts — please wait a little and try again.' }, 429, { 'Retry-After': String(retrySec) });

// ─── /api/auth/* ──────────────────────────────────────────────────────────────

async function handleAuth(segments, request, env) {
  const db = env.DB, action = segments[1];

  if (action === 'register' && request.method === 'POST') {
    const { username = '', password = '', email = '' } = await request.json().catch(() => ({}));
    if (!(await rateLimit(db, 'register-ip', clientIp(request), 6, 3600))) return tooMany(600);
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
    if (!(await rateLimit(db, 'login-ip', clientIp(request), 15, 300)) || !(await rateLimit(db, 'login-user', String(username).toLowerCase(), 8, 900))) return tooMany(300);
    // Accept EITHER the username or the email in the login field — paying customers only know their email.
    const cred = String(username).trim();
    const user = await db.prepare('SELECT * FROM users WHERE (username = ? OR lower(email) = lower(?)) AND is_guest = 0').bind(cred, cred).first();
    if (!user || !(await verifyPassword(password, user.password_hash))) return json({ error: 'Invalid login or password' }, 401);
    const token = newToken(), sid = newId(), exp = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await db.prepare('INSERT INTO sessions (id,user_id,token,expires_at) VALUES (?,?,?,?)').bind(sid, user.id, token, exp).run();
    return json({ token, user: { id: user.id, username: user.username, email: user.email, is_guest: false, premium_status: user.premium_status } });
  }

  if (action === 'guest' && request.method === 'POST') {
    if (!(await rateLimit(db, 'guest-ip', clientIp(request), 6, 3600))) return tooMany(600);
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
    if (!(await rateLimit(db, 'forgot-ip', clientIp(request), 6, 3600)) || !(await rateLimit(db, 'forgot-email', String(email).toLowerCase(), 4, 3600))) return tooMany(600);
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
    if (!(await rateLimit(db, 'reset-ip', clientIp(request), 12, 3600))) return tooMany(600);
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
            cheer_enabled, aww_enabled, avatar_data, report_frequency, tz_offset, week_view, report_meds } =
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
        report_frequency=COALESCE(?,report_frequency),
        tz_offset=COALESCE(?,tz_offset),
        week_view=COALESCE(?,week_view),
        report_meds=COALESCE(?,report_meds),
        updated_at=datetime('now')
      WHERE user_id=?
    `).bind(theme??null, wake_time??null, sound_enabled??null, notification_enabled??null,
            notification_repeat??null, week_start_day??null, avatar_color??null, font_style??null,
            cheer_enabled??null, aww_enabled??null, avatar_data??null,
            report_frequency??null, tz_offset??null, week_view??null, report_meds??null, s.user_id).run();
    return json(await db.prepare('SELECT * FROM settings WHERE user_id=?').bind(s.user_id).first());
  }
  return json({ error: 'Method not allowed' }, 405);
}

// ─── /api/week  /schedule  /day-override  /note  /task-log ───────────────────

async function handlePlanner(segments, request, env) {
  const db = env.DB, s = await getSession(request, db);
  if (!s) return json({ error: 'Unauthorized' }, 401);
  // Generous per-account write cap — never trips for real use, but stops a script bloating the DB / costs.
  if (request.method !== 'GET' && !(await rateLimit(db, 'write', s.user_id, 240, 60))) return tooMany(30);
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
    const {week_start,schedule_data,today}=await request.json().catch(()=>({}));
    if (!week_start||!schedule_data) return json({error:'week_start and schedule_data required'},400);
    const raw=typeof schedule_data==='string'?schedule_data:JSON.stringify(schedule_data);
    // FREEZE THE PAST: before overwriting this week's template, snapshot any of THIS week's days that
    // are already in the past and have no daily override yet — using the OLD template — so changing the
    // template (or clearing) can never silently rewrite history. `today` is the client's local date.
    if (today) {
      const oldRow = await db.prepare('SELECT schedule_data FROM weekly_schedules WHERE user_id=? AND week_start=?').bind(uid,week_start).first();
      let oldTmpl=null; if (oldRow) { try { oldTmpl=JSON.parse(oldRow.schedule_data); } catch {} }
      if (oldTmpl && Array.isArray(oldTmpl.activities)) {
        const mon=new Date(`${week_start}T12:00:00Z`);
        for (let i=0;i<7;i++) {
          const d=new Date(mon); d.setUTCDate(mon.getUTCDate()+i);
          const ds=d.toISOString().split('T')[0];
          if (ds>=today) continue;                                                   // only days already in the past
          const has=await db.prepare('SELECT 1 FROM daily_schedules WHERE user_id=? AND date=?').bind(uid,ds).first();
          if (has) continue;                                                         // a custom card / prior freeze already exists — leave it
          const di=(d.getUTCDay()===0?6:d.getUTCDay()-1);                            // 0=Mon..6=Sun
          const acts=oldTmpl.activities.filter(a=>!a.days||a.days[di]);
          const snap=JSON.stringify({ wake_time:oldTmpl.wake_time||'07:00', activities:acts, custom:true });
          await db.prepare(`INSERT INTO daily_schedules (id,user_id,date,schedule_data,updated_at) VALUES (?,?,?,?,datetime('now')) ON CONFLICT(user_id,date) DO NOTHING`).bind(newId(),uid,ds,snap).run();
        }
      }
    }
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
  if (!(await rateLimit(db, 'account', s.user_id, 20, 600))) return tooMany(120);   // password hashing is CPU-heavy — cap hammering
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
    // Delete ALL of the user's data explicitly (not relying on ON DELETE CASCADE, which only fires if D1
    // has foreign-key enforcement on). Batched so it runs as a single transaction — all or nothing.
    const childTables=['sessions','password_resets','settings','tasks','weekly_schedules','daily_schedules','notes','task_logs','history','memos'];
    await db.batch([
      ...childTables.map(t=>db.prepare(`DELETE FROM ${t} WHERE user_id=?`).bind(uid)),
      db.prepare('DELETE FROM users WHERE id=?').bind(uid),
    ]);
    return json({ok:true});
  }
  return json({error:'Method not allowed'},405);
}

// ─── /api/report — server-side report: completed-activity time (meal carved out) + calories ──────
const rptParse = t => { const [h,m]=(t||'07:00').split(':').map(Number); return (h||0)*60+(m||0); };
const rptDayIdx = ds => { const d=new Date(`${ds}T12:00:00Z`); const w=d.getUTCDay(); return w===0?6:w-1; };  // 0=Mon..6=Sun
const rptMonday = ds => { const d=new Date(`${ds}T12:00:00Z`); const w=d.getUTCDay(); d.setUTCDate(d.getUTCDate()+(w===0?-6:1-w)); return d.toISOString().split('T')[0]; };
function rptTimes(acts) {
  const out={};
  for (const a of acts||[]) {
    const t=a.timing||'flexible';
    if ((t==='fixed'||t==='flexible'||t==='sustenance'||t==='med') && a.fixed_start) {
      const start=rptParse(a.fixed_start), end=a.fixed_end?rptParse(a.fixed_end):start+(a.duration_minutes||0);
      out[a.id]={ start, end:Math.max(end,start), sus:t==='sustenance' };
    }
  }
  return out;
}
// Sum an activity's COMPLETED split-segment minutes (split by meals + split-meds, like the planner).
// Each segment's status is keyed by `${date}:${id}#${seg}` (seg 0 = the activity's own id). Meal time is excluded.
function rptCompletedSegMins(ds, a, acts, times, status) {
  const t=times[a.id]; if(!t) return 0;
  const splitters=(acts||[]).filter(x => ((x.timing||'')==='sustenance' || ((x.timing||'')==='med' && x.med_display!=='ribbon')) && times[x.id] && times[x.id].start>t.start && times[x.id].start<t.end)
                            .sort((x,y)=>times[x.id].start-times[y.id].start);
  let cursor=t.start, seg=0, mins=0;
  const consider=(s,e)=>{ const stt = seg ? status[`${ds}:${a.id}#${seg}`] : (status[`${ds}:${a.id}`]||status[`${ds}:${a.name}`]); if(stt==='completed') mins+=Math.max(0,e-s); seg++; };
  for (const su of splitters) {
    const sst=times[su.id];
    if (sst.start>cursor) consider(cursor, sst.start);
    cursor=Math.max(cursor, ((su.timing||'')==='med' && su.med_display!=='ribbon') ? sst.start : sst.end);
  }
  if (cursor<t.end) consider(cursor, t.end);
  return mins;
}
// Computes the report for `numDays` days from `start`. Returns totals + per-day breakdown.
async function computeReport(db, uid, start, numDays) {
  const dates=[]; { const d0=new Date(`${start}T12:00:00Z`); for (let i=0;i<numDays;i++){ const d=new Date(d0); d.setUTCDate(d0.getUTCDate()+i); dates.push(d.toISOString().split('T')[0]); } }
  const end=dates[dates.length-1];
  const [ovrRes, logsRes, memosRes] = await Promise.all([
    db.prepare('SELECT date,schedule_data FROM daily_schedules WHERE user_id=? AND date>=? AND date<=?').bind(uid,start,end).all(),
    db.prepare('SELECT date,task_id,task_name,status FROM task_logs WHERE user_id=? AND date>=? AND date<=? ORDER BY logged_at DESC').bind(uid,start,end).all(),
    db.prepare('SELECT date,item_id,content FROM memos WHERE user_id=? AND date>=? AND date<=?').bind(uid,start,end).all(),
  ]);
  const parse=x=>{ try{return JSON.parse(x);}catch{return null;} };
  const overrides={}; for (const r of ovrRes.results||[]) overrides[r.date]=parse(r.schedule_data);
  const status={}, seen=new Set();
  for (const l of logsRes.results||[]) { const k=`${l.date}:${l.task_id||l.task_name}`; if(!seen.has(k)){ seen.add(k); status[k]=l.status; } }
  const cals={}; for (const r of memosRes.results||[]) if (r.item_id && r.item_id.startsWith('cal:')) cals[`${r.date}:${r.item_id}`]=parseInt(r.content)||0;
  const mondays=[...new Set(dates.map(rptMonday))];
  const tmplRows=await Promise.all(mondays.map(mon=>db.prepare('SELECT schedule_data FROM weekly_schedules WHERE user_id=? AND week_start=?').bind(uid,mon).first()));
  const templates={}; mondays.forEach((mon,i)=>templates[mon]=tmplRows[i]?parse(tmplRows[i].schedule_data):null);
  let totMin=0, totCal=0, done=0, missed=0; const byDay=[];
  for (const ds of dates) {
    let acts;
    if (overrides[ds]) acts=overrides[ds].activities||[];
    else { const tmpl=templates[rptMonday(ds)], di=rptDayIdx(ds); acts=tmpl?(tmpl.activities||[]).filter(a=>!a.days||a.days[di]):[]; }
    const times=rptTimes(acts), carveList=acts.filter(a=>(a.timing||'')==='sustenance'&&times[a.id]);   // only meals carve activity time — a med is a moment, not a block
    let dayMin=0, dayCal=0; const items=[];
    for (const a of acts) {
      const st=status[`${ds}:${a.id}`]||status[`${ds}:${a.name}`], timing=a.timing||'flexible';
      if (timing==='sustenance') { const c=cals[`${ds}:cal:${a.id}`]||0; if(c)dayCal+=c; if(st==='completed'||c) items.push({type:'sus',name:a.name||'snack',calories:c}); continue; }
      if (timing==='med') continue;                            // reminders aren't activity time
      if (st==='completed') done++; else if (st==='failed') { missed++; continue; }
      if (st!=='completed') continue;
      if (timing==='anytime') { items.push({type:'anytime',name:a.name}); continue; }
      if (a.undetermined) { items.push({type:'open',name:a.name}); continue; }
      const t=times[a.id]; if(!t) continue;
      const dur=rptCompletedSegMins(ds, a, acts, times, status);   // only COMPLETED split-segments' time — each part on its own
      dayMin+=dur;
      items.push({type:'act',name:a.name,minutes:dur});
    }
    totMin+=dayMin; totCal+=dayCal;
    if (items.length) byDay.push({ date:ds, minutes:dayMin, calories:dayCal, items });
  }
  return { start, days:numDays, total:{ minutes:totMin, calories:totCal, done, missed }, byDay };
}
async function handleReport(request, env) {
  const db=env.DB, s=await getSession(request,db);
  if (!s) return json({ error:'Unauthorized' }, 401);
  const url=new URL(request.url), start=url.searchParams.get('start');
  if (!start) return json({ error:'start (ISO date) required' }, 400);
  const numDays=Math.min(31, Math.max(1, parseInt(url.searchParams.get('days')||'7')));
  return json(await computeReport(db, s.user_id, start, numDays));
}

// ─── /api/report-email — email the user's own report (body built client-side, escaped here) ──────
async function handleReportEmail(request, env) {
  const db = env.DB, s = await getSession(request, db);
  if (!s) return json({ error:'Unauthorized' }, 401);
  if (!(await rateLimit(db, 'report-email', s.user_id, 12, 3600))) return tooMany(600);
  if (!s.email) return json({ error:'No email is on your account — add one in your profile to receive reports.' }, 400);
  if (!env.RESEND_API_KEY) return json({ error:'Email is not configured on the server yet.' }, 503);
  const { body='', period='Your report' } = await request.json().catch(() => ({}));
  const esc = x => String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const bodyHtml = esc(String(body).slice(0, 20000)).replace(/\n/g,'<br>');
  const html = `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:2rem;background:#110800;color:#d4af37;border:1px solid #5a3010">
    <h1 style="text-align:center;letter-spacing:.1em;margin:0">THE INFLICTOR</h1>
    <p style="text-align:center;font-style:italic;color:#a07840;margin:.3rem 0 1.4rem">${esc(period)}</p>
    <div style="background:#1a0f00;padding:1.1rem 1.3rem;border:1px solid #3a2410;color:#e8d0a0;font-size:14px;line-height:1.7;white-space:normal">${bodyHtml}</div>
    <p style="font-size:.72rem;color:#6a5030;text-align:center;margin-top:1.4rem">Sent from The Inflictor · ${esc(new Date().toDateString())}</p>
  </div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json' },
    // Default to Resend's shared test sender (works to your own account email with no domain setup);
    // set FROM_EMAIL once you've verified a domain to send to anyone.
    body: JSON.stringify({ from: env.FROM_EMAIL||'The Inflictor <onboarding@resend.dev>', to: s.email, subject: `The Inflictor — ${period}`, html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return json({ error:'The email service refused the send.', detail: detail.slice(0,300) }, 502);
  }
  return json({ ok:true, sent_to: s.email });
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

// Make a unique, valid username (3–30 of [a-zA-Z0-9_]) from an email's local part.
async function uniqueUsername(db, email) {
  let base=String(email).split('@')[0].replace(/[^a-zA-Z0-9_]/g,'').slice(0,24) || 'user';
  if (base.length<3) base=`${base}user`;
  let name=base, n=0;
  while (await db.prepare('SELECT 1 FROM users WHERE username=?').bind(name).first()) {
    n++; name=`${base}${n}`.slice(0,30);
    if (n>9999) { name=`user_${newId().slice(0,8)}`; break; }
  }
  return name;
}
// Welcome email after a successful subscription — a friendly setup guide: (new accounts) a "set your
// password" link, the installer download, and a heads-up about Windows/antivirus warnings so a normal
// unsigned-app warning doesn't alarm them. Sent via Resend, only to the buyer's own address.
async function sendWelcomeEmail(db, env, userId, email, isNew) {
  if (!env.RESEND_API_KEY) return;
  const domain=env.APP_DOMAIN||'inflictor.pages.dev';
  const downloadUrl=env.DOWNLOAD_URL||`https://${domain}/`;   // TODO: real installer download link (step 4 — installer hosting)
  const btn='display:inline-block;background:#d4af37;color:#110800;padding:.7rem 1.7rem;text-decoration:none;font-weight:bold;border-radius:2px';
  let setStep='';
  if (isNew) {
    const rt=newToken(), rid=newId(), exp=new Date(Date.now()+14*86_400_000).toISOString();
    await db.prepare('INSERT INTO password_resets (id,user_id,token,expires_at) VALUES (?,?,?,?)').bind(rid,userId,rt,exp).run();
    const setUrl=`https://${domain}/?reset=${rt}`;
    setStep=`<p style="margin:1.4rem 0 .3rem;color:#d4af37"><b>1. Set your password</b></p>
      <p style="margin:0 0 .2rem"><a href="${setUrl}" style="${btn}">Set your password</a></p>
      <p style="margin:0 0 1rem;font-size:.75rem;color:#6a5030">(link valid 14 days · sets the password for the email this was sent to)</p>`;
  } else {
    setStep=`<p style="margin:1.4rem 0;color:#e8d0a0">Log in with your existing account.</p>`;
  }
  const N=isNew?['2','3','4']:['1','2','3'];
  const html=`<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:2rem;background:#110800;color:#d4af37;border:1px solid #5a3010">
    <h1 style="text-align:center;letter-spacing:.1em;margin:0">THE INFLICTOR</h1>
    <p style="text-align:center;font-style:italic;color:#a07840;margin:.3rem 0 1.4rem">Welcome — your subscription is active. Let's get you set up.</p>
    ${setStep}
    <p style="margin:1.2rem 0 .3rem;color:#d4af37"><b>${N[0]}. Download the app</b></p>
    <p style="margin:0 0 1rem"><a href="${downloadUrl}" style="${btn}">Download The Inflictor</a></p>
    <div style="border:1px solid #5a3010;background:#1a0f00;padding:1rem 1.2rem;margin:1.2rem 0;color:#e8d0a0;font-size:.88rem;line-height:1.6">
      <p style="margin:0 0 .5rem;color:#d4af37;font-weight:bold">⚠️ ${N[1]}. A heads-up so nothing alarms you</p>
      <p style="margin:0 0 .6rem">The Inflictor is brand-new and built by one independent developer, so it isn't "code-signed" yet — which means your browser and Windows may flag it as an unknown program as you download and open it. This is completely normal, it is <b>not</b> a virus, and it's expected. Here's what you might see at each point, and what to do:</p>
      <p style="margin:0 0 .4rem">• <b>While it downloads</b> (Edge or Chrome) — your browser may say it <i>"isn't commonly downloaded"</i> and try to block it. It's flagged only because it's new, not because it's harmful. Keep it: in <b>Edge</b>, point at the download in the bar, click the <b>•••</b> (or the warning) and choose <b>Keep</b> → <b>Keep anyway</b>; in <b>Chrome</b>, click <b>Keep</b>.</p>
      <p style="margin:0 0 .4rem">• <b>When you open it</b> — Windows SmartScreen may show a blue <i>"Windows protected your PC"</i> box. It is <b>not</b> a virus warning. Click <b>More info</b>, then <b>Run anyway</b>.</p>
      <p style="margin:0">• <b>Your antivirus or firewall</b> — it may scan the file or ask permission before it runs. Choose <b>Allow</b> or <b>Run anyway</b>. (Norton, for example, usually scans it, confirms it's clean, and lets it through.)</p>
    </div>
    <p style="margin:1.2rem 0 .3rem;color:#d4af37"><b>${N[2]}. Open it and log in</b></p>
    <p style="margin:0">Once it's installed, open The Inflictor and log in${isNew?' with your email and the password you set':''}. That's it — you're in. One last note: keep the app open or minimized while you're using it, so its reminders can chime.</p>
    <p style="margin:1.6rem 0 0;font-size:.85rem;color:#a07840">Any snag at all, just reply to this email and I'll help. — Terri</p>
  </div>`;
  try {
    await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.FROM_EMAIL||'The Inflictor <noreply@terristech.com>',to:email,subject:'Welcome to The Inflictor 🎭 — getting set up',html})});
  } catch {}
}

// ─── /api/webhooks/stripe ─────────────────────────────────────────────────────

async function handleStripeWebhook(request, env) {
  const rawBody=await request.text();

  // FAIL CLOSED: only ever act on a webhook whose signature verifies. If no secret is configured, reject
  // everything — otherwise anyone could POST a fake "payment succeeded" and grant themselves premium.
  if (!env.STRIPE_WEBHOOK_SECRET) return json({error:'Webhook not configured'},503);
  const sig=request.headers.get('Stripe-Signature')||'';
  if (!(await verifyStripeSignature(rawBody,sig,env.STRIPE_WEBHOOK_SECRET)))
    return json({error:'Invalid Stripe signature'},400);

  let event;
  try { event=JSON.parse(rawBody); } catch { return json({error:'Invalid JSON'},400); }

  const db=env.DB;

  switch (event.type) {
    case 'checkout.session.completed': {
      const session=event.data.object;
      // Inflictor is the ONLY subscription product. One-time purchases on this same Stripe account (e.g. Ere Long,
      // The Measure) fire this same webhook — ignore them so a non-Inflictor buyer never gets an Inflictor account/email.
      if (session.mode !== 'subscription') break;
      const email=(session.customer_details?.email || session.customer_email || '').toLowerCase().trim();
      let userId=session.client_reference_id, isNew=false;   // client_reference_id is set only for the in-app (logged-in) checkout
      if (!userId && email) {
        // Pay-first (landing-page Payment Link): find the account for this email, or create one.
        const existing=await db.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
        if (existing) userId=existing.id;
        else {
          userId=newId();
          const username=await uniqueUsername(db, email);
          const placeholder=await hashPassword(newToken());   // unusable until they set a password via the welcome link
          await db.prepare('INSERT INTO users (id,username,email,password_hash) VALUES (?,?,?,?)').bind(userId,username,email,placeholder).run();
          await db.prepare('INSERT INTO settings (user_id) VALUES (?)').bind(userId).run();
          isNew=true;
        }
      }
      if (!userId) break;   // no logged-in ref and no email → nothing to link to
      // Grant access immediately — NO trial. (subscription.updated / invoice events keep the expiry current.)
      await db.prepare(`UPDATE users SET stripe_customer_id=?,stripe_subscription_id=?,premium_status='premium',premium_expires_at=NULL WHERE id=?`).bind(session.customer,session.subscription,userId).run();
      if (email) await sendWelcomeEmail(db, env, userId, email, isNew);   // setup guide: download + (new) set-password + firewall heads-up
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
    else if (seg==='report')                         response=await handleReport(request,env);
    else if (seg==='report-email')                   response=await handleReportEmail(request,env);
    else if (seg==='stripe')                         response=await handleStripe(segments,request,env);
    else if (seg==='webhooks'&&segments[1]==='stripe') response=await handleStripeWebhook(request,env);
    else                                             response=json({error:'Not found'},404);
  } catch(err) { console.error('API error:',err); response=json({error:'Internal server error'},500); }
  const headers=new Headers(response.headers);
  for (const [k,v] of Object.entries(cors)) headers.set(k,v);
  return new Response(response.body,{status:response.status,headers});
}
