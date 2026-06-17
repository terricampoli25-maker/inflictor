# The Inflictor — TODO

Running list of things to do during beta prep. Newest items welcome at the bottom;
move finished items to **Done**.

## WORKFLOW (user, 2026-06-14): one bug at a time, found through testing.
User will test, report a single bug, we fix + verify that one, then next. No batch runs.

## ✅ CURRENT STATE — 2026-06-17, build 1.0.9 (user is doing a full test pass)
Everything from the 2026-06-16/17 batches is BUILT, and the backend is DEPLOYED to production.
Shipped & live in **1.0.9**:
- Pause→"Pause Activities Now", "Woke up today at", tutorial "two kinds of pause" (1.0.4)
- Day-persistence fix — customized days survive a whole-week save (1.0.5)
- Sustenance 🍴 type (splits the host activity into two boxes) + chronological auto-sort (1.0.7)
- Single-activity ✎ editor + "app as a record" (1.0.3)
- **Memo sync + pause-memo** — memos & pause notes persist server-side (1.0.8, deploy #1)
- **Sound prefs + profile picture sync** (1.0.9, deploy #2) → "everything persists" essentially done
- Reset-today button REMOVED (user rejected); ✕ Cancel clears a stuck pause-shift instead
- Tutorial kept current both tabs throughout

OPEN / FUTURE (not blocking beta):
- `scheduleNotifs` still uses OLD uniform-pauseOffset (should use `computeDayTimes`) — low impact, notifs usually off
- No "reset a customized day back to the week default" path (once custom, stays custom)
- Dead code to prune someday: `anytimeItems`/`renderAnytime` (free-text Sometime-Today, never rendered)
- Bundle fonts locally (Google Fonts dependency); auto-updater (electron-updater) so testers don't reinstall
- GIT: nothing committed/pushed this whole run; the DEPLOYED backend is NOT in git history yet — user may want a checkpoint
- DEPLOY RECIPE: `NODE_OPTIONS=--use-system-ca` + wrangler (already logged in) + deploy a CLEAN /tmp staging dir (NEVER `.`) to branch **fresh-main**

## Up next / open  — BATCH from user 2026-06-16 (no longer worked in order — see workflow above)

> **UPDATE 2026-06-16 (post-1.0.3):** User rejected the "↺ Reset today's times" button — said
> it was added without being asked and is redundant (you can fix via editing the day). REMOVED
> it entirely (markup/CSS/`resetToday`/render-hook/export). Folded its only useful bit into the
> **✕ Cancel** on the pause bar: `cancelPause` now also zeroes `pauseOffset`/`pauseAnchorId` +
> clears their localStorage keys, so a mistaken pause/resume (and its spillover) still reverts.
> ALSO: user saw "API Error: Unable to connect to API (ECONNRESET)" — confirmed that exact string
> is NOT anywhere in the project source → it's server/network-side (transient connection reset),
> triggered by my repeated `taskkill electron` cutting in-flight requests. NOT a code bug; no fix.
> These changes + the Shakespearean tutorial amp-up + "Static" wording fix are IN SOURCE but NOT
> in the 1.0.3 exe — next installer (1.0.4) folds them in.

> **STATUS 2026-06-16:** The three offset bugs (#4 spillover reset, #6 resume-from-moment,
> per-activity retroactive pause) were BUILT TOGETHER and are IN LIVE TESTING with the user.
> Implementation: `computeDayTimes` now takes `(acts, wakeOff, pauseOff, anchorId)` — wake
> shifts all flexibles, pause shifts only the anchor activity onward; `beginAgain` anchors on
> the resumed activity's displayed start; per-activity Pause box reveals the Resuming bar +
> dims from the anchor onward; new `resetToday()` + "↺ Reset today's times" button clears the
> sticky offsets; `cancelPause` wired to a ✕. NEW persisted key: `inflictor_pause_anchor_<date>`.
> KNOWN FOLLOW-UP: `scheduleNotifs` (~1438) still uses the OLD uniform-pauseOffset logic — make
> it use `computeDayTimes` once the visible behavior is confirmed. Awaiting user's live results.
- [x] **BUG: whole-week save wipes individual day customizations** — FIXED 2026-06-17 (in 1.0.5).
      This was the real form of the "Prepare Week loses input" bug. Repro: set week → customize
      Sat/Sun individually → reopen Prepare Week, tweak something, Set the Stage → Sat/Sun got
      overwritten because the week-save rewrote ALL 10 day-overrides from the template. FIX:
      single-day edits (day pencil + ✎ editor) now mark the day `custom:true` AND record the date
      in a localStorage set `inflictor_custom_days` (belt-and-suspenders vs backend dropping the
      flag). The whole-week save loop now SKIPS any day in `customDays` / flagged custom — so a
      customized day persists until the user edits THAT day again. Tutorial §2 updated (both tabs).
      TRANSITION CAVEAT: days customized in ≤1.0.4 have no flag/record, so they get overwritten
      ONE more time after upgrading — user must re-do Sat/Sun once on 1.0.5, then permanent.
      FUTURE: no "reset this day back to the week default" path yet (once custom, stays custom).
- [x] **The app is a RECORD, not just a forward schedule.** DONE 06-16 (in 1.0.3). Covered by:
      the day-header pencil already edits ANY date (past/present/future) and saves a per-date
      override (add/remove/reorder/wake time); PLUS the new single-activity ✎ editor below for
      quick "edit one activity after the fact" (durations/times, e.g. "chores took an hour").
      Adding a forgotten activity = day-header pencil → add. Moving = day editor ↑/↓.

- [x] **Re-add a per-activity EDIT button** — DONE 06-16 (in 1.0.3). ✎ button in the corner of
      every slot + anytime item → `openActEdit(ds,id)` opens a small modal (name, timing
      toggle, start/end OR duration+~ish) that edits ONLY that activity and saves as a per-date
      override (that day only). Remove button included. NOT the whole-day editor.
      Original resume notes (now implemented):
      - Each slot is built in `renderCol()` (index.html ~1563). The slot-indicators row
        (~1565-1571) currently has: Memo `M`, complete/fail checkboxes, and the Pause box.
        Add a small ✎ edit button here, `onclick="Planner.openActEdit('${ds}','${act.id}')"`.
      - Build a NEW small modal (clone the `memo-overlay` pattern — search `memo-overlay`,
        ~line with `id="memo-overlay"`) with fields: name, hours+mins (duration), timing
        toggle (fixed/flexible/anytime), and the time inputs that apply per timing. Reuse
        the timing-toggle markup from the day setup box (`openSetup`, ~1755).
      - SAVE: per the user's decision, a single-day edit = THAT DAY ONLY → write a per-date
        override. i.e. take `getDaySchedule(ds)`, replace the one activity, and
        `api('day', {date: ds, activities: [...]})` (confirm the exact day-override endpoint
        used in saveSetup's per-day branch, ~1820-1835) then update `weekData.dailyOverrides[ds]`
        in memory and `render()`. Do NOT touch `weekData.schedule` (the recurring template).

- [ ] **BUG: spillover doesn't revert when time changed back.** REPRO CONFIRMED by user
      2026-06-16: BOTH pause→restart AND waking-late produce stuck spillover, "same result."
      DIAGNOSIS (one root cause, not two): `spilloverItems()` (~1502) keys off
      `offset = wakeOffset + pauseOffset`. **`pauseOffset` is sticky for the whole day and
      nothing clears it** — `beginAgain()` (~1638/1661) writes it to
      `localStorage 'inflictor_pause_offset_<date>'` then HIDES the "Resuming at" bar, so there's
      no UI left to dial it back down. And because it persists, the later wake-late test still had
      that old pauseOffset underneath → `offset` stayed >0 no matter the wake time → "same result."
      FIX (next session, verify with user): give the day's offset a clean reset —
      (a) `cancelPause()` (~1623) should also reset `pauseOffset=0` + remove the localStorage key;
      (b) expose a way to clear/redo a restart after Begin Again was pressed (the bar is gone);
      (c) make sure reverting the wake bar to the scheduled time truly reaches offset 0.
      Entangled with the #6 / per-activity-pause anchor work — do them together.

- [x] **Pause rename + tutorial** — DONE 06-16. Main button now "⏸ Pause Activities Now"
      (~528). Tutorial (both Plain + Shakespearean) has a "Two kinds of Pause" block framed
      as live/now (main) vs after-the-fact (per-activity). ⚠️ The per-activity *retroactive
      behavior itself is NOT built yet* (next item) — tutorial words are deliberately about
      PURPOSE, not mechanics, so they aren't a lie. Tighten wording once behavior lands.

- [ ] **Per-activity pause = retroactive behavior.** DESIGN AGREED with user 2026-06-16:
      - The per-activity **Pause box marks the ANCHOR** — "I stopped at this activity." Can be
        ticked in the moment OR after the fact (e.g. napped through Music, tick it on waking).
        Same code path either way; no separate "retroactive" mode.
      - **Begin Again (main page) = WHEN you resumed.** Entering the time shifts the activities
        **from the paused activity onward** so the PAUSED activity itself starts at the
        Begin-Again time (it slides, it is NOT skipped); later acts follow. Activities BEFORE
        the anchor are untouched.
      - **No Begin-Again time entered = never resumed → day ENDS at the pause.** Activities
        after the anchor do NOT shift and do NOT get done — they stay dimmed/paused-looking
        (not marked failed). User "packed it in."
      - IMPL: this is a "from activity X onward" shift, so the uniform `pauseOffset` in
        `computeDayTimes` (~1322) is NOT enough. Need an anchor index: only acts at/after the
        paused index get `offset = beginAgainMin - displayedStart(anchor)`. Acts before = 0.
        `beginAgain()` (~1638) should compute the offset from the ANCHOR activity's displayed
        `fixed_start` (ties into the #6 fix below — same root cause). If multiple activities are
        paused, the EARLIEST paused index is the anchor.

- [ ] **BUG: resume/woke-up restart from CURRENT MOMENT** — LIKELY ROOT CAUSE FOUND (06-16,
      unverified): in `beginAgain()` (~1638) `firstActiveMs` is computed as
      `wakeBase + Σ(durations of completed/failed/paused acts)` — i.e. a CUMULATIVE-DURATION
      position. But the displayed time of each flexible activity is `parseTime(fixed_start) +
      (wakeOffset+pauseOffset)` (see `computeDayTimes` ~1321-1325). When an activity's explicit
      `fixed_start` differs from its cumulative-duration slot, resume anchors to the wrong base,
      so the next activity lands "hours away." FIX (proposed): anchor resume on the first active
      flexible activity's DISPLAYED start, i.e.
      `pauseOffset = resumeMinutes - parseTime(X.fixed_start) - wakeOffset`. Only meaningful for
      flexible acts with a `fixed_start`. Verify against a real schedule before shipping — this
      changes resume semantics and is entangled with the per-activity-pause item above.

- [x] **Rename "Woke up at" → "Woke up today at"** — DONE 06-16 (~532, plus tutorial §5 both tabs).
- [ ] Icons: user already updated them (transparent bg → leaf on the toolbar). Will be in
      the next installer build.

## Up next / open
- [ ] **Bundle fonts locally** (Cinzel/Crimson Text/etc.). Currently loaded from Google
      Fonts over the internet (`fonts.googleapis.com`) — fragile for a desktop app
      (offline testers lose them) and the likely cause of the "capital O fades at the
      bottom" rendering. Download + self-host the .woff2 files in the app.
- [ ] **Profile picture upload.** Let users upload a photo where their name/avatar
      shows (currently a coloured initial circle). Needs image storage (likely upload
      to the Cloudflare backend so it follows the account). NOTE: Premium section
      already advertises "a profile avatar" — decide if this is a premium feature.
- [ ] **Schedule/timing behavior — build per SCHEDULE-DESIGN.md.** Full sketch is in
      that file (Fixed start+end, Flexible "-ish" goal times, Anytime→Sometime Today,
      overrun via pause/resume recalc, next-day-only spillover). Phases 2–6 there.
- [ ] **When everything's done, ramp up the Shakespearean tutorial** — rewrite the
      Shakespearean tab to lean hard into the Bard's voice, just for fun. (Keep the
      Plain Speak tab clear and literal.)
- [ ] **Keep the in-app tutorial updated.** Settings → "How To" → Open the Tutorial
      (the `sv-guide` view in index.html). Update it whenever features change.
- [ ] **Add the Adjust/Static choice to the setup box.** Removed from the main page
      (confused the user); it WILL live in the setup pop-up box instead. After adding
      it there, update the tutorial's "Static" wording (both Plain + Shakespearean) to
      match — currently the tutorial still describes Static on the main bar.
- [ ] **Activity memos → server-synced later.** Per-activity memos are saved
      on-device (localStorage) for now; move to the Cloudflare backend later so
      they sync across devices for subscribed users. (Day notes already sync.)
- [ ] **Sound prefs → server-synced (Option B).** Cheers/Awws toggles are currently
      saved on-device (localStorage). Later, sync them across devices via the
      Cloudflare backend (needs a `settings` table column + redeploy).
- [ ] **Auto-updater for subscribers.** Add `electron-updater` (likely with GitHub
      Releases) so beta testers/subscribers get updates automatically instead of
      reinstalling. (See app architecture: UI is bundled in the installer, so today
      UI changes require a new install.)
- [ ] **Remove diagnostic logging** once everything's confirmed stable: the `[DIAG]`
      console logs in `index.html` (login/checkAuth/Settings.open) and the renderer
      console forwarder in `desktop/main.js`. (Keep the `[PROXY ERROR]` log — useful.)
- [ ] **Optional UX: warn on "Dismiss" with unsaved changes** in the day editor, so
      removals/edits aren't silently lost.

## Done
- [x] Login "offline" fixed (TLS cert interception via VPN/AV — proxy now uses
      Electron net + strips compression headers).
- [x] Login persistence + Settings opening fixed (same compression-header root cause).
- [x] Day-header edit pencil always visible.
- [x] Per-activity edit buttons (jump to + highlight the activity).
- [x] A day can now be emptied / last activity removed.
- [x] "Not completed" no longer paints the slot red.
