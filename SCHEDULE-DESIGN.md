# The Inflictor — Schedule & Timing Design (working sketch)

> Design for how Fixed / Flexible / Anytime activities work together. Sketched with
> the user 2026-06-15, to be refined in beta. Not all built yet — see "Phases".

## The three activity types

| Type | Set in the box | Behavior |
|---|---|---|
| **Fixed** | **start time + end time** (two boxes; duration = the gap) | Anchored to the clock. **Never auto-shifts.** Miss it = missed. To move it, the user edits it themselves. This is the whole point of the type — real commitments (appointments, meds). |
| **Flexible** | **duration** only (h/m) | Flows in sequence from wake time. **Shifts** when the user adjusts to their real wake time. Has a *goal* time, shown "-ish". |
| **Anytime** | (no time) | No set time — just needs doing that day. Flows into the existing **"Sometime Today"** list. |

## What each block shows on the planner (in the middle of its box)
- **Flexible** → goal time + length, e.g. **"9:00-ish · 1 hour"** (the goal time recomputes as the day flexes).
- **Fixed** → its range, e.g. **"1:00 to 1:30."**
- **Anytime** → **"no fixed time."**

So Flexible shows an *approximate* goal time ("-ish"); Fixed shows real clock times.
Exact label wording/format is the designer's call — **whatever looks clean and clear.**
The examples above are illustrative, not final.

## Behavior
- **Flexible** items cascade from (wake time + any wake-adjust offset); their goal times
  recompute as the day flexes. They flow **around** Fixed anchors.
- **Fixed** items hold their clock time no matter what; they do **not** move when the user
  wakes late / adjusts. Flexible flows around them.
- **Wake adjust** shifts the Flexible cascade, never Fixed.

## Overruns (running long)
- If an activity runs over, the user **pauses the next activity**; hitting **Resume**
  **recalculates the remainder of the day** from that point.
- Reuses the existing **Pause / Resume** engine — not built from scratch.

## Cross-day spillover
- A day that overruns can push into the **following day only**, which then adjusts.
- **Capped at one day.** Anything beyond the next day is the user's to handle manually.

## Anytime
- **Anytime = the existing "Sometime Today."** Activities marked Anytime drop into that
  section (currently a per-day localStorage list).
- They are **full activities**, same as any other — they can be **completed / not
  completed** and have a **memo** — they just have **no scheduled time**.
- They **may have an optional duration** ("sometime today I should walk for half an
  hour"), but it's not tied to any clock time.
- NOTE: the current Sometime-Today items have complete/not + pause but **no memo yet**,
  so Phase 2 needs to add the memo "M" to them for parity.

## Conflict reminders
- The user is mostly trusted to **see** conflicts themselves.
- BUT add a friendly **pop-up reminder** when a planned activity collides with a **Fixed**
  item — e.g. *"You can't swim 10:00–11:00 — your doctor's appointment is at 10:30."*
- Tone: **helpful, not punishing.** A heads-up, never a block.
- **Look & behavior:**
  - A **centered modal**, on top of everything (highest z-index), with a dimmed backdrop.
  - A **blue exclamation mark** (not red — info/heads-up, not alarm; matches the blue-M
    "celebrate, don't punish" feel).
  - The message text, then a single **"OK"** button to dismiss.

## Resolved
- **Anytime duration:** optional length allowed, not tied to a clock time. ✅
- **Fixed overrun edge:** handled by the **conflict reminder** — when a planned activity
  would run into a Fixed item's time, the pop-up catches it. The same mechanism flags two
  overlapping Fixed items (or we trust the user to spot it). ✅

## Open questions (minor, settle while building)
- Exact look/placement of the conflict pop-up and the gap rendering between blocks.

## Setup-box UX (from user feedback after Phase 2)
- **Per-activity day selection.** Move the day picker OUT of the single bottom "Apply to"
  section and INTO each activity's box, so each activity carries its **own** days. Reasons:
  the global picker gets pushed down as activities are added; and different activities want
  different days (e.g. **chores Sunday-only**, workout weekdays). This also explains
  "chores didn't appear on Sunday" — currently all activities share one day-set.
  - Bake in: **stronger highlight** for chosen days, and the **10 day pills on one line**.
  - Data impact: each activity stores `days`; saving builds each day's schedule from the
    activities whose `days` include it (maps onto existing per-date day-overrides).
### Time inputs in the box (Phase 3 detail)
- **Three linked fields — set any TWO, the third auto-computes:**
  - start + end → **duration** (4:20→5:40 = 1h20m)
  - start + duration → **end** (4:20 + 1h20m = 5:40)
  - Fixed uses start+end (pinned). Flexible uses duration with a computed start.
- **Sensible default times — no random noon/PM.** New activity times follow the cascade from
  the **wake time**: up at 4:00 → first activity defaults to ~4:00 **AM** (not 4:00 PM),
  because logically you're not working out at 4:20 PM. User can change it.
- **Cascade auto-fill:** the next activity's **start auto-fills to the previous activity's
  end** (5:40); the user can override. Editing one activity re-flows the rest.
- **Fixed = start time + END time** (two boxes: "start 1:00, finish 2:00").

## Build phases (supersedes the earlier simple Step 1 plan)
1. ✅ **Done:** type choice + storage in the box (Fixed/Flexible/Anytime + a Fixed time).
2. **Anytime → "Sometime Today"** (box-created anytime activities flow there).
3. **Fixed start+end inputs** in the box; **planner shows the per-type labels**
   (fixed range, flexible "-ish" goal time, anytime label); flexible cascade computes
   goal times around fixed anchors.
4. **Conflict reminder** pop-up (planned activity vs. a Fixed item) — helpful, not punishing.
5. **Overrun handling** via Pause/Resume recalculation (may largely exist already).
6. **Cross-day (next-day-only) spillover.**
7. **Update the tutorial** to explain the three types.
