// The Inflictor — scheduled report cron worker
// Runs hourly (see wrangler.toml crons). For each user who opted into daily/weekly
// report emails, computes their report (meal time carved out of its host activity,
// + calories + done/missed) and emails it via Resend at their local evening.
//
// Deliberately self-contained: computeReport + helpers mirror functions/api/[[route]].js.
// If you change the report math there, change it here too.

// ─── report computation (mirror of functions/api/[[route]].js) ───────────────
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
async function computeReport(db, uid, start, numDays, todayLocal) {
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
  // Per-activity completion: how many times each activity was COMPLETED out of how many times it was
  // scheduled, over days that have already happened. Grouped by name so a recurring activity tallies
  // across the week. Meals just add calories; meds stay private in the auto-email (only their with-food cals count).
  const agg = new Map();   // name -> { done, sched }
  let cal=0, totalDone=0, totalSched=0;
  for (const ds of dates) {
    if (todayLocal && ds > todayLocal) continue;                 // hasn't happened yet → not "supposed to" yet
    let acts;
    if (overrides[ds]) acts=overrides[ds].activities||[];
    else { const tmpl=templates[rptMonday(ds)], di=rptDayIdx(ds); acts=tmpl?(tmpl.activities||[]).filter(a=>!a.days||a.days[di]):[]; }
    for (const a of acts) {
      const st=status[`${ds}:${a.id}`]||status[`${ds}:${a.name}`], timing=a.timing||'flexible';
      const done = st==='completed';
      if (timing==='sustenance') { cal += cals[`${ds}:cal:${a.id}`]||0; continue; }
      if (timing==='med') { if (a.with_food) cal += cals[`${ds}:cal:${a.id}`]||0; continue; }
      const name=(a.name||'').trim()||'Untitled';
      const r=agg.get(name)||{done:0,sched:0}; r.sched++; if(done)r.done++; agg.set(name,r);
      totalSched++; if(done)totalDone++;
    }
  }
  const activities=[...agg.entries()].sort((a,b)=>a[0].localeCompare(b[0])).map(([name,v])=>({name,done:v.done,sched:v.sched}));
  return { start, days:numDays, total:{ calories:cal, done:totalDone, sched:totalSched }, activities };
}

