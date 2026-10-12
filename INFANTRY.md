# Robot Infantry — spec

## Status

Implemented (commits dcb151a…b3493e5, then cannon ×0.4 and the fixes from
the infantry review). The rest of this file is the draft as written;
**DESIGN.md** describes the shipped game (Units, Combat, AI opponent,
Balance & pacing → *Infantry pass*, Last Stand, 3D view). Where the code
differs from the draft, and why:

- **Trooper Squad: 190 HP / 15 DPS** (draft 225 / 18). At the draft
  numbers Troopers beat Stingers by 0.48 cost for cost
  (`tools/balance.ts duels`), but Stingers are meant to handle infantry.
  Now Stingers win by 0.15 and Snipers by 0.37.
- **Rocket Squad: 210 HP, ×1.5 vs air** (draft 180, ×0.8). At the draft
  numbers they lost to Hornets by 0.59, because each bomb splashes several
  squads. Now they beat Hornets by 0.31 and Mastodons by 0.69; two Sniper
  shots still wipe one.
- **Cannon vs infantry ×0.4** (draft ×0.6). At ×0.6 Mastodons beat Troopers
  by 0.41 cost for cost, and any Trooper buff that closed the gap made
  Troopers beat Stingers again. At ×0.4 Mastodons only edge them out (+0.13,
  against +0.61–0.88 over vehicle armies) and lose hard to Rocket Squads
  (−0.69).
- **Every side starts with a Trooper Squad** beside its HQ (a later
  requirement): skirmish, Ops and the Last Stand defender. Air War (and the
  Sky Pirates op) keeps it but bans more infantry, the Assembly Bay and the
  Condor, which would fly the kept squad into the fight. Veterans ranks it
  like any other combat unit.
- **The Tech Lab** also accepts an Assembly Bay as its prerequisite.
- **AI personalities** were retuned around infantry and the starting
  squads. With infantry in, Rush fell to 16–26% and Boom and Ironclad rose
  to 72–76%. The fixes:
  - Rush keeps 5 harvesters (was 4) and builds its Bay second.
  - Balanced and Rush keep 25% and 40% of their army value in infantry.
  - Boom's Depot moves from 2nd to 4th in its build.
  - Ironclad attacks at 1400 (was 1500), with one Rocket Squad per Mastodon.
  - Air Swarm, Skyforce and (since the review fixes) Boom build a Bay for
    Rocket Squads once they see heavy armour.

  Every personality won 38–63% on the 4-seed `tools/pacing.ts` panel, and
  wins 39–63% after cannon ×0.4 and the review fixes (Boom 63%, Rush 41%,
  Skyforce 39%).
- **AI anti-air is weighed in Flak Crawlers**, so a Trooper Squad counts
  0.2. Counted as full anti-air, the starting squad kept calling off Air
  Swarm's opening raids.
- **Condor drops** repeat. Rush and Balanced fly them from 2:30, every 45 s,
  with up to 3 Condors a match, not just one. Since the review the AI
  boards only when it has a way in, calls a trip off on 30% damage or a
  landing zone that turns out held or under anti-air (setting the squads
  down at home), remembers the guards and anti-air it ran into for 90 s,
  and waits the full 90 s before rebuilding a lost Condor. Over 150 AI
  games it lands 87 drops: the dropped squads destroy about 11k scrap for
  about 11k of squads and 6k of Condors lost (only one lost loaded), so a
  drop costs about 1.5× what it takes: a harassment option. (The first version flew 216 trips, 40k destroyed for
  41k lost, by a count that took in its unloads at home, and kept flying
  back into the same anti-air.)
- **Last Stand:** each block of five waves plays four of the five themes
  before its boss, benched by seeded rules. A Bot Swarm stops at 30
  squads. Snipers are held to 15% of the budget and of the unit cap. The
  ground bosses bring Rocket Squads, and the Elite Strike Force Troopers too.
- **Rule details the draft left open:**
  - A Condor shot down over a building loses its passengers.
  - A drop snaps to the nearest spot within 6 tiles where squads can be set
    down 0.4 tiles clear of water, rock, buildings and the map's edge, a
    squad's width apart (bail-outs too); out over a big lake, to the nearest
    shore at any distance. Only a map with no ground refuses it. A move or
    stop order calls a drop off.
  - After a drop the Condor backs off 1.5 tiles the way it came and idles,
    so it doesn't hide its squads.
  - EMP pauses boarding and drops.
  - Concealment works apart from fog, so it holds under Clear Skies too.
  - Enemy vehicles drive straight through squads. Squads step aside only
    for a friendly vehicle on the move; a parked one shares the push, as
    two vehicles do, so a squad never gets pinned against it.
  - Ground units keep 0.4 tiles inside the map's edge.
  - What an enemy Condor carries is secret: its bay is drawn empty, and the
    inbound warning fires for any enemy Condor, loaded or not.
- **Done when:** met.
  - 38 tests in `tests/infantry.test.ts`, plus AI and Last Stand tests.
  - Win rates 39–63% on the 4-seed panel, 36–70% on the single-seed
    `tools/balance.ts matches` (re-measured after the review fixes; were
    38–63% and 36–66%).
  - The scripted beginner wins 100% on Easy (45/45), and 83% on Normal.
  - Every robot has a run cycle, and the Condor has an open bay and ramp.
  - Not a "Done when" item, but worth knowing: AI-vs-AI games now settle
    in a median of 10:25, just over DESIGN.md's 7–10 minute band (about
    half from cannon ×0.4, half from the review fixes).

