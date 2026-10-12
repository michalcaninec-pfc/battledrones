# Goliath — spec

## Status

A proposal. None of it is built. The Goliath is a giant walking mech that
works as a **mobile base**: it takes harvested scrap, lets you build far from
home and trains infantry, while fighting with weapons it loses one by one as
it takes damage. It is built at a new top-of-the-tree building, the
**Gantry**.

> **Every number in this spec is a starting point, not a commitment.**
> Costs, HP, timings, ranges, thresholds, weapon strength and speeds all live
> in `src/sim/balance.ts` and are to be tuned for balance through automated
> playtesting (see *Balancing and playtesting*).

**Out of scope for now:**

- **LLM command.** Agent battles (`AGENT-BATTLES.md`) and the
  `llm-tools-battledrones` plugin don't need to know about Goliaths yet.
- **Replay compatibility.** Battle records made before the Titan → Mastodon
  rename may stop replaying correctly. Tying replays to tagged versions of
  the game will be solved separately.

## Naming

- **Goliath**: the giant mech.
- **Mastodon**: the old Titan tank, renamed so the two aren't confused. The
  rename is everywhere: UI, docs, AI, voice lines and the internal unit id.

## The Gantry

- **Prerequisites:** a Fab Plant, an Airpad, a Tech Lab **and** an Assembly
  Bay. A building's `requires` list means "any one of these" today
  (`src/sim/economy.ts`); the Gantry needs "all of these".
- **One Gantry per side.**
- **Always visible to the enemy**, through fog and on the minimap: it's a
  big building. That includes the Goliath taking shape on it.
- **Builds Goliaths**, which walk out when finished.
- **Visual stages** show the build's progress:
  1. **Empty:** bare scaffold, crane folded, floor lights off.
  2. **Foundation (0–25%):** feet and legs bolted to the cradle, welding
     sparks, the crane starts working.
  3. **Frame (25–50%):** hip and torso skeleton, armour plates lowered in by
     the crane.
  4. **Armament (50–75%):** torso plated, arm cannons and shoulder mortars
     mounted.
  5. **Finishing (75–99%):** head mounted, eye still dark, team panels on,
     steam venting, lights blinking.
  6. **Rollout:** the eye lights up, the scaffold arms swing clear and the
     Goliath walks out; the Gantry returns to Empty.
- **Warnings to the enemy:** "Enemy Goliath in production" when a build
  starts, "Enemy Goliath nearly complete" near the end, and "Enemy Goliath
  on the field" at rollout.
- **Destroyed mid-build:** the progress is lost, and scrap scatters around
  the Gantry in proportion to how far the build had got.

## Walking and anchored

The Goliath has two modes, and switching between them takes time.

- **Walking:** moves and fights. No scrap drop-off, no building nearby, no
  training.
- **Anchored:** a scrap drop-off for harvesters, building is allowed within
  3 tiles of it, and it trains infantry squads (only while anchored). It
  fires normally while anchored.
- **Where it can anchor:** anywhere a building could be placed (buildable
  ground, no building or unit in the way), with no build-range requirement.
- **Anchoring animation:** the body lowers on hydraulics, the legs splay and
  stabilizer spikes drive into the ground with dust and a small camera
  shake; a scrap hopper and crane arm unfold, and the build ring pulses out
  across the ground in team colour.
- **Packing up:** the same in reverse, with steam and the spikes pulling
  free, and a progress arc showing when it can move. Packing up is slower
  than anchoring, so leaving under fire is the risky moment.
- **Harvesters** bound for a Goliath reroute to the nearest other drop-off
  as soon as it starts packing up.

## Building near it: outposts

- Any building **except an HQ** can be placed within 3 tiles of an anchored
  Goliath, even far from your base.
- Buildings placed this way are **outposts**. They never count as base for
  build range (`inBuildRange` in `src/sim/placement.ts`), so nothing can be
  built off them unless a Goliath anchors nearby again.
- Outposts stay and keep working after the Goliath moves on: an outpost
  Depot still takes harvester scrap.
- A building placed inside normal base range is a normal building, even if
  a Goliath is nearby. This is decided when the building is placed.

## Weapons, damage and repair

- **Weapons:**
  - two shoulder **mortars** (explosive, like the Mortar)
  - an **eye laser** (laser, like the Lancer)
  - two **arm cannons** (cannon, like the Mastodon)
  - **machine guns** (kinetic, like a Trooper Squad, and they hit air too)
- **Damage stages:** as its health falls it loses the **mortars** first,
  then the **laser**, then the **arm cannons**. The **machine guns always
  work**, so it is never helpless against aircraft or infantry. Losing its
  long-range mortars first means a damaged Goliath can no longer shell a
  base, and its reach visibly shrinks as it weakens.