// ─── email rendering ─────────────────────────────────────────────────────────
const esc = x => String(x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function fmtMin(m){ const h=Math.floor((m||0)/60), mm=(m||0)%60; return ((h?`${h}h `:'')+(mm?`${mm}m`:'')).trim()||'0m'; }
function prettyDate(ds){ const d=new Date(`${ds}T12:00:00Z`); return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'}); }
function renderReportHtml(rep, period){
  const t=rep.total||{};
  let rows='';
  for (const a of rep.activities||[]) {
    const short = a.done < a.sched;   // dim the ones not fully done
    rows+=`<li style="color:${short?'#e8d0a0':'#7ac77a'}">${esc(a.name)} — <b>${a.done}/${a.sched}</b></li>`;
  }
  const list = rows
    ? `<div style="margin:.8rem 0"><div style="color:#d4af37;font-weight:bold;border-bottom:1px solid #3a2410;padding-bottom:.2rem">Each activity — completed / scheduled</div><ul style="margin:.5rem 0;padding-left:1.2rem;line-height:1.8">${rows}</ul></div>`
    : '<p style="color:#a07840;font-style:italic;text-align:center;margin:1.5rem 0">Nothing logged this period — the stage was dark.</p>';
  return `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:2rem;background:#110800;color:#d4af37;border:1px solid #5a3010">
    <h1 style="text-align:center;letter-spacing:.1em;margin:0">THE INFLICTOR</h1>
    <p style="text-align:center;font-style:italic;color:#a07840;margin:.3rem 0 1.2rem">${esc(period)}</p>
    <div style="display:table;width:100%;text-align:center;background:#1a0f00;border:1px solid #3a2410;margin-bottom:1rem">
      <div style="display:table-row">
        <div style="display:table-cell;padding:.9rem"><div style="font-size:1.25rem;color:#7ac77a">${t.done||0}/${t.sched||0}</div><div style="font-size:.7rem;color:#a07840">completed</div></div>
        ${(t.calories||0)>0?`<div style="display:table-cell;padding:.9rem"><div style="font-size:1.25rem;color:#d4af37">${t.calories}</div><div style="font-size:.7rem;color:#a07840">calories</div></div>`:''}
      </div>
    </div>
    ${list}
    <p style="font-size:.72rem;color:#6a5030;text-align:center;margin-top:1.4rem">Sent from The Inflictor · ${esc(new Date().toDateString())}</p>
  </div>`;
}
async function sendReport(env, to, period, html){
  if (!env.RESEND_API_KEY) return { ok:false, detail:'no RESEND_API_KEY' };
  const res = await fetch('https://api.resend.com/emails', {
    method:'POST',
    headers:{ 'Authorization':`Bearer ${env.RESEND_API_KEY}`, 'Content-Type':'application/json' },
    body: JSON.stringify({ from: env.FROM_EMAIL||'The Inflictor <onboarding@resend.dev>', to, subject:`The Inflictor — ${period}`, html }),
  });
  if (!res.ok) return { ok:false, detail:(await res.text().catch(()=>'')).slice(0,200) };
  return { ok:true };
}

// ─── the run ─────────────────────────────────────────────────────────────────
// force=true ignores the local-hour/day gate (sends to every opted-in user now) — for testing.
async function runScheduledReports(env, force=false){
  const db = env.DB, nowUtc = Date.now();
  const rows = await db.prepare(`
    SELECT s.user_id, s.report_frequency, s.tz_offset, s.report_last_sent, u.email
    FROM settings s JOIN users u ON u.id = s.user_id
    WHERE s.report_frequency IN ('daily','weekly') AND u.email IS NOT NULL AND u.email <> ''
  `).all();
  const out = [];
  for (const r of rows.results||[]) {
    const offset = (r.tz_offset==null) ? 0 : r.tz_offset;          // JS getTimezoneOffset(): minutes local is behind UTC
    const local = new Date(nowUtc - offset*60000);
    const lh = local.getUTCHours(), ld = local.getUTCDay();         // 0=Sun
    const localDate = local.toISOString().split('T')[0];
    let due=false, start=localDate, numDays=1, period='';
    if (r.report_frequency==='daily') {
      due = lh>=21;                                                  // 9pm local or later (until midnight)
      period = `Daily report — ${prettyDate(localDate)}`;
    } else {
      due = (ld===0 && lh>=19);                                      // Sunday 7pm local or later
      start = rptMonday(localDate); numDays = 7;
      period = `Weekly report — week of ${prettyDate(start)}`;
    }
    if (force) { due=true; if (r.report_frequency!=='daily'){ start=rptMonday(localDate); numDays=7; } }
    if (!due) { out.push({user:r.user_id,freq:r.report_frequency,skipped:'not-due',localHour:lh}); continue; }
    if (r.report_last_sent===localDate && !force) { out.push({user:r.user_id,freq:r.report_frequency,skipped:'already-sent'}); continue; }
    const report = await computeReport(db, r.user_id, start, numDays, localDate);
    const html = renderReportHtml(report, period);
    const sent = await sendReport(env, r.email, period, html);
    if (sent.ok) await db.prepare('UPDATE settings SET report_last_sent=? WHERE user_id=?').bind(localDate, r.user_id).run();
    out.push({ user:r.user_id, freq:r.report_frequency, email:r.email, sent:sent.ok, detail:sent.detail });
  }
  return { ran:new Date().toISOString(), force, considered:(rows.results||[]).length, results:out };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledReports(env));
  },
  // Manual trigger for testing: GET /__run?key=<CRON_TEST_KEY>[&force=1]
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/__run') {
      if (!env.CRON_TEST_KEY || url.searchParams.get('key') !== env.CRON_TEST_KEY)
        return new Response('forbidden', { status:403 });
      const res = await runScheduledReports(env, url.searchParams.get('force')==='1');
      return new Response(JSON.stringify(res,null,1), { headers:{'content-type':'application/json'} });
    }
    return new Response('The Inflictor report cron — alive', { status:200 });
  },
};
