# The Inflictor — TODO

Running list of things to do during beta prep. Newest items welcome at the bottom;
move finished items to **Done**.

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