- **Repair:** only **Menders** repair a Goliath (no Field Repair crate, no
  veteran self-repair). Repairing it brings lost weapons back, each after a
  short reboot you can see (the eye relights, the mortar tubes cycle) and a
  little above the health where it went offline, so weapons don't flicker
  on and off at the line.
- **It takes 2–3 Menders working on it to make real progress.** That's
  intended: a cloud of Menders around a hurt Goliath, and an enemy trying to
  shoot them down. The Mender AI (`src/sim/ai/menders.ts`) favours a Goliath
  with a weapon offline or about to come back.
- **EMP** freezes Menders like anything else, and blocks repair on a Goliath
  while it lasts.
- **Readability:** threshold marks on its health bar; damage you can see per
  weapon (a smoking shoulder, a dark eye, drooping arms); a threat-range
  ring that shrinks as weapons go; radio lines like "Goliath anchored",
  "Enemy Goliath digging in" and "Enemy Goliath: mortars down!"

## Sight and visibility

- A Goliath sees further than any other unit.
- It is **always visible to the enemy**, through fog and on the minimap. It
  can't hide.

## Two-Condor lift

- **Two Condors** can carry a walking (not anchored) Goliath together.
- **Controls:** select two empty Condors and tap the Goliath to hook on,
  then long-press a destination.
- **In flight** they move slowly, and only the Goliath's machine guns fire.
- **If either Condor is shot down**, the Goliath drops: over land it lands
  heavily damaged; over water, sea, lava or rock it is destroyed (as squads
  in a downed Condor are today).
- **No special island rules:** on the Archipelago, a Goliath lifted onto an
  island can anchor and train squads there like anywhere else.

## Multiple Goliaths and defeat

- A side can have **several Goliaths**. Each costs **25% more for every
  Goliath that side already has**, so replacing a lost one isn't penalised.
- **Defeat:** today a side loses when its HQ falls (`src/sim/combat.ts`).
  With Goliaths, a side is defeated only when its **HQ and all its Goliaths**
  are destroyed.
- **After the HQ falls** you can still build, near an anchored Goliath and
  in range of your surviving buildings. You can't rebuild an HQ.

## Death

- A destroyed Goliath **topples** visibly. The fall deals no damage.
- It leaves its salvage **scattered over a wide area** in several scrap
  piles, not as one wreck, so collecting all of it means holding the ground.

## Starting numbers

All of these are expected to change in tuning.

| | Starting value |
|---|---|
| Goliath cost | ~1,600 scrap, +25% for each Goliath already owned |
| Goliath HP | ~3,000 (an HQ has 3,200) |
| Goliath build time | ~60 s |
| Goliath sight | 10 tiles (the best unit today has 9; Radar 13) |
| Weapon strength | mortars ≈ 2 Mortars, laser ≈ 1 Lancer, cannons ≈ 1 Mastodon, machine guns ≈ 1 Trooper Squad (≈ 1,400 scrap of firepower in all) |
| Weapons lost | mortars below 75% HP, laser below 50%, cannons below 25% |
| Weapons restored | ~5% above the threshold where each was lost, after a 2–3 s reboot |
| Anchor / pack up | ~4 s / ~6 s |
| Build ring | 3 tiles |
| Lift speed | ~½ Condor speed |
| Lift drop over land | ~25% of max HP |
| Death salvage | 6–8 piles across ~5 tiles |
| Gantry | 3×3, ~600 scrap, ~25 s to build, ~1,200 HP |

## Balancing and playtesting

**Every value above is flexible.** Tune them with the existing headless
harness, `tools/balance.ts`:

- `duels`: a Goliath against cost-equal groups of each unit. Rocket Squads,
  Wasps, Lancers and Hornets should all be real answers to it.
- `matches`: AI-vs-AI round robins on every map.
- `--tune '{...}'`: A/B runs that override any exported balance number.
- `tools/pacing-match.ts` for match pacing.

**The AI has to use Goliaths before automated playtesting means anything.**
The AI commander needs to:

- decide when to build the Gantry
- anchor Goliaths at distant fields and build outposts
- escort them with Menders and anti-air
- use the two-Condor lift
- hunt enemy Goliaths

**What to measure:**

- How much a Goliath shifts win rates, and on which maps.
- When the first Goliath appears in a match.
- Match length, and whether "not defeated while a Goliath lives" drags out
  games that are already lost.
- How often Goliaths die compared with what they earn and kill first.
- Whether outposts make distant crystal fields worth taking.