## The draft spec

Draft. Adds three infantry squads and a flying transport. Numbers are
starting points for `tools/balance.ts`, written in `src/sim/balance.ts` units
(tiles, tiles/s, HP/s).

## Squad model

- A squad is **one sim unit** drawn as N robots. It has one HP pool, and a
  robot falls each time HP crosses a 1/N step.
- DPS scales with the robots still standing: `dps × alive / N`.
- One tap target, one squad-chip entry, and no extra pathing cost.
- New `UnitStats` field: `squad?: number` (the number of robots drawn).

## Armour and damage

New armour class **`infantry`** and new damage type **`precision`**.
Add an `infantry` column and a `precision` row to `DAMAGE_VS`:

| vs `infantry`  | kinetic | cannon | flak | missile | explosive | laser | precision |
|----------------|---------|--------|------|---------|-----------|-------|-----------|
| multiplier     | 1.0     | 0.6    | 1.25 | 0.7     | 1.3       | 0.7   | **3.0**   |

| `precision` vs | light | medium | heavy | structure |
|----------------|-------|--------|-------|-----------|
| multiplier     | 0.6   | 0.4    | 0.25  | 0.15      |

Mortars, Hornets (explosive) and Turrets and Stingers (kinetic) handle
infantry. Mastodons and Lancers are poor against them.

## Units

| | Trooper Squad | Rocket Squad | Sniper Team |
|---|---|---|---|
| Role (tooltip) | Cheap rifle bots. Hit ground and air. Take cover in woods. | Anti-armour rockets. Kill Mastodons and Hornets. Weak vs infantry. | Long-range marksmen. Delete infantry. Useless vs vehicles. |
| Robots | 5 | 3 | 2 |
| Cost | 100 | 175 | 200 |
| HP | 225 | 180 | 120 |
| Speed | 1.8 | 1.6 | 1.7 |
| Sight | 5 | 6 | 8 |
| Targets | both (airMult 0.5) | both (airMult 0.8) | ground |
| DPS / range | 18 / 3 | 26 / 4 | 20 / 7 |
| Shot interval | 0.4 | 1.5 | 2.5 (50 per shot, 150 vs infantry) |
| Damage type | kinetic | cannon (fx: rockets) | precision |
| Splash | – | – | – |
| Build time | 6 | 9 | 10 |
| Built at | Assembly Bay | Assembly Bay | Assembly Bay, requires Tech Lab |
| Radius | 0.4 | 0.4 | 0.35 |

One Sniper shot removes about three Trooper robots. Two shots wipe a Rocket Squad.

## Transport — Condor

| | Condor |
|---|---|
| Role (tooltip) | Dropship. Carries two infantry squads over anything. Unarmed. |
| Domain / armour | air / medium |
| Cost / HP | 200 / 400 |
| Speed / sight | 3.6 / 6 |
| Weapon | none |
| Capacity | 2 squads |
| Built at | Airpad |

- **Board:** select infantry and tap a Condor, or tap infantry while a
  Condor is selected. Boarding takes 1 s once the squad is adjacent.
- **Unload:** an **Unload** chip in the command bar, or move with a
  long-press to fly there and drop. The Condor hovers for 1.5 s and can't
  drop onto Water or Rock. It picks the nearest walkable tile.
- **Shot down:** passengers bail out at 50% HP if it's over walkable ground,
  and are lost otherwise.
- Passengers are hidden, can't fire, and don't count toward vision.

## Assembly Bay (new building)

| Cost | HP | Size | Build time | Requires | Sight |
|---|---|---|---|---|---|
| 250 | 700 | 2 | 15 | – | 4 |

Role: "Builds robot infantry."

## Infantry rules

- **Terrain:** move at full speed through Woods and Rough. Shallows ×0.8.
  Water and Rock are impassable. Woods cover is **0.5** for infantry,
  against 0.7 for vehicles.
- **Sniper concealment:** a Sniper Team in Woods is only visible to enemies
  within 3 tiles, until 2 s after it fires.
- **Crushing:** a Mastodon moving through a squad deals 30 HP/s to it.
  Infantry step aside from friendly vehicles.
- **Uplinks:** infantry capture 2× faster.
- **Crates:** infantry can pick up supply crates.
- **Salvage:** infantry leave no wrecks.
- **Veterancy:** same as other units.

## AI

- **Counters:** add infantry to the seen-composition tallies (`seenInfantry`).
  Answer with Mortars, Turrets or a Sniper Team, and answer Mastodons with
  Rocket Squads.
- **Build orders:** Balanced adds an Assembly Bay after its Tech Lab. Rush
  opens with Troopers. Ironclad pairs Mastodons with Rocket escorts.
- **Condor:** Rush and Balanced send one loaded Condor at harvester lines
  as a harass option (every personality under Airborne or Infantry War).
  With every harvester line covered by anti-air, an assault under way gets
  the squads flown up behind the wave instead.
- **Easy:** no Snipers and no Condor drops.

## Last Stand

- New wave theme, **Bot Swarm**: Troopers and Rockets, with Snipers from wave 6.
- Infantry squads count once toward the 30-unit cap.

## Done when

- Unit tests cover squad DPS scaling, precision damage, boarding and
  unloading, bail-outs and crushing.
- AI-vs-AI personality win rates stay between 25% and 75% (`tools/balance.ts`).
- The scripted beginner still wins at least 85% on Easy (`tools/beginner.ts`).
- 3D models: walking cycle for each bot, plus a Condor with a visible bay.
