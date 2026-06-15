# The Inflictor — What the App Does

> Living summary of the app's purpose and features. Maintained as we work, so it's
> ready as a reference for the presentation/demo video. Updated 2026-06-14.

## In one line
**The Inflictor** is a desktop app that helps you plan, run, and stick to a daily
routine — a structured "performance" of your day — celebrating what you achieve
without punishing the off days.

## Theme & voice
A theatrical "stage / performance" motif throughout: you "Prepare the Stage,"
set the "Acts of the Day," and "Enter the Stage." Language has an archaic,
encouraging flourish ("Set thy week's programme," "The programme is bare").

## Platform
- **Desktop app for Windows** (Electron wrapper).
- Backed by a **Cloudflare** service (Pages/Workers + a D1 database) for accounts,
  saving your schedule, and syncing your data.

## Core idea
You lay out a **weekly schedule** of timed activities ("Acts"), each with a name,
duration, colour, and optional end-of-activity chime. As the day unfolds you mark
each activity **completed** or **not completed**. The app celebrates achievement
and is deliberately gentle about off days.

## Main features
1. **Accounts** — register, log in, guest mode, password reset; export or delete
   your data. Stays logged in between sessions.
2. **Weekly planner** — a 7-day week view; each day is a column showing its
   activities as time-proportional "slots."
3. **Build your schedule ("Prepare the Stage")** — add acts (name, duration in
   hours/minutes, colour, end-chime on/off) and apply them to chosen days
   (All / Weekdays / None, or pick individual days).
4. **Edit anywhere** — edit a whole day from its header, or jump straight to a
   single activity via its own edit button.
5. **Track progress** — mark each act **completed** (turns green, confetti, happy
   sound) or **not completed** (records it without a heavy penalty).
6. **"Sometime Today"** — an untimed to-do area on each day for things without a
   fixed slot.
7. **Pause & restart the day** — if life interrupts you mid-schedule, you can pause;
   when you restart, the day's timings shift to your new start and a **crowd cheer**
   welcomes you back.
8. **Notifications & chimes** — optional end-of-activity chimes/reminders (with
   repeat options).
9. **Daily notes** — a free-text note on each day.
10. **History ("Thy Ledger")** — a record of past completions/misses.
11. **Offline support** — if the connection drops, changes are saved locally and
    sync automatically when you're back online.
12. **Personalisation** — light/dark themes plus premium themes (Crimson, Gilded,
    Sapphire), and font choices (Classical, Modern, Romantic).
13. **Premium / subscription** — premium themes & fonts unlocked via a subscription
    (Stripe), including trial handling.

## Sounds (and what they mean)
- **Crowd cheer** (`crowd.mp3`) — plays when you **restart the day after pausing**;
  an encouraging "welcome back."
- **Chime** (`chime.mp3`) — plays when you mark an activity **completed** (with
  confetti); also used for end-of-activity chimes.
- **"Aww"** (`uncheck.mp3`) — plays when an activity is marked **not completed**
  (and when un-checking). *(Being made independently switchable from the cheers.)*

## Design philosophy notes
- **Celebrate, don't punish.** Completions are rewarded (green, confetti, sound);
  "not completed" is recorded but kept visually neutral — no standing red box.
- Sound encouragement is being split so a user can keep the positive feedback while
  turning off the negative, if they find it discouraging.

---
*Maintainer note: keep this updated as features are fixed/added during beta prep.*
