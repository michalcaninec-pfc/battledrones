# Battle Drones — Design

A mobile-friendly real-time strategy game in the Command & Conquer tradition.
Two armies of drones — flying and ground-based — battle for territory and
resources. Single-player skirmish against an AI commander (or watch two AIs
fight), playable in a mobile browser and installable as a PWA.

This document started as the MVP design (6 units, 4 buildings, one map);
the v2 overhaul expanded it to 11 units, 8 buildings, 5 maps across 4
biomes with gameplay-relevant terrain, a damage/armor model, AI
personalities and difficulty levels, painted art and procedural audio.

## Design pillars

1. **Readable at phone size.** Every unit, building, and state must be
   identifiable on a 6" screen. Big touch targets, high-contrast sprites,
   minimal chrome.
2. **A full match in a coffee break.** Target match length ~10 minutes
   against a human (AI-vs-AI games settle in a median of ~8¼; see Balance
   & pacing).
3. **Air vs ground is the core tension.** The rock-paper-scissors between
   flying and ground drones is what makes this game *Battle Drones* and not
   a generic RTS. Every roster and map decision should feed it.

## Locked-in decisions

| Decision | Choice |
|---|---|
| Platform | Web PWA — TypeScript, three.js (WebGL), rendered at device pixel ratio (≤ 2×, adaptive) |
| Opponent | Single-player vs scripted AI (6 personalities × 3 difficulties), AI vs AI spectator, Last Stand waves, or the Ops campaign |
| Core mechanics | Resource harvesting, base building, tech tree, fog of war, terrain |
| Win condition | Destroy the enemy HQ (Last Stand: survive as many waves as you can; Ops: the op's objective) |
| Roster size | 11 units, 8 buildings |
| Art | Procedural low-poly 3D models; painted terrain (OpenAI `gpt-image-2.5-sunburst`, see ART.md) draped over a 3D heightfield |
| Controls | Full-screen touch-first (mouse also supported); portrait and landscape both first-class |

## Tech stack

- **Language:** TypeScript, strict mode.
- **Engine:** [three.js](https://threejs.org/) for WebGL rendering, with a
  small purpose-built layer on top (`src/game/three/`, see **3D view**
  below): camera rig, procedural models, terrain, particles, tweens. Game
  *logic* stays in plain TS modules that don't import three.js, so the
  simulation is unit-testable headlessly.
- **Build tooling:** Vite + `vite-plugin-pwa` (service worker, installable,
  offline-capable after first play of each map).
- **Testing:** Vitest for the simulation (economy, pathfinding, combat,
  terrain, tech tree, AI, maps); a Playwright smoke test that drives the
  real touch input paths; a headless balance harness (`tools/balance.ts`).
- **Audio:** every sound — effects, the adaptive score and the ambience — is
  synthesised live with WebAudio; no audio files.
- **No server.** Everything runs on-device. Settings persist in
  `localStorage`.

## The game

### Maps & terrain

Five 2-player maps, all point-symmetric (rotated 180°) so both sides are
equal, painted procedurally from a seed in `src/sim/maps.ts`. The rules are
symmetric too: every search whose ties go by scan order runs in each side's
own frame (see *Side fairness* under Balance & pacing).

| Map | Size | Biome | Character |
|---|---|---|---|
| Riverlands | 56² | Temperate | A river splits the valley: one bridge, two muddy fords, woods on the banks |
| Dune Sea | 56² | Desert | Open sands between mesas, a palm oasis in the middle, three lanes |
| Frostbite | 48² | Arctic | A frozen sea in the centre — short, brutal, hover-friendly |
| Ashlands | 64² | Volcanic | Lava rivers carve three plateaus joined by bridges; air rules |
| Proving Grounds | 48² | Temperate | The original MVP map: rock ridges, one contested field, an expansion field out on each flank |

Terrain matters (numbers in `TERRAIN` in `src/sim/balance.ts`):

| Terrain | Tanks | Hover | Air | Notes |
|---|---|---|---|---|
| Ground | ✓ | ✓ | ✓ | Buildable |
| Road / Bridge | ✓ fast (1.35×) | ✓ | ✓ | Roads are buildable, bridges not |
| Rough (mud, scree, slush, cinders) | ✓ slow (0.6×) | ✓ full speed | ✓ | |
| Woods | ✓ slow (0.55×) | ✓ slow | ✓ | Ground units inside take 30% less damage |
| Shallows (fords) | ✓ slow (0.5×) | ✓ | ✓ | |
| Water / lava | ✗ | ✓ | ✓ | The Lancer's party trick |
| Rock | ✗ | ✗ | ✓ | |
| Scrap field | ✓ | ✓ | ✓ | Resource: 1500 per tile |
| Crystal field | ✓ | ✓ | ✓ | Rich resource: mines 1.6× faster per load |

Ground pathfinding is A* weighted by terrain speed, so tanks prefer roads
and skirt mud. Air units fly straight over everything.

### Economy

- Single currency: **Scrap**. Harvesters haul 100 per trip from scrap piles
  or glowing crystals back to the nearest **drop-off** (HQ or Depot).
  Harvesters flee home when shot and auto-mine when built.
- Each HQ also salvages a trickle of 2 scrap/second, so no side can be left
  permanently broke.
- Starting stockpile: 600 scrap and one harvester, plus the side's opener
  (below) — so in practice two or three harvesters and a factory.
- **Battlefield salvage** (below): wrecks are the second income stream,
  ~20% of all scrap earned in AI-vs-AI play.

### Battlefield salvage

Every destroyed combat unit leaves a burning wreck worth **30% of its
cost** (Stinger 45, Titan 143, Hornet 113 …; harvesters leave none; Last
Stand's wave units only 5%, see Last Stand) for **60 s**. After 2.5 s it
has cooled enough to touch, and the first ground
unit of *either* side — harvesters included — whose centre comes within
0.9 tiles scoops it up (income multipliers apply; a side on a frozen
economy — an op's zero income, or Last Stand's waves — can't cash wrecks in, so its units drive
over them, no "+0" pops or salvage tip, and the wreck stays for the enemy).
Fights leave loot worth
holding the field for, a defender who breaks a wave gets paid for it, and
the losing side has a way back in.

- Aircraft wrecks land where they fall; a death spot no tank could reach
  (rock, water, lava, a building) slides to the nearest passable point
  within 2 tiles, else the wreck is lost. Wrecks never block movement or
  placement (a building placed on one clears it for its owner).
- At most 60 wrecks at once (the oldest burns out first).
- Looks: the dead unit's own sprite, charred, turret blown off its ring;
  embers and smoke while hot, then a gold glint and a faint warm glow that
  say "loot"; it fades over its last 10 s. Downed aircraft tumble from
  flying height first. Pickups pop a gold "+52" (merged when several land
  together) with a coin blip; the enemy's pickups show in muted red.
  A sweep of 400+ in a few seconds calls out a "SALVAGE HAUL" banner.
  Wrecks show only where you have vision and are remembered like buildings
  until you see they're gone; gold minimap dots. The income rate (+N/m)
  includes salvage, and the end screen has a Salvaged row.
- Measured (AI-vs-AI round robin with openers, all 5 maps, 300 games
  per setting): about 6,100 scrap salvaged per match (18% of income);
  stalemate draws 30 → 17; the side ahead by 200+ value at 2:00 / 3:00
  went on to win 88% / 92% → 84% / 88%; median length 5.5 → 5.7 min, mean
  8.8 → 7.8. Shares of 25% and 35% were tried too: 35% removes more draws
  but hands the leader its edge back (87% / 88%); 25% was within noise
  of 30%.

### Openers (quick start)

Every skirmish opens on three cards and the clock waits for the pick, so
there is no dead "wait for the first factory" stretch (the old opening had
a 14 s idle gap and the first combat unit at 0:51):

| Opener | You get | Plays like |
|---|---|---|
| **Blitz** | Fab Plant + 3 Stingers + 2 harvesters, −100 scrap | Army on the field at 0:00; raid early |
| **Industry** | Fab Plant + 3 harvesters + 200 scrap | Out-mine now, out-build later |
| **Air Wing** | Airpad + 3 Wasps + 2 harvesters | Fast strike drones; dies to Flak |

Blitz and Industry are worth 650 scrap; the Airpad is a side-grade (you
still want a Fab for anti-air), so Air Wing carries a third Wasp (950). A
720-game AI-vs-AI opener matrix (every opener pair, both sides, six
personality pairings, five maps) has them winning 53% / 55% / 42% of
decided games — Air Wing rewards a human's micro more than the AI's.

`src/sim/openers.ts` places the factory deterministically ~4.5 tiles from
the HQ toward the map centre (legal, off the roads and the harvest route,
never walling anything in), with every search done in the side's own
frame so both sides get mirror-image setups. `createMapWorld(id, { openers: { blue, red } })` applies them for
tests and the balance harness; without the option the classic start is
unchanged. The AI picks by personality (Rush → Blitz, Boom → Industry,
Air Swarm / Skyforce → Air Wing, Balanced → any, Ironclad → Blitz or
Industry, seeded) and holds its raiders home for the first 45 s. The
cards name the enemy personality, so the pick can be a counter-pick.

### Buildings (8)

| Building | Role | Requires |
|---|---|---|
| **HQ** | Pre-placed. Builds Harvesters, takes scrap, point-defence gun vs aircraft. Lose it, lose the game. 3×3. | — |
| **Fab Plant** | Builds ground vehicles. 2×2. | — |
| **Airpad** | Builds aircraft. 2×2. | — |
| **Tech Lab** | Unlocks Mortar, Titan, Lancer, Hornet. 2×2. | Fab Plant or Airpad |
| **Depot** | Forward scrap drop-off for distant fields. 2×2. | — |
| **Turret** | Autocannon, hits ground and air. 1×1. | — |
| **SAM Site** | Long-range anti-air missiles. 1×1. | — |
| **Radar** | Reveals a 13-tile radius through the fog. 1×1. | — |

C&C build flow: pick a structure → it constructs on a timer → tap it again
and place it on a valid spot within 6 tiles of your base (see "Command UX"
below). One construction at a time. Buildings can be **sold** for 50%
(scaled by health).

### Units (11)

| Unit | Built at | Domain | Hits | Role |
|---|---|---|---|---|
| **Harvester** | HQ | Ground | — | Economy |
| **Scout** | Airpad | Air | — | Fast, big sight radius |
| **Stinger** | Fab | Ground | Ground | Cheap fast light tank |
| **Flak Crawler** | Fab | Ground | Air | The anti-air answer |
| **Mortar** ⚗ | Fab | Ground | Ground | Long-range splash artillery with a minimum range; shells are real projectiles and can be dodged |
| **Titan** ⚗ | Fab | Ground | Ground | Super-heavy twin-cannon tank |
| **Lancer** ⚗ | Fab | Hover | Both | Anti-armour laser that also hits air (at reduced effect) and crosses water |
| **Wasp** | Airpad | Air | Ground | Rocket strike drone |
| **Raptor** | Airpad | Air | Air | Interceptor |
| **Hornet** ⚗ | Airpad | Air | Ground | Heavy bomber: splash vs ground and bases |
| **Mender** | Airpad | Air | — | Repair drone: heals units and buildings |

⚗ = needs a Tech Lab.

The counter web (verified by the cost-equal duel matrix in
`tools/balance.ts duels`): **Stingers** beat Flak, Mortars and Lancers ·
**Lancers** burn through Titans · **Titans** crush Stingers, Flak and
Mortars · **Flak** beats all aircraft · **Wasps** beat tanks and artillery ·
**Raptors** beat aircraft · **Hornets** smash bases and armour but die to
Flak/Raptors/SAMs. Stinger › Lancer › Titan › Stinger is the ground
triangle; air vs anti-air sits across it.

### Combat

- **Damage types × armor classes.** Every weapon has a damage type
  (kinetic, cannon, flak, missile, explosive, laser) and every target an
  armor class (light, medium, heavy, structure); `DAMAGE_VS` in
  `balance.ts` is the multiplier table.
- **Splash & projectiles.** Mortar shells and Hornet bombs are simulated
  projectiles aimed at where the target *was* — fast units can dodge.
  Splash falls off from 100% to 50% at the edge.
- **Cover.** Ground units in woods take less damage.
- **Veterancy.** Units earn XP from kills (in scrap value); three ranks,
  each +15% damage, rank 3 self-repairs. Shown as gold chevrons. Ranked
  units become heroes (see *Veteran heroes* below).
- **Fights you can play.** Combat units carry 1.5× their original HP
  (Hornets 1.3×, so Flak still beats them; Harvesters, Scouts and
  buildings unchanged): half of an 8-v-8 Stinger brawl now dies in 7.5 s
  instead of 5, Wasps vs Flak 4.7 s instead of 2.4 — time to select, retreat
  or focus-fire on a phone. The duel matrix keeps the counter web below.
- **Retaliation.** Idle units hit by something out of reach go after the
  attacker, and nearby idle allies join in.
- Auto-acquire targets in range; attack-move is the default command, with
  a "Move only" chip for retreats.

### Combat readability & feedback ("juice")

Fights must read at a glance on a phone (units die ~3.7 s after first
being hit), and kills, losses and income must each feel distinct. Rules in
`src/game/juice.ts` (engine-free, unit-tested), drawn by
`src/game/render/juice-view.ts`:

- **Hit flash:** a hit unit flashes a white silhouette (hull and turret)
  for 70 ms, at most once per 120 ms per unit; buildings get a warm
  additive glow (100 ms, once per 280 ms) so a siege flickers rather than
  strobes. Wall-clock timed, so pausing never freezes a unit white.
- **Health bars:** recently lost HP stays as a pale chunk for 300 ms, then
  drains at 1.5× max HP/s (a new burst only re-arms the hold once the trail
  has caught up). Enemy bars brighten as HP falls and blink at 2 Hz below
  25%. Bars snap to device pixels, keep a 22 CSS px minimum width, and stay
  4 CSS px tall at every zoom.
- **Team ground rings:** any unit that fired or was hit in the last 3 s
  sits on a thin blue/red ellipse (fading over its last second), so mixed
  clumps read even at the default zoom. Aircraft rings sit under the craft.
- **Deaths:** small hulls get a smaller fireball and glow (Titans and
  Hornets keep their big one); impacts are trimmed so explosions stop
  hiding the clump. An expanding ring in the victim's colour says whose
  unit just died. Camera shake only for deaths the player can see inside
  the camera view, scaled by what died (stinger ≈ 1 px, HQ biggest).
- **Sound:** a bright two-note *kill* "ting" on enemy deaths you can see; a
  low *lost* power-down for your own units (quieter and throttled when off
  screen). Both may use two voices reserved above the 14-voice battle cap.
  Losing a building buzzes the phone (`navigator.vibrate(20)`, Android).
- **Economy:** each delivery pops a gold "+100" over the drop-off with a
  coin blip; deliveries within 2.5 s of each other climb a pentatonic
  scale (retuned into each biome's music key, `coinKey` in score.ts), and
  arrivals at one drop-off within 400 ms merge into one label.
  The scrap pill bumps on income and flashes red when you spend.
- Spectators get the visuals for both sides but no kill/loss/coin cues.

### Music & ambience (adaptive score)

The battle used to be silent half the time. A procedural score
(`src/game/music.ts`, rules in the engine-free, tested `src/game/score.ts`)
now follows it, scheduled 200 ms ahead on the AudioContext clock at 96 BPM
(menu 80), in 16th-note steps with one chord per two bars:

- **Layers**, each opened only on a bar line: a voice-led **pad** (always;
  four gliding voices, no muddy seconds or sevenths in the bass), a calm
  **melody** that plays call-and-answer phrases while you build, a **bass**
  groove once your units are in contact, **drums** (with a crash on entry
  and fills every fourth bar) when a fight is on screen, and a 16th-note
  **arp** when it gets big. While your base is under sustained attack
  (3+ building hits in 4 s) the arp swaps in a tritone and the filters open
  — for at most 15 s per attack, so it stays a warning.
- **Biomes:** temperate D dorian (Dm7–Fmaj7–Cmaj7–G7, kalimba pluck),
  desert E phrygian dominant (E–F–Am–Dm, oud pluck, tresillo bass, tabla),
  arctic F lydian (Fmaj7–G7–Dm7–Am7, FM glass bells, half-time drums),
  volcanic C aeolian (Cm–Ab–Eb–Bb, marimba, driven chugging bass, toms).
- **Intensity** (`BattleMood`, from the sim's fx stream):
  `I = audibleShots4s/32 + 0.5·(base under attack) + 0.25·min(1, losses10s/3) + strike`,
  floored at 0.3 while your units fought anywhere in the last 8 s; attack
  0.5 s, release 6 s. Calldowns are the loudest moments: `strike` is the
  biggest one still ringing — an impact adds Barrage 0.45 / EMP 0.3 / Drop
  Pod 0.3 / Sky Hammer 0.85 × its earshot, fading out over 6 s (public, so
  no fog check; three shells are one Barrage, they don't stack). A Sky
  Hammer counts at least half wherever it lands (its boom carries) and in
  full on or near your things; an enemy reticle over your things holds 0.35
  until it lands. In Last Stand a 0.35 floor holds from a wave's warning
  until a few seconds after it arrives. Shots count by the same earshot rule as the SFX and
  only if you can see them. Bass enters around I 0.15–0.35, drums 0.42–0.6,
  arp 0.72–0.9. Spectators hear on-screen combat from both sides (1.5× the
  shots for full) with no alarm. Measured over six AI-vs-AI matches with a
  follow-cam: calm 24% / bass 15% / drums 33% / arp 28% of match time
  (HQ-parked camera 24/42/23/11); first drums at 36–138 s.
- **Stingers** on the next beat: a I–IV–V–I fanfare (victory, which then
  holds the tonic major for a quiet coda), a descending minor lament
  (defeat), and for `announce()` lines a rising call (`epic`), two low stabs
  a semitone apart (`bad`, which also lifts the tension for 8 s), a light
  lift (`good`, priority ≤ 1) or a tom hit (keys matching `first-blood`).
  At most one per 3.5 s. When music is off, the old SFX jingles play instead.
- **Mix:** the score ducks 6 dB under big explosions and alarms (`sfx.duck`,
  also for announcer lines), is muffled to a 420 Hz lowpass while paused,
  and stops with the tab hidden (the AudioContext is suspended). Budget:
  8 persistent pad oscillators plus ≤ 10 transient voices (14 during a
  stinger), shared noise buffers; the scheduler costs ~0.07 ms per 25 ms
  tick. Offline renders: calm ≈ −34 dBFS RMS, intense ≈ −26, peaks ≤ 0.6.
- **Ambience** (`src/game/ambience.ts`): a quiet looped bed per biome —
  wind and birdsong, desert roar and sand hiss, a sliding arctic whistle, a
  volcanic rumble with crackles — at about −44 dBFS, ducked by
  `1 − 0.7·I`. It plays under the Music switch.
- **Menu:** a gentle pad/melody/arp take on the selected map's biome,
  starting on the first touch (browsers block audio until a gesture).

### Voices & announcer

Every player action gets a voiced answer, and the big moments are called
out without eating screen space (C&C's EVA, arena-shooter streaks).

- **Unit chirp-voices** (`src/game/voices.ts`): each unit class has a
  synthesized robot voice: a carrier glides through two formant
  band-passes, plus a dry share so thin voices carry on phone speakers.
  Titans growl at 80 Hz, Hornets drone with FM buzz, Wasps buzz at 60 Hz,
  Lancers shimmer, Menders ring like bells and Harvesters go "boop-boop".
  Lines: *select* (two rising syllables), *move* (two short, then a fall),
  *attack* (a noise bark and three fast syllables), *ready* (three rising,
  replacing the generic chime), *rank* (four ascending with a sparkle,
  replacing the rank chime) and *death* (a falling wail with crackle, own
  units in view only). Pitch is jittered ±6% by unit id, so a group sounds
  like a chorus. A group answers in its majority kind's voice, with one
  echo voice 6 dB down. Every line is under 400 ms. Lines start at least
  250 ms apart; unprompted ones keep their own spacing (ready 2 s, rank
  1.5 s, death 2.5 s) and stay 600 ms clear of the player's chirps. Lines
  are balanced to about −30 dBFS RMS.
- **Radio announcer** (`announcer.ts`, rules in the engine-free, tested
  `callouts.ts`): a squelch and key-up beep on the voice bus, then
  `speechSynthesis` (pitch 0.6, rate 1.08, an English, preferably male,
  on-device voice), then an "over" click. The music ducks 5 dB under it.
  It reads every `announce()` banner (`Announcement.say` overrides the
  spoken text) plus its own lines from the fx stream:

  | Line | Priority | When / cooldown |
  |---|---|---|
  | Warning: our HQ is under attack | 0 | HQ hit; 30 s (60 s if it's on screen) |
  | Our base is under attack | 1 | other building hit off screen; 30 s |
  | Squad lost | 1 | 3 own deaths within 3 s; 20 s |
  | Enemy aircraft detected | 1 | first visible enemy combat aircraft; re-armed after 2 min unseen |
  | Structure lost: X | 1 | own building destroyed; 15 s |
  | Incoming artillery! / EMP inbound! / Enemy drop pod! | 1 | an enemy Barrage / EMP / Drop Pod aimed at our units or buildings (the siren's "threatened" rule); 20 s each; dropped if it can't start within 1.5 / 1 / 2.5 s (the Sky Hammer has its own spoken banner) |
  | Our units are under fire | 2 | own unit hit off screen; 60 s (not for the hits of an enemy strike just warned about) |
  | Harvester lost / Titan lost | 2 | off screen; expensive (≥ 350) or veteran units |
  | Enemy X destroyed | 2 | enemy building; 15 s |
  | Construction complete / X promoted (rank ≥ 2) / Insufficient scrap | 3 | |
  | Enemy HQ destroyed. Victory! / Our HQ has fallen. Mission failed. | 0 | last word; nothing after it |

  Delivery goes through `RadioQueue`: most important first, ≥ 2.5 s between
  lines, at most two waiting, and lines dropped after waiting 3 s (6 s for
  P0). A chatter budget allows at most 3 routine (P2–P3) lines per 30 s;
  warnings always get through. Lines wait, without ageing, while the game
  is paused. Radio-only news also gets a small coloured **radio caption**
  (a slim toast; tap to jump there). Lines that already have a toast or
  banner get no caption. Speech
  must be unlocked inside a gesture on iOS (primed on the first tap). Where
  speech is missing, failing, or set to **Chirps**, a two-tone radio code
  stands in: falling for warnings, rising for good news.
- **Kill-streak banners** (through `announce()`, so they also get music
  stingers and are read out): *First blood* (the player's first kill),
  *Double kill* / *Triple kill* / *Rampage* for 2 / 3 / 5 kills within a
  4 s sliding window. The tier is called after a 0.6 s hold, so a fast
  third kill upgrades the line. Tier cooldowns are 30 / 30 / 45 s.
  Expensive kills get their own banner ("TITAN DOWN", spoken "Enemy Titan
  destroyed"), or ride along under a streak. Kill banners are at least 6 s
  apart; a streak climbing a tier needs only 2 s.
- **Calldown kills count, and say so.** A calldown's kills are credited to
  its side's HQ in the sim; `calldown-credit.ts` (engine-free, tested) spots
  them — killed by the enemy HQ, next to one of that side's impacts in the
  same tick — so every presentation layer can name the strike. They count
  for first blood ("Enemy Stinger destroyed by a Barrage") and streaks; a
  streak mostly made by one calldown (≥ 2 kills and half of them) puts it on
  the sub-line ("TRIPLE KILL / Sky Hammer", spoken "Sky Hammer: triple
  kill") on its own 10 s cooldown, since strikes are rare. A building one of
  ours flattens gets "Direct hit!" ("Sky Hammer: enemy Turret destroyed"),
  or rides under that strike's streak banner. Our Drop Pod's crew reports
  in with the *ready* chirp as it steps out.
- **Spectators** hear a neutral caster ("Red HQ under attack", "Double
  kill for Red", "Blue Fab Plant destroyed", "Blue wins the battle"), with
  full information.
- **Measured** over six AI-vs-AI matches (32 min,
  `callout-rates.ts`): 4.5 delivered lines/min (at most 9 in any 60 s, in
  end-game sieges), 1.2 banners/min (at most 5 in 60 s), and 9–13
  unprompted chirps/min with a follow-cam. Spectators: 3.1 lines/min and
  1.7 banners/min. The test suite replays a match and fails if this drifts.

### Battle awareness & tempo

On a 6" screen you can't see the fight you should react to, warnings used
to come after the damage, toasts covered the battlefield, and the build-up
dragged. Rules in `src/game/awareness.ts` (engine-free, tested), wired up
in `awareness-view.ts`, widgets in `src/ui/awareness.ts`. Everything is
fog-respecting: hits on your own things, shots your units fire, and only
enemies you can currently see.

- **Game speed:** a chip beside the clock cycles 1× → 1.5× → 2× (spectators
  also 4×), remembered per mode in `localStorage` (`battledrones.speed`);
  **press and hold the clock** for 3× while held; `.` cycles. At most 8 sim
  ticks run per frame and a backlog beyond that is dropped, so a slow phone
  slows down instead of spiralling. Weapon and impact sounds space out by
  the speed factor (`sfx.setTempo`) and get 11 voices instead of 14 above
  1×. Detection windows everywhere are sim seconds, so nothing else changes.
- **Tempo safety:** telegraphs are sim seconds too, so at 2× a Barrage's
  2.5 s warning is gone in 1.25 s. Above 1×, the game drops back to 1× by
  itself (`TempoGuard`) when something needs your hands: an enemy calldown
  aimed at your units or buildings (the same "threatened" rule as its
  siren), a spoken inbound warning, or the HQ coming under a new attack
  (first hit after 20 s without one, tracked at any speed, so speeding up
  mid-siege doesn't snap back). A held fast-forward lets go too; the chip
  pulses red and one ticker note says why ("Speed 1× — enemy Barrage
  inbound", tap to look) — folded into the raid's own warning line, and
  replacing the off-screen "Enemy Barrage inbound!" / "HQ under attack!"
  alerts, so it's still one line per event. The chosen speed stays stored
  for the next match. Spectators never slow down.
- **Inbound warning:** when visible armed enemies (anything that can hit a
  ground target) come within 12 tiles of a building or harvester, the group
  (single-link, 5 tiles) is warned once, with counter advice by domain and
  lead kind: "Enemy drones inbound — Flak, Raptors or a Turret", "Enemy
  Titans inbound — Lancers, Wasps or Hornets"… A group seen in the zone
  within 20 s isn't new; one that has been shooting your things for 1.5 s is
  a fight, not a raid; loud warnings are at least 12 s apart (quieter ones
  still get an arrow). The first raid of each kind per match is a banner
  ("DRONES INBOUND", sub-line with the counters, read out by the
  announcer); later ones are a ticker line plus the radio — unless an
  inbound banner is still up or waiting, which already says it. Each sounds a
  two-whoop siren and pulses the minimap with amber rings. An air raid
  stands in for "Enemy aircraft detected". An enemy Drop Pod's crew isn't
  a new raid: its reticle, siren and radio line already announced it. Measured over 8 AI-vs-AI matches
  (67 min, blue's view): 1.2 loud warnings/min; warning → that group's first
  hit median 3.8 s (p10 0.9, p90 8.0). Lead time is bounded by vision: a
  harvester sees 4 tiles and a Wasp shoots from 3, so the first raid on a
  mining line gets well under a second, while Radar, the HQ's 8.5-tile
  sight or units on watch buy several seconds.
- **Hotspots and edge arrows:** hits on your things (HQ 0.6, other
  buildings and harvesters 0.45, units 0.35 heat), your losses (0.6), and
  shots/kills by your units (0.2/0.4, at the shooter; not your calldowns'
  kills, which the sim credits to your HQ — that was an "Attack" arrow
  pointing home) heat 6×6-tile cells
  that cool 15% per second; warm cells within 8 tiles cluster and a cluster
  over 1 heat is a hotspot, named by the most important thing hit (HQ! >
  Base > Harvesters > Units; only your own shots: Attack). Off-screen
  hotspots (by priority, then heat; at most 3, one per direction) become
  pulsing, tappable 46 px arrows at the edge of the visible battlefield,
  red when you're being hit (dashed for an inbound raid), amber when you're
  attacking. Each slides along the edge past HUD widgets (minimap, zoom
  stack, ticker, chips, banner, anything marked `data-edge-avoid`). Tapping
  one glides the camera there in 350 ms (ease-out) and flashes a ring. The
  **⚡ button** under the zoom buttons cycles through all hotspots, most
  urgent first (a red dot when something of yours is under threat).
  Spectators get amber "Fight" / "Red HQ" arrows for both sides. Measured:
  a camera parked on the HQ has at least one hotspot elsewhere 51% of the
  match.
- **Battle meter:** while at least 2 of your armed units and 2 visible
  enemy ones are in view and shots were fired there in the last 3 s, a slim
  tug-of-war bar under the clock compares Σ cost × HP fraction (turrets and
  SAMs count, harvesters don't), easing over 300 ms and lingering 1.5 s. A
  swing of more than 20 points within 4 s flashes **Turning point!** (green
  toward you, red away; at most every 8 s; ignored when the camera jumps).
- **Ticker:** toasts left the battlefield's centre for a compact,
  left-aligned stack under the top band: 13 px, at most two lines each, at
  most two at once (the newest pushes the oldest out, but a 💡 hint
  outlives a burst of alerts), 2.2 s by default, still tappable. Big
  moments remain `announce()` banners. While a banner shows only the newest
  ticker line stays (see *HUD layout* for where each goes).

### Command UX: squads, build advisor, placement

Commanding on a phone shouldn't be a chore. Rules in engine-free, tested
modules (`src/game/squads.ts`, `src/game/advisor.ts`, `src/sim/placement.ts`);
widgets in `src/ui/command.ts` and `src/game/placement-view.ts`.

- **Squads** (control groups for thumbs): three 42 px chips at the head of
  the chip row. Hold one (400 ms, with a fill, a buzz and a chirp) to save
  the selection; tap to select it; tap twice within 400 ms to glide the
  camera to the member nearest the squad's middle. Each chip shows the most
  common unit's icon (ties: the pricier kind), a count and a health bar
  (Σ HP / Σ max), and glows red for 1 s whenever a member is hit. A unit is
  in at most one squad; holding a chip with nothing selected clears it. A
  one-time hint teaches the gesture the first time two or more combat
  units are selected.
- **Counter advisor:** remembers the enemy units you have actually seen
  (standing on tiles you see right now; scouts and harvesters ignored),
  each for 60 s after its last sighting, plus enemy Turrets and SAM Sites
  from the fog memory. A build button whose counters (from the duel matrix:
  Flak → Wasps, Raptors, Hornets, Menders; Stingers → Flak, Mortars,
  Lancers; Titans → Stingers, Flak, Mortars; Lancers → Titans; Wasps →
  Stingers, Mortars, Titans, Lancers; Raptors → Wasps, Hornets, Menders;
  Hornets → Titans, Mortars; Mortars → Turrets, SAMs; SAM Site → Hornets,
  Wasps) have been seen at least twice gets an amber ⚔ corner (pulsing for
  its first 6 s), and its tab a ⚔ dot, until your own force of that kind
  (built + queued) is worth 75% of what it counters. The long-press card
  says "Counters Wasps (seen ×4)". It is advisory: the same fog-limited
  knowledge the AI adapts its production to.
- **Idle factories:** a Fab Plant or Airpad with an empty queue for 6 s
  while you can afford its cheapest combat unit puts a pulsing amber
  **IDLE** tag on the Vehicles or Aircraft tab.
- **Placement on touch:** tapping a ready structure drops the ghost on the
  best valid spot near the middle of the view (closest to it, avoiding
  spots that would wall a lane shut), gliding there if it's off screen; the
  build-range zone is tinted and outlined. A tap on the map moves the ghost
  (snapping one tile onto a valid spot when that's all it takes), dragging
  the ghost slides it, and tapping the ghost or **✓ Place X** builds. A bad
  spot says why above the ghost and on the chip — *Too far from base*,
  *Blocked*, *Unit in the way*, *Not on water / rock / mud / lava…* — and
  trying to build there shakes the ghost with a low buzz and the radio's
  "Cannot build there". The ghost draws above the fog. A mouse keeps
  one-click placement.

### Commander calldowns

Once an army is sent, the commander still has moves: a **Command meter**
(⚡, 0–100) fills slowly on its own and mostly from *losses* (0.035/s;
0.008 per scrap of your own units and buildings destroyed, 0.002 per scrap
you destroy; +0.06/s per Uplink held), and pays for three map-targeted
calldowns, each on its own cooldown — about one meter power every two
minutes in a typical match. Numbers live in `POWERS` in `balance.ts`.

| Power | Charge / cooldown | Warning | Effect |
|---|---|---|---|
| **Barrage** | 60 / 45 s | 2.5 s | 3 shells over 0.6 s, seeded scatter ±0.9 tiles, 170 explosive splash r 2 each (ground units and buildings) |
| **EMP** | 40 / 40 s | 0.8 s | Enemy units and buildings within 3 tiles freeze for 4 s: no moving, firing, healing or production |
| **Drop Pod** | 70 / 60 s | 2 s | 2 Stingers + a Flak Crawler (2 Lancers + Flak with a Tech Lab) land on open ground you can *see*; a light 60-damage thump under the pod |
| **Sky Hammer** | — / 150 s | 3 s | Online for both sides at 6:00. Units within 2.5 tiles take 260 × (1 − 0.5·d/r), air included; buildings a flat 700 (an HQ loses 22%) |

- **Same rules for both sides.** One `calldown` command, validated by
  `calldownBlocker` (charge, cooldown, the HQ alive, an *explored* target —
  a *visible*, ground-passable one for the pod) for the player and the AI
  alike. Calldowns only hurt the enemy; kills are credited to the firing
  side (its HQ is the killer, so faction stats count them; no unit XP). The
  presentation layers name the strike instead of "defences" or the HQ (see
  *Calldown kills count* under Voices & announcer): first blood, streaks,
  hero toasts ("✝ Viper (Lancer, 9 kills) destroyed by an enemy Barrage"),
  the report's story, medals and tips; they never heat an "Attack" hotspot
  at your own HQ and never make the HQ an MVP.
- **Every calldown is telegraphed, publicly.** `World.powers.active` and the
  `calldown` FxEvent are visible to both sides through the fog: a reticle
  shrinks to the moment of impact, so landing one and dodging one are both
  skill moments. EMP + Barrage is a real combo (frozen units can't dodge).
- **Looks and sounds:** red reticles and an air-raid siren for the enemy's
  (loud when it threatens your stuff, with a tap-to-jump toast and a
  minimap ping if it's off-screen); gold / cyan / blue for yours, with a
  radio chirp. Shells streak in, the EMP throws a blue-white shockwave and
  leaves frozen things crackling, pods fall in a flame trail and burst open
  in a ring of dust, and the Sky Hammer charges a lance from orbit (rising
  hum) before a beam, a white-out flash and a rolling boom. The camera
  shakes when it lands on screen. Banners: "Sky Hammer online" at 6:00,
  "Enemy Sky Hammer inbound!" (tap to jump); what yours destroy is a kill
  streak named for the strike ("TRIPLE KILL / Sky Hammer"), or "Direct hit!"
  for a building. The radio warns of an enemy Barrage, EMP or Drop Pod aimed
  at your things ("Incoming artillery!"), the music swells with every
  impact, and the hits a warned strike lands don't also raise "Units under
  attack!" (one channel per event).
- **HUD:** four round 52 px buttons on the right edge (48 px on shorter
  phones; a 2×2 block of 44–46 px beside the sidebar on landscape phones,
  see *HUD layout*) with the ⚡ meter, each with a conic
  ring — charge in the power's colour, cooldown in white — and its cost,
  cooldown seconds or the Sky Hammer's unlock countdown. Tap a ready one to
  arm it ("Tap map: Barrage ✕" chip, radius preview under the pointer /
  finger, grey with ✕ where it can't go), tap the map to fire; an illegal
  tap explains why. Long-press for details (in the ticker's roomier tip
  line; the Drop Pod names the crew the match's rules really give, e.g.
  "2 Wasps + a Raptor" under Air War). Reticles show on the minimap; the end
  screen counts calldowns per side.
- **Which modes have them:** skirmish, the Daily Op and Last Stand (the
  player's alone: the waves have no HQ, and the director copes — strikes kill
  wave units like any other, pod crews are just more defenders). Ops keep
  them except where the op's puzzle is a fixed force: Decapitation's strike
  group and Frozen Assets' 3,000-scrap budget (a free Drop Pod would break
  either) set `OpRules.calldowns: false` → `Rules.noCalldowns`, which blocks
  them for both sides (no buttons, no Sky Hammer at 6:00; the briefing says
  "⚡ No calldowns"). Sky Pirates bans ground units for the player too, so
  its Drop Pod lands 2 Wasps + a Raptor and the op stays an air raid.
- **AI:** a per-tick dodge reflex (before the decision gate) moves every
  unit inside an enemy reticle ~4 tiles out after 1.1 / 0.6 / 0.4 s
  (Easy / Normal / Hard) — if there's still time. It Barrages the best
  visible ground clump worth ≥ 800 (Easy never), answers a superior force
  at its base or mining line with a Drop Pod (else an EMP), EMPs turrets in
  front of an assault from surplus charge, pods in reinforcements only when
  a fight away from home hangs in the balance, and aims the Sky Hammer at a
  clump worth ≥ 700, else the best production-building hit, else the HQ.
- **Measured when it shipped** (before the balance pass cut the meter's
  income to about a third; AI-vs-AI round robin with openers, 5 maps × 30 pairings ×
  2 seeds, 300 games, before → after): 25-minute draws 17 → 1; median
  length 5.7 → 6.0 min, mean 7.8 → 7.3, p90 15.9 → 12.1; the side ahead by
  200+ value at 2:00 / 3:00 / 4:00 went on to win 84 / 88 / 90% → 80 / 84 /
  86%; games where a clear leader lost the lead 11 → 15. About 8.7
  calldowns per AI per match (median 7: Barrage 4.1, EMP 2.7, Sky Hammer
  1.3, Drop Pod 0.7), 56% fired by the side that was behind. The design
  panel's prototypes had burst powers *feeding* the snowball; here the
  meter is loss-weighted and damage telegraphed, and one rule mattered:
  free Drop Pod units for a wave that is already winning pushed the
  2:00–4:00 leader's win rate *up* 2–3 points, so the AI only reinforces a
  contested fight.

### Map objectives: Uplinks and supply drops

Without a reason to be there, 85% of the fighting happened at a base and
only 13% of unit deaths in the middle 40% of the HQ-to-HQ line. Two things
now pull armies into the middle (numbers in `OBJECTIVES` in `balance.ts`,
rules in `src/sim/objectives.ts`):

- **📡 Uplink relays**, 2–3 per map at contested, mirrored spots:
  Riverlands' centre bridge and both fords; the open flanks of Dune Sea
  and Proving Grounds; the two lanes round Frostbite's frozen sea; the outer
  plateaus of Ashlands. Units inside the 2.5-tile ring push its capture bar
  (−100…100) toward their side: 3.5 points/s per unit, aircraft half,
  harvesters not at all, capped at 4 units (neutral → held in ~7 s, a full
  flip ~14 s). With both sides inside the bar freezes; abandoned, it drifts
  back to its holder (or to neutral). The holder loses it the moment the
  bar is pushed back to neutral. Holding one pays **1.5 scrap/s** (× income
  multiplier), sees 7 tiles round it through the fog and adds **0.06/s** to
  the ⚡ meter. Uplinks are not buildings: nothing occupies their tiles or
  can shoot them (no building may be placed on the platform), so combat
  never sees them.
- **📦 Supply drops**: the first lands at 1:30, then one every 75 s, each a
  **mirrored pair** of crates (one per side of the map, same reward: fair)
  at one of three drop sites per map, chosen by the seeded RNG (never the
  same site twice running) and **announced to both sides 10 s ahead**. The
  first non-harvester unit within 0.8 tiles of a landed crate claims it
  (nearest wins); a crate nobody claims burns out after 45 s. Rewards,
  weighted: **+200 scrap** (38%), **Veterans** (+1 rank to the claimer and
  allies within 3, 20%), **Field Repair** (own units within 4 heal half
  their HP, 15%), **+40 ⚡ charge** (17%) and the rare **free veteran
  Lancer** (10%). A kit that would do nothing (no one hurt, the meter full)
  is stripped for up to 150 scrap instead.
- **Looks:** a neutral relay platform (generated art) whose dish idles on a
  slow scan, turns for its holder and spins up while being taken; a dashed
  capture ring and a bar round the platform in team colours, shown through
  the fog (holders are public). A crate shows a gold landing marker and a
  light pillar the moment it's announced (through the fog), drops the last
  2.5 s under a striped parachute that sags away as it lands, then glints
  with a burn-out ring; claiming it pops the reward in gold ("VETERANS ×3",
  "+300", "FREE LANCER!"). Banners: "Supply drop inbound" / "Rare supply
  drop!" (tap to jump to your side's crate), "Uplink captured", "Uplink
  lost"; an "Uplink under attack!" toast when the enemy starts pushing one
  of yours off-screen. Sounds: a data-burst chime, a dying-signal fall, a
  transport drone and a reward fanfare.
- **AI** (`ai/objectives.ts`): from 0:20 it sends a squad worth ≥ 400 (or
  1.3× the visible enemy there) to the best Uplink it doesn't hold —
  nearest its own side first; mid-assault only if the army is 2.5× the
  squad — keeps the squad on the ring until the bar is full, then parks
  its cheapest unit there as a garrison. Enemies near a held Uplink count
  as threats, so the threat response defends it. Every announced crate gets
  the nearest free units that can make it before it burns out (straight
  race while it's quiet, attack-move if enemies are there), never more
  than it'd feed and never drones into known anti-air. It never looks at
  what a crate holds before claiming it. Boom only contests its own
  flank, Ironclad leans to the centre; Easy takes neutral relays but never
  comes for yours, and only races crates near its own units.
- **Measured when it shipped** (with 3 scrap/s Uplinks and +300 crates,
  before the balance pass; AI-vs-AI, 5 maps × 6 personality pairings × 2 seeds,
  openers on, Normal, before → after): combat-unit deaths in the middle
  40% of the HQ-HQ line 13% → 27% (first 5 min 13% → 28%); draws 0 → 0 of
  60; median length 5.1 → 5.5 min, p90 12.1 → 7.6; about 3 Uplink captures
  and 8–10 crates claimed per match, objectives ≈ 9% of all scrap earned.
  The side ahead by 200+ assets at 2:00 / 3:00 / 4:00 went on to win
  92 / 93 / 92% → 86 / 96 / 98%: objectives open the early game up but pay
  whoever controls the field, so later leads hold. The full round robin
  (`tools/balance.ts matches`, 150 games) keeps the personality spread
  where it was (Ironclad 92 → 90%, Boom 72 → 78%, Rush 24 → 18%, Skyforce
  16 → 22%) with no draws. Before the mid-assault squads, the AI
  sat on its first relay (2.5 flips per match → 4.3 with them).

### Fog of war

- Unexplored (an opaque, biome-tinted shroud), explored-but-unseen (a
  greyed memory; remembers enemy buildings), visible. Rendered as a
  smoothly fading soft-edged overlay.
- A remembered enemy building is drawn as last seen: its damage look
  follows the health it had then, and it shows no smoke, hit flash, health
  bar, EMP crackle or turning turret while out of sight. One destroyed in
  the fog stays standing (as on the minimap) until its footprint is seen
  again. Enemy building blasts show only where seen; ours, and the HQ that
  decides the match, always show.
- The AI does *not* cheat: it keeps its own visibility map and reacts only
  to what it has seen.

### AI opponent

A commander that runs a decision pass every 1.2–3.5 s (by difficulty) and
emits ordinary commands. Six personalities, picked at random each match:

| Strategy | Plan |
|---|---|
| Balanced | Factory, airpad, tech; steady macro |
| Rush | Two factories early, Stinger raids in packs of five, the earliest and smallest waves |
| Air Swarm | Airpad first, wasp raids, bombers later |
| Boom | Greedy economy, forward depot, huge late push |
| Skyforce | Air force first; the Fab Plant only guards home |
| Ironclad | Tech Lab right after its first turret: Titans, Lancers and Mortars |

Behaviours: build orders with reactive SAM sites and extra factories when
scrap piles up; forward depots at distant fields; adaptive production
(flak/raptors vs air it has seen, mortars vs defences, air vs heavy
armour); defend-the-economy guard squads; threat response against
intruders; home defence (a force at the HQ that outguns the home guard
recalls the army from raids and waves — openers make 1:00 pushes real);
wasp raids that avoid remembered anti-air; staged assault waves —
launched once three quarters of the personality's assault threshold has
gathered at the staging point, so a big wave goes, then there is a lull
while the next gathers (the bar drops 6% a minute after 7:00) — that go
for harvesters, then production, then defences, then the HQ;
menders escorting the army; wounded veterans (rank ≥ 2 under 35% HP) falling
back to a Mender behind them or to the HQ, with an idle Mender sent to patch
them up (`ai/veterans.ts`); commander calldowns and a reflex for
dodging the enemy's (see Commander calldowns); salvage sweeps once a fight near home is
over (idle ground units within 8 tiles go for visible, cooled wrecks that
no visible enemy or known turret covers, and harvesters with a light load
detour to a wreck within 3 tiles — never into the enemy for loot); map
objectives (capture squads, Uplink garrisons, crate races — see Map objectives).

Difficulty: **Easy** (slow reactions, 75% income, no raids), **Normal**,
**Hard** (fast reactions, +30% income, an extra harvester — shown in the
menu, never hidden). Each difficulty also picks from its own pool of
personalities: AI-vs-AI tournaments (`tools/balance.ts matches`) show
Ironclad, Boom and Balanced are the strongest, so Easy draws from Balanced,
Rush and Air Swarm (Skyforce's all-air wave at ~3:00 was the one Easy
opponent a first-week player usually lost to; see *Difficulty on-ramp*), and
Hard from Balanced, Air Swarm, Boom and Ironclad. AI-vs-AI games settle in a
median of ~8¼ minutes.

### Balance & pacing

With openers, longer fights, salvage, calldowns and objectives all in, one
pass retuned the numbers together against measured targets. Before it,
the AI sent a wave every time 500–1,200 scrap had gathered, so both sides
sat in assault mode from about 2:00 and a match was usually one unbroken
brawl from the first crate race to the last HQ; the side ahead at 4:00 won
90% of the time.

What changed (numbers only, plus AI thresholds):

- **AI waves** launch once 75% of the assault threshold has gathered at
  the staging point (was 60%): bigger waves with a lull between them. Assault
  thresholds: Balanced 1700, Rush 1400, Air Swarm 1700, Boom 2000,
  Skyforce 2000, Ironclad 1500 (were 1400 / 800 / 1200 / 2000 / 1300 / 1800);
  Ironclad builds a turret before its Tech Lab; Rush raids in packs of five
  (was three); the late-game discount on the threshold starts at 7:00
  (was 9:00).
- **Calldowns:** the meter earns 0.035/s, 0.008 per scrap lost and 0.002
  per scrap killed (was 0.1 / 0.02 / 0.007); the Sky Hammer recharges in
  150 s (was 120); the AI Barrages clumps worth ≥ 800 (was 450), which
  leaves charge for EMPs and Drop Pods.
- **Objectives:** an Uplink pays 1.5 scrap/s and 0.06 ⚡/s (was 3 / 0.1);
  a scrap crate holds 200 (was 300). Objectives pay whoever already holds the
  field. Single-lever tests showed they were the biggest snowball
  amplifier (switching them off took the 4:00 leader from 87% to 75%, but
  mid-map deaths fell from 26% to 13%), so they now pay less and still pull
  armies into the middle.
- Unit stats are unchanged. The duel matrix (`tools/balance.ts duels`)
  moved by a few hundredths with the final pass's fairness fix (red's units
  now path as blue's mirror image) and every counter in the web still holds
  (e.g. Stingers +0.66 vs Flak, Lancers +0.30 vs Titans, Titans +0.63 vs
  Stingers, Flak +0.66 / +0.65 / +0.21 vs Wasps / Raptors / Hornets).
- **Final pass** (every lane merged): the skirmish numbers above needed no
  re-tuning (the "Merged" column below, re-measured with lane C's
  wounded-veteran retreats and Air War rules in). The fixes were fairness
  (red's edge, below), Easy's personality pool (*Difficulty on-ramp*) and
  Last Stand, which salvage had broken (see Last Stand).

Measured with `tools/pacing.ts`: AI vs AI, Normal, each AI on its own
opener, Uplinks and drops on, every ordered pair of distinct personalities
on all 5 maps × 8 match seeds (1,200 matches per column, so the headline
shares are good to about ±3%), 25-minute cap. The original-game column is
the same measurement against a checkout of 187e23a (no openers or
objectives); "First pass" is this pass as it first shipped, before lane C.

| | Original (187e23a) | First pass | Merged | Final |
|---|---|---|---|---|
| 25-minute draws | 14% | 0.8% | 0.8% | 0.9% |
| Decided match length, median (p10–p90) | 5:51 (4:01–16:52) | 8:43 (5:22–17:18) | 8:33 (5:24–17:20) | **8:17** (5:23–17:17) |
| First combat-unit death, median | 1:47 | 1:18 | 1:18 | 1:17 |
| Big fights (≥ 1000 scrap destroyed) per decided match: median / mean / share with ≥ 3 | 2 / 3.0 / 34% | 3 / 3.5 / 51% | 2 / 3.5 / 49% | 2 / 3.4 / **47%** |
| Side ahead by > 200 value at 2:00 / 3:00 / 4:00 went on to win | 82 / 86 / 89% | 67 / 75 / 78% | 67 / 74 / 78% | **67 / 74 / 78%** |
| Lead changes per match (300 deadband), mean; winner had been 800+ behind | 1.6; 24% | 2.2; 46% | 2.2; 46% | 2.2; **46%** |
| Unit deaths in the middle 40% of the HQ–HQ line | 12% | 29% | 28% | **28%** |
| Calldowns per AI per match, median (mean) | — | 7 (7.5) | 6 (7.4) | 6 (7.3): Barrage 1.9, EMP 2.5, Drop Pod 0.7, Sky Hammer 2.2 |
| Matches where an Uplink changed hands; landed crates claimed | — | 84%; 99% | 83%; 99% | 83%; 99% |
| Personality win rates (Balanced / Rush / Air Swarm / Boom / Skyforce / Ironclad) | 55 / 16 / 28 / 69 / 7 / 83% | 54 / 30 / 35 / 71 / 37 / 71% | 53 / 31 / 36 / 68 / 37 / 73% | 51 / 27 / 41 / 68 / 38 / 73% |
| Red's share of decided games: Riverlands / Dune Sea / Frostbite / Ashlands / Proving Grounds | — | — | 51 / 51 / 55 / **65** / 48% | 47 / 49 / 48 / **51** / 48% |

Targets: draws ≤ 3%, decided median 7–10 min, the 4:00 leader winning
≤ 82%, ≥ 25% of deaths in the middle 40%, 3+ big fights in ≥ 45% of
decided matches, every personality within ~25–75%. All hold.

How to read it:

- Fighting is now nearly continuous from the first crate race. The
  big-fight count merges any run of 10 s windows with 300+ destroyed, so a
  three-minute brawl counts once. Short games, mostly the lopsided
  personality pairings, still show one or two.
- The long tail is the air-versus-anti-air pairings (Skyforce, Air Swarm),
  most often on Ashlands. The Sky Hammer and the 7:00 threshold discount
  keep draws under 1%.

**Side fairness.** Every map is exactly point-symmetric, yet red won about
70% of Ashlands mirror matches (same personality on both sides) and 65% of
its decided games above, and out-harvested blue by ~9% at 4:00 in AI
mirror games while plain harvesting was even. The player is always blue.
The cause was tie-breaks that went by scan order, which a 180° turn doesn't
preserve: units always rolled out of a factory's *south* side (away from
the enemy for blue, toward it for red); the harvesters' nearest-field BFS,
`nearestScrapTile` and A* took neighbours in a fixed order, and A* floored
a point on a tile edge (Riverlands' centre Uplink) to different tiles for
the two sides; the AI's building-placement, depot and Drop Pod scans, dock
ties, its guard point (a tile corner, not its centre) and priority targets
(sorted by footprint corner) all leaned one way; and the AI raced the first
crate of a drop's pair, which is blue's for both sides. Every such search
now runs in the side's own frame (`sideFrame` in `world.ts`: red's search
is blue's turned 180°). A mirror match with the same seeds stays an exact
mirror image through its opening (`tests/symmetry.test.ts`, every case of
which fails on the old code); later, fights between interleaved unit ids
drift it apart at float precision, which is noise, not bias.

| Riverlands / Dune Sea / Frostbite / Ashlands / Proving Grounds | Before | After |
|---|---|---|
| AI mirror matches (`tools/pacing.ts run --mirror --seeds 8`, ~46 decided a map, ±7%): red's share of decided games | 30 / 59 / 52 / **70** / 38% | 52 / 44 / 65 / **37** / 54% (all 51%) |
| …red's harvest by 4:00 vs blue's | −1 / **+9** / −2 / **+9** / +1% | +1 / −1 / +1 / 0 / +2% |
| The panel above (distinct personalities, ~238 decided a map, ±3%): red's share | 51 / 51 / 55 / **65** / 48% | 47 / 49 / 48 / **51** / 48% |

The harvest gap, the cleanest symptom, is gone on every map, and the big
panel puts every map within noise of 50%. The small mirror sample still
swings by up to ±15 points a map (about 2σ at this size; other seeds gave
Frostbite 44–63% and Ashlands 38–46%), as it did before the fix
(Riverlands 30%).

**Difficulty on-ramp** (`tools/beginner.ts`): a scripted blue player
against the AI on all 5 maps, every personality the difficulty draws and
each opener, Uplinks and drops on. None of the scripts touches calldowns,
Uplinks or crates:

- *novice*: looks at the battle every 4 s and gives one order per look,
  keeps 3 harvesters, builds Fab → Turret → Airpad and never techs, attacks
  at 8:00 with 12+ units;
- *beginner*: looks every 3 s with steady macro (Fab → Airpad → Turret →
  Tech Lab → Turret, 4 harvesters), answers attacks on its base, attacks
  late (from 7:00, 12+ units);
- *decent*: the beginner's macro, looking every second and attacking with
  8+ units from the start (close to the first pass's `human.ts`).

| Player wins | vs Easy (before → after) | vs Normal |
|---|---|---|
| novice | 72% → **89%** | 32% |
| beginner | 93% → **100%** | 84% |
| decent | — → **82%** | 37% |

The AI got tougher, but not for a new player on Easy: the one Easy
opponent that beat the novice was Skyforce, whose all-air wave lands at
~3:00 (11 of 15 games won against a player still building Stingers; Air
Swarm, Easy's other air commander, lost 11 of 15), so Easy now draws only
Balanced, Rush and Air Swarm. Easy's income and wave knobs didn't help
there (income 75% → 65%: Skyforce still won 11 of 15; assault ×1.35 →
×1.6: 14 of 15). Normal stays a challenge: the novice and the decent
script win about a third of their games. The patient beginner wins most
(74% before the fairness fix, which also took away the AI's red-side
edge): the Normal AI keeps launching its waves into a turtled base with
two turrets and loses units two-for-one, then has nothing left when the
push comes. A real player who also takes Uplinks, crates and calldowns
should do better than any of these scripts; their win rates are floors.

### Match flow

1. Menu: pick a mode (Skirmish | Last Stand | Ops), a map, a difficulty and
   any mutators → Play (or watch the AI play), or play today's Daily Op; in
   Ops, pick an op card → briefing → Start op.
2. Skirmish (and the Daily Op): opener cards over the frozen battlefield
   (Blitz / Industry / Air Wing; tap, or keys 1–3; cards a mutator bans are
   greyed out). The camera already frames the HQ, its home field and the
   factory site, clear of the HUD. Spectated AIs pick instantly. Last Stand
   and Ops have their own set-ups and no cards.
3. The pick rolls out (factory, units, harvesters already mining) and the
   clock starts. Real-time play until one HQ is destroyed (or an op's goal
   is met). Pause any time. Calldowns charge from the first losses; in a
   skirmish, Uplinks are there to take from the start and the first supply
   drop lands at 1:30; at 6:00 the Sky Hammer comes online for both sides,
   so a stalemate can't last.
4. The HQ kill plays as a short cinematic, then the after-action report
   → Rematch (back to the cards) or Menu.

First-time players get contextual hints (command your opener units — or
build a Fab on a classic start — then counters, tech), plus one-time hints
for squads, touch placement, calldowns and salvage. They all go through one
queue (`game/hints.ts`, tested) so a new player is never handed several at
once: at most one every 12 s of play (paused time and the opener cards
don't count), what you're doing right now first (placing a building, a
group selected), then the tutorial, calldowns, salvage; nothing new starts
while a banner is up or waiting; a hint that no longer applies or has
waited 30 s is dropped. Each keeps its own once-per-device flag, written
only when it is actually shown, so a dropped hint comes back next time.
Measured on a fresh profile (first minutes of a Blitz skirmish, scripted
taps at wall-clock pace): the seven hints landed at 0:05 (send your units),
0:17 (squads, a group selected at 0:09), 0:31 (counters), 1:01 (placement,
the moment the Turret's ghost went down), 1:21 (salvage), 2:12 (calldowns) and
2:31 (Tech Lab) — gaps of 12–51 s, none during the opener cards or any of the
seven banners in that stretch.

### Veteran heroes, the finale and the after-action report

Presentation only — the sim just counts `Unit.kills` and faction stats.

- **Callsigns** (`game/heroes.ts`): every unit has one of 48 callsigns,
  chosen by a hash of its id, skipping names its side already used this
  match (then "Viper II"). Shown from rank 2: selection panel "★★ Viper ·
  Lancer · 9 kills", toasts, the report.
- **Promotions** (`game/hero-fx.ts`): a gold VETERAN / HARDENED / ELITE title
  rises over the unit (enemies' only from rank 2, at most 8 at once) and the
  new chevron pops; rank 3 units get a pulsing gold shimmer. Your unit
  reaching rank 2 gets a "earned a callsign" toast; rank 3 an announcement.
  Your named unit dying gives "✝ Viper (Lancer, 9 kills) destroyed" (one
  toast per tick; "… destroyed by an enemy Barrage" when one strike got
  them); a visible enemy ace (rank 3 or ≥ 3 kills) dying gives "🎯 Enemy
  ace … down" ("… down to your Sky Hammer").
- **Finale** (`game/finale.ts`): when an HQ falls the render clocks (tweens,
  particles, tracers, model animation) drop to 0.3×, the camera glides and
  zooms onto the wreck (centred in the area the dock leaves free), five
  staged blasts roll across it, then a white flash, a shake, the result
  banner and the stinger at 1.5 s; time eases back and the report appears at
  2.8 s. Input and pause are locked meanwhile; everything runs on the real
  frame delta.
- **After-action report** (`ui/report.ts`, data from `game/chronicle.ts`,
  which samples both armies every 5 s with full information and logs every
  death): an army-strength timeline (SVG, both sides, tap or drag for
  values) with numbered markers for up to three moments — *first blood*,
  the *biggest battle* (most deaths within 20 s and 10 tiles, with each
  side's losses and where), and the *turning point* (the lead passing to the
  other side and holding 30 s) or, if it never changed hands, when the
  winner *pulled ahead* (≥ 1.5× and 400 up to the end). Calldowns are named
  in them: "Your Barrage took out their Stinger", "At your base: you lost 6
  (4 to their Barrage), they lost 5", "Your army overtook theirs after your
  Sky Hammer" (a strike by the new leader that killed 2+ units or 400 scrap
  in the 20 s before). Then the MVP card (most kills, fallen or alive — a
  unit, never the HQ that calldown kills are credited to) and the enemy's
  ace; stats with correct kill counts, *Scrap salvaged*, *Calldowns* fired
  per side (`World.powers.fired`), plus any numeric stats other features
  add to `FactionStats` (with friendly labels); and one rule-picked tip (no
  anti-air vs an air force, harvesters lost, idle factories, banked scrap,
  Titans unanswered, 6+ units lost to enemy calldowns, …). Calldown kills
  never count as "your defences" (tips, Iron Wall). Spectators get both
  MVPs and a one-line story per commander instead of a tip. Buttons stay
  pinned at the bottom of the scrolling panel; landscape uses two columns.
  `addReportSection()` lets later features add blocks (career medals).
  The Last Stand end screen shows the run's MVP card too.

### Last Stand (survival mode)

A second mode for short, replayable sessions: no enemy base or economy, just
endless themed waves against your base. The score is **waves survived**; the
best per map and difficulty is saved on the device and shown on the menu
(selector line and map-card badges) and on the end screen ("New record!").

- **Waves** (`src/sim/modes/survival.ts`, a pure, seeded wave director called
  from `step()` only when `World.survival` is set): the first lands at 1:35
  (Easy 1:50, Hard 1:25), then one every 50 s (60 s after a boss). Each block
  of five is a seeded shuffle of **Air Raid** (wasps, then hornets and
  raptors), **Armour Column** (stingers, lancers, titans), **Artillery**
  (mortars with escorts) and **Mixed Assault**, then a **Boss** wave (Titan
  Spearhead, Bomber Wing or Elite Strike Force, in a seeded order). Wave 1 is
  always a small ground wave.
- **Budgets** grow as (240 + 228·n^1.4) scrap × difficulty (0.7 / 1 / 1.3),
  boss waves ×1.1; units arrive at veterancy rank 1 from wave 6 and rank 2
  from wave 12, bosses one rank higher. They are ordinary units under the
  normal rules — no stat cheats.
- **Spawning**: waves enter from map-edge sites (corners and edge midpoints
  far from the HQ, each snapped to ground the HQ can be driven to from) picked
  per wave, never the same edge twice running. At most **30** wave units live
  at once (phone frame rate); the rest queue off-map and stream in.
- **Marching**: a wave moves as a formation — units more than 3 tiles ahead of
  its rear wait — until it is within 12 tiles of its objective, under fire,
  or 50 s old. Then each unit picks targets: air raids hunt harvesters,
  artillery shells turrets and SAMs, columns hit the nearest structure,
  bosses go for the HQ. (Measured: strung-out waves were trivially farmed.)
- **Announcements**: the next wave's theme is in the top-bar pill from the
  start of its countdown ("Wave 8 · 0:42 / ✈ Air Raid"); 15 s ahead a banner
  names it and its edge, the pill pulses red, a minimap arrow and an
  above-the-fog map marker point at the entry. Clearing the field pays
  60 × wave scrap ("Wave 7 cleared · +420") with a counter tip for the next
  theme, and brings the next wave within 30 s. With the field clear, the
  **Call wave** chip brings it now for (5 + n) scrap per second skipped.
- **AI**: a defending commander (spectator "Watch AI defend", and the tuning
  harness) never raids or assaults, adds turrets and SAMs to its build,
  holds a line toward the announced edge, engages wave units it can see near
  the base, and calls waves early when its army is ≥ 1.8× the next budget.
- **Salvage**: wave units leave wrecks worth just 5% of their cost
  (`SURVIVAL.waveWreckShare`, carried on the run's survival state, so
  skirmish wrecks keep their 30%); the defender's own losses salvage as
  usual. At 30% the waves were an economy: a defender salvaged 17–116k
  scrap a run, and the median run lasted 30 waves for the AI and 50 (the
  45-minute cap) for the scripted player.
- **Calldowns** stay the player's (the waves have none) and are worth
  about a wave: the scripted player below survives a median of 11 waves on
  Normal when it also fires Sky Hammers and Barrages at wave clumps near
  its base and a Drop Pod when outgunned, 10 without. The AI defender
  gets nothing measurable from its own (median 15 waves with or without;
  `--no-calldowns`), so they don't make the mode easier.
- **Tuning** (`npx vite-node tools/survival.ts both all all 4`): waves
  survived, median (min–max), over 5 maps; the AI defender is a Normal
  Balanced commander:

  | Defender | Easy | Normal | Hard |
  |---|---|---|---|
  | Scripted "decent phone player" | 15 (14–27) | **10 (8–15)** | 8 (7–10) |
  | Normal Balanced AI | 19 (14–30) | **15 (9–22)** | 14 (9–29) |
  | *Before this pass (30% wrecks, n^1.3):* scripted / AI | | 50 (16–50) / 30 (14–51) | |

  Nobody fell within the first three waves. Most Normal runs end at a
  boss (wave 10 or 15): the first boss is the wall a decent player learns
  to beat. Waves stop growing at 36 units (around wave 14 on Normal) and
  ranks top out at wave 12, so a defender that holds past ~20 can run long.

### Career, medals, mutators and the Daily Op

Reasons to come back between matches. Spectated games never count.

- **Medals** (`sim/awards.ts`, pure functions of an end-of-match recap built
  from the chronicle): ⚡ Lightning War (win < 5:00), 🛡️ Untouchable (win, no
  building lost), 🔄 Comeback (win after your army fell to ≤ ½ of theirs and
  800+ behind, after 1:30), 💎 Flawless (win losing ≤ 5 units), 💰 Tycoon (win
  harvesting 2× theirs), and — in defeat too — 🎖️ Ace (one unit, 9 kills),
  🗿 Giant Slayer (3 Titans), ✈️ Air Superiority (30 aircraft), 🧱 Iron Wall
  (defences kill 30), ☠️ Exterminator (60 kills), 🏚 Wrecking Crew (12
  buildings); the battlefield's own feats, in defeat too — 🛰️ Orbital (one
  Sky Hammer destroys 1,000 scrap of units and buildings), ♻️ Scavenger
  (salvage 3,000 scrap from wrecks) and 💨 Steady Hands (dodge 3 enemy
  Barrages / Sky Hammers: at least 2 of your units under the reticle when it
  was called, nothing hit when it landed); Last Stand 🏰 Holdout (10 waves)
  and 🗼 Unbreakable (20). Thresholds were calibrated on 40 AI-vs-AI matches
  so a typical win earns one or two and the rest are goals. The chronicle
  records every calldown (`StrikeRec`: who, what, units exposed when called,
  hits and kills when it landed) for the battlefield medals, calibrated on
  120 more (60 to tune, 60 to check; % of sides): "any building" or "3 units"
  for one Sky Hammer were 44% and ~0% (its flat 700 flattens turrets and
  SAMs, while units get clear), so Orbital counts value — 22%; Scavenger at
  1,500 was 82% (AI sweeps; median 2,600–2,800 a side), at 3,000 42%;
  Steady Hands at 3 dodges 25–32%, with the AI's 0.6 s reflex. A human
  salvages and dodges by hand, so those two should land lower. Calldown
  kills no longer count toward Iron Wall.
- **Career** (`game/career.ts`, localStorage `battledrones.career`, pure math
  + try/catch storage): XP = win 100 / loss 30 (scaled down for losses under
  5:00) × difficulty (Easy 1, Normal 1.5, Hard 2.2), Last Stand 10 per wave
  × difficulty, +25 per medal, +100 for the day's first Daily Op win. Ten
  ranks — Cadet, Private, Corporal, Sergeant, Lieutenant, Captain, Major,
  Colonel, General, Marshal (100 … 6,000 XP) — with chevron / bar / star
  insignia. Three **stars** per map × difficulty: win, win under 8:00, win
  without losing a building (classic rules only). Wins/losses, medal counts,
  Last Stand totals (bests stay in `battledrones.laststand`) and the Daily
  streak. Banked once when the HQ falls (`game/meta.ts settleCareer`).
- **Menu** (`ui/career.ts`): rank badge with XP bar under the logo (tap: the
  Career sheet — medals, star grid, Last Stand bests, rank ladder), the Daily
  Op card, a mutator picker, ☆☆☆ on each map card for the chosen difficulty.
  Landscape puts these in a column over the key art.
- **End screen**: a career block heads the after-action report (and the Last
  Stand screen): XP counts up and the bar fills, a promotion swaps the
  insignia with a PROMOTED ribbon and glow, medals pop in one by one (NEW on
  a first), new stars pop, the Daily streak shows. Spectators see each
  side's medals instead.
- **Mutators** (`sim/rules.ts`, `World.rules`, via `MatchOptions.mutators`;
  absent = classic, read through `rulesOf(w)`): ⚡ Blitz (3,000 starting
  scrap), 💰 Gold Rush (income ×1.5, multiplied on top of the AI's own
  `incomeMult`), 💥 Glass Cannons (damage ×2), 🔧 Rapid Fab (build progress ×2
  per tick), ✈️ Air War (no ground combat units, Fab Plants or SAM sites —
  measured: with SAMs every AI-vs-AI air war drew at 25:00), 🎖️ Veterans
  (combat units roll out at rank 1), ☀️ Clear Skies (no fog for either side).
  Skirmish only; both sides obey them (`unitBlocker`/`buildingBlocker` say
  "Disabled: Air War", the HUD shows ⛔). The AI picks a personality whose
  plan survives the rules (`strategyFits`: no Rush/Ironclad in Air War) and,
  in Air War, plays the air-only plan with more bombers and one big wave.
  Shown in an opening banner, the pause screen and the end screen.
- **Daily Op** (`game/daily.ts`): the local date hashes into a map, an AI
  personality, Normal or Hard, two compatible mutators and the match seed —
  the same match for everyone. Its own rematch, +100 XP for the first win of
  the day, and a win streak that survives until a whole day passes without
  a win. No stars (it is always mutated).
- AI-vs-AI sanity (50 matches each, 25:00 cap): classic 48/50 decisive,
  median 5.6 min; Blitz 47, Gold Rush 46, Glass Cannons 43, Rapid Fab 48
  (median 4.2), Veterans 46, Clear Skies 47; Air War 13/20. The next 21
  Daily Ops all finished (median 4.7 min).

### Ops (a short scenario campaign)

Eight handcrafted 3–7 minute missions on the existing maps and units, each
with a twist objective and three stars: ★ complete it, ★★ and ★★★ two harder
conditions. They teach the counter web through play and give the game a
completion goal.

- **Data, not code paths** (`sim/ops.ts`): an `OpDef` is a map, an enemy (an
  AI commander with a fixed personality and difficulty, optionally tweaked —
  e.g. one that never attacks — the Last Stand wave director, or nobody),
  rules (per-side bans, a frozen economy, mutators: `World.rules` gained
  `sideBans`, `sideIncome` and `banLabel`, so `unitBlocker`/`buildingBlocker`
  say "Disabled in this op" and bind the AI on its side too), a `setup` that
  pre-places buildings and units and tags what must be protected, primary
  goals and two star conditions. `createMapWorld(map, { op })` builds it.
- **Goals** are pure functions of the world, checked once a second by
  `tickOps()` (called from `step()` only when `World.ops` is set): destroy the
  HQ, destroy N of a kind, survive N seconds, survive N waves, deliver N
  scrap, protect a tagged group (or ≥ N of a kind), within N seconds, lose at
  most N units / of a kind / buildings. Meeting every achievement goal wins;
  breaking a condition (time, protected group, losses) loses; an HQ kill still
  ends it the classic way. The result sets `World.winner`, so the finale
  (without HQ blasts when no HQ died), report and career run unchanged.
- **The ops** (verified by `tests/ops.test.ts`: each sets up on legal ground,
  runs, is completed with ★★+ by at least one stand-in pilot — an AI
  commander or a scripted player from `tests/ops-pilots.ts` — and is *lost*
  by doing nothing; `npx vite-node tools/ops.ts` prints the numbers):

| # | Op | Map | Enemy | Objective | ★★ / ★★★ |
|---|---|---|---|---|---|
| 1 | 🌉 Bridgehead | Riverlands | Rush, Hard, bigger waves | Hold 4:00 with a bridge turret standing (forward outpost pre-placed) | lose ≤ 6 · both turrets |
| 2 | 🌙 Harvest Moon | Dune Sea | Air Swarm, Hard, early Wasps | Deliver 10,000 scrap by 5:00 | ≤ 1 harvester lost · by 4:00 |
| 3 | 🎯 Decapitation | Proving Grounds | Balanced, Easy, never attacks | Strike group, no production, no calldowns: HQ by 3:00 | lose ≤ 4 · under 2:00 |
| 4 | ❄ Frozen Assets | Frostbite | Boom, Normal | 3,000 scrap, no income (not even salvage) or harvesters, no calldowns: HQ by 6:00 | 4 harvesters killed · under 4:00 |
| 5 | 🏴‍☠️ Sky Pirates | Ashlands | Balanced, Easy, digs in on half income | No Fab Plants or ground units (air only; the Drop Pod lands Wasps), pre-placed SAMs: HQ by 7:00 | lose ≤ 12 · under 4:30 |
| 6 | 💥 Glass Jaw | Dune Sea | Rush, Normal | Glass Cannons + Rapid Fab: HQ by 6:00 | lose no building · under 4:00 |
| 7 | 🛡 Iron Tide | Frostbite | Ironclad, Hard | Hold 6:00 (Fab Plant + Tech Lab given) | 2 Titans killed · ≤ 1 building lost |
| 8 | 🕯 Last Light | Riverlands | Last Stand waves (Easy budgets, first at 0:45, every 40 s) | Survive 10 waves from a dug-in base | ≤ 2 buildings lost · under 7:00 |

- **Measured** (stand-in pilots, `npx vite-node tools/ops.ts all 6`, after
  the final balance pass): idle play loses every op; the scripted pilots
  clear seven of the eight on every seed (Bridgehead ★★ at 4:00, Harvest
  Moon ★★ ~4:10, Decapitation ★★ 1:17, Frozen Assets ★★ 1:40, Sky Pirates
  ★★ 2:52, Iron Tide ★★★ in 5 of 6, Last Light ★–★★ ~7:40) and Glass Jaw
  ★★★ ~2:55 in 4 of 6 (Glass Cannons makes it swingy: 5 of 6 before the
  pass). A stock Balanced AI commander clears six of the eight at least
  once (Last Light every time, ★★) — it leaves the bridge to attack in
  Bridgehead and wastes its fixed budget in Frozen Assets.
- **Campaign**: the first three ops are open; every op completed opens one
  more. Progress (best star mask, best time, attempts) lives in the career
  (`CareerData.ops`); XP: 60 per clear, +100 the first time, +40 per new star,
  a little for a failure. Ops award no medals, map stars or skirmish W/L.
- **Menu** (`ui/ops.ts`): a third mode, 🎖 Ops: progress line, op cards in
  the map-card style (number, icon, stars or 🔒), the picked op's tagline and
  enemy; tapping the picked card or Play opens the briefing sheet (brief,
  rules, objective, star conditions with your best, a tip, Start op; two
  columns in landscape).
- **In match**: a briefing banner (`op-start`); a goal pill under the clock
  in portrait (top-left corner under the pause button in landscape, where the
  top bar is a full row): the objective and its clock, the other conditions,
  and three live stars (gold while the condition holds, struck out when
  lost). Tapping it opens the objectives card. "★★ lost" / "★★★ secured"
  toasts, a one-minute call-out (`op-timer`), the camera opens on the action
  (`OpDef.focus`). No tutorial hints in ops. The pause screen lists the goals.
- **End screen**: "OP COMPLETE" / "OP FAILED" heads the after-action report,
  with the reason, big stars (new ones pop), the star conditions, your best,
  "New op unlocked", the op's tip after a failure, and Next op / Retry / Main
  menu. Rematch tokens are `op:<id>`.

## Controls & UI (mobile-first, full-screen)

### Full-screen behavior

The game owns the entire screen — no page chrome, no scrolling, no
accidental browser gestures:

- **Installed as PWA:** `display: "fullscreen"` in the manifest.
- **In-browser play:** the Play tap requests the Fullscreen API where
  available (Android); on iOS Safari we rely on `100dvh` layout.
- **Viewport hygiene:** `100dvh`/`100dvw` sizing, `viewport-fit=cover` +
  `env(safe-area-inset-*)` padding, `touch-action: none`,
  `overscroll-behavior: none`, `user-select: none`, context-menu and iOS
  gesture/page-zoom suppression (with a rescue button if iOS zooms anyway).
- **Hi-DPI:** the canvas renders at the device pixel ratio (capped at 2×)
  and is CSS-scaled down, so painted art is crisp on phones.

### Touch gesture spec

| Gesture | On | Action |
|---|---|---|
| Tap | Own unit | Select it |
| Tap | Own building | Select it (production queue, sell, rally) |
| Tap | Enemy / ground / scrap | With selection: attack / attack-move / harvest |
| Tap | Ground, building selected | Set rally point |
| Double-tap | Own unit | Select all on-screen units of that type |
| Drag (one finger) | Anywhere | Pan (with momentum) |
| Long-press then drag | Anywhere | Box-select (prefers combat units over harvesters) |
| Two-finger drag / pinch | Anywhere | Pan / zoom |
| Tap / drag | Minimap | Jump / scrub the camera |
| Long-press | Build button | Info card: stats, counters, cancel queued |
| Tap | Map, while placing | Move the ghost there (no build yet) |
| Tap / drag | The ghost | Build it / slide it |
| Long-press / tap / double-tap | Squad chip 1–3 | Save the selection / select the squad / fly the camera there |

Disambiguation: a touch is a *tap* if it moves < 8 px and lasts < 250 ms;
movement beyond the slop radius before the long-press timer fires commits
to *pan*; after the timer fires it commits to *box-select*. Hit-testing
uses an enlarged (≥ 24 CSS px) radius, and aircraft are tested where they
are drawn (lifted above their shadows).

Context **chips** above the build bar, after the three squad chips: Stop /
Move only / deselect for units; Sell (+refund) for buildings (producers
show "Tap the map to set a rally point" in the selection panel instead of a
chip); "Select army" and "💤 Idle N" when nothing is selected;
"✓ Place X" (or why not) + cancel while placing. Under 400 px wide the
labels shorten ("Move", "Army") so everything stays on one row down to
360 px.

### Mouse & keyboard

Left-click select (Shift+click adds or removes a unit), left-drag
box-select, right-click command, wheel zoom,
middle-drag or arrows/WASD pan, +/− zoom, P or Space pause, Q select army,
Delete sell, Esc cancel/deselect, `.` game speed, J jump to the action,
1–3 select a squad (twice quickly: fly there), Ctrl/Cmd/Shift+1–3 save
one (Shift for browsers that keep Ctrl+digit for tabs). While placing, the
ghost follows the mouse, a click builds and a right-click cancels. Hold
the clock to fast-forward. Right-click a build button for its card, or a
squad chip to save into it.

### HUD layout — portrait and landscape both first-class

DOM overlaid on the canvas, re-flowing by orientation:

- **Portrait:** a bottom dock — selection panel and chips above a tabbed
  build bar (Base / Vehicles / Aircraft) with unit portraits, costs, lock
  icons, queue badges and progress fills. Minimap top-right; scrap,
  income rate and clock top-left.
- **Landscape:** the build bar becomes a right-edge sidebar with a 2-column
  grid; selection panel and chips sit bottom-right beside it.
- **The top band** grows by mode: pause + mute, the top bar (scrap; clock +
  speed chip; Last Stand's wave pill; an op's goal pill — in landscape the
  op pill takes the corner under the pause button; the spectator's
  two-line "● Blue · opener / ● Red · opener" pill), the battle meter's
  slot under it, and the minimap. `ui/layout.ts` measures what it really
  occupies on every layout change and places what sits below it: the
  **ticker** under the band in its column (the meter's slot is always
  reserved, so the ticker doesn't jump when a fight starts), and the
  **banner** centred over the battlefield (on the top bar's axis in
  landscape) under the band across its width, never wider than the gap to
  the landscape minimap. Portrait keeps one ticker line's slot between the
  two, so neither moves; landscape has no height to spare, so the banner
  sits right under the top bar and the ticker's newest line steps down
  under it (one text line) while it shows.
- **Objectives pill** beside the clock: a 📡 pip per Uplink in its
  holder's colour (yours nearest first; pulsing while it's being taken)
  and the 📦 drop timer (next drop, gold while one is inbound, then how
  long landed crates have left).
- **Calldown buttons:** the ⚡ meter and four round power buttons on the
  right edge in portrait, centred but kept under the banner's slot and
  above the chip row (the selection panel stays left of them); on
  landscape phones a 2×2 block under the minimap beside the sidebar, with
  the meter beside it so the block clears the selection panel. Edge arrows
  slide past them; spectators don't get them, and a match whose rules ban
  every Drop Pod crew has no Drop Pod button.
- **Zoom stack** (＋, −, ⚡ jump to the action): left edge in portrait, the
  bottom-left corner in landscape (leaving the left column to the ticker).
- A ticker of short toasts for "building ready", attacks (tap to jump
  there) and hints; minimap pings where you're being hit (amber double
  rings for an inbound raid). The clock row carries the game-speed chip, a
  battle meter hangs under it during on-screen fights, edge arrows point at
  off-screen fights, and ⚡ jumps to the action. The scrap pill bumps when a
  harvester delivers and flashes red when scrap is spent. Touch targets are
  at least 40 CSS px (slim pills and tabs get a bigger invisible hit area).
- **Sound:** the top-left speaker (in game and on the menu) is a one-tap
  master mute. The pause menu has four toggles, persisted in
  `localStorage` (`battledrones.audio`): Sound (master), Music (score and
  ambience), Effects, and Voice. Voice cycles through Voice (announcer
  speech and unit chirps), Chirps (no speech: unit chirps and radio codes)
  and off, and plays a "radio check" sample.

### Minimap

Painted-map thumbnail under the fog, resource fields, salvageable wrecks
(gold dots), buildings and unit blips (fog-respecting), Uplink diamonds in
their holder's colour and blinking supply crates (public), calldown reticles
(red = enemy, gold = yours, shown through the fog), attack pings and the
camera frame.

## Art

See **ART.md** for the generation pipeline (prompts, processing, terrain
painting). Summary: the terrain materials, decorations, HUD portraits, the
key art and the app icon were generated with OpenAI's
`gpt-image-2.5-sunburst`; the battlefield itself is 3D (below).

## 3D view

The battle is drawn with three.js (`src/game/three/`, wired up by
`game/GameScene.ts`). World units are tiles: x east, z south (the sim's y),
y up.

- **Camera** (`three/camera.ts`): a perspective rig looking north and down
  at a ground point. Zoom is CSS px per tile at that point (18–110); the
  pitch eases from 62° zoomed out (a strategic, near top-down read) to 47°
  close in. Pan keeps the ground under the finger, pinch/wheel zoom keeps
  the point under the anchor, and every screen↔ground conversion (taps,
  edge arrows, the minimap's view trapezoid, earshot) goes through it.
  Shake is an offset in the camera plane.
- **Terrain** (`three/terrain.ts`, with `terrain-glsl.ts`, `terrain-props.ts`,
  `terrain-tex.ts` and `terrain-bridges.ts`): the map grid becomes a
  heightfield (3 samples per tile): each terrain type has a base height
  (rock +0.95, water and lava −0.55, fords −0.2) blended over about a tile,
  plus terrain-weighted fractal noise (craggy rock, lumpy rough ground). The
  painted terrain chunks are draped over it as the albedo, so the painted
  hillshade and the real lighting agree; a cheap unsharp mask and a fine
  grain embossed from the north-west keep the 48 px-per-tile paint crisp
  close in. The outcrops' steep **cliff walls** don't show the drape (it
  smears down a wall): the ground shader fades there to the biome's own
  painted rock material — granite, red sandstone, basalt with snow, obsidian
  (`public/assets/textures/rock-<biome>.webp`) — projected sideways in world
  space so desert strata run level, tinted per tile from the paint above
  and darkened toward the foot. Flat tops keep the paint. **Crags** on the
  outcrops (one merged mesh) are textured with the same stone, triplanar per
  facet, over their painted-rock tint, in a matte stone material; Frostbite's
  get frosted caps. Without the texture everything falls back to the
  untextured look. On top: a water/ice/lava surface whose opacity and colour
  come from the depth under it — water with soft sun glints and lapping
  foam; Frostbite's frozen sea an ice shelf over the fords breaking into
  drifting, cracked floes; Ashlands' lava a molten flow with yellow-hot
  veins under drifting crust plates that glow at their rims. Each bridge is
  one deck laid along its crossing (timber planks, kerbs and rails;
  riveted steel with a truss on Ashlands) on piers and abutments. Instanced
  trees per biome, salvage heaps of hull plates, girders and drums, and
  crystal clusters (instance matrices shrink as they're mined). **Past the
  map's edge** the land carries on for 20 tiles as a skirt: the paint
  mirrored, dimmed and greyed at the boundary so the playable area reads,
  easing into the biome's open ground and then into the sky colour, so the
  world never ends in a void. Its fog lookup mirrors back into the map, so
  it never shows more than the map tile it reflects. Units ride the surface:
  ground vehicles pitch and roll with the slope, fords sink them a little,
  hover tanks ride over water.
- **Models** (`three/models.ts`, `three/builder.ts`): every unit, building
  and objective is built from primitives in code, merged into one
  vertex-coloured geometry per moving part (hull, turret/head, rotor,
  cargo) so a vehicle is a couple of draw calls. Units face −Z and are
  scaled to the sizes the painted sprites had (×1.12 for 3D readability).
  A per-vertex glow weight lights lamps, engines and crystals. The builder
  can bake shading into the vertex colours (each part darker toward its
  base, ground models darker near the ground) and has chamfered `block` /
  `drum` primitives whose lightened top bevel is the painted art's edge
  highlight. Every unit carries a solid team patch on top (turret roof,
  fenders, rotor ducts, wing bands) so red vs blue reads at phone zoom; the
  HQ's command cab, team bands and tower caps make it the base's
  centrepiece; rubble is a cracked, scorched foundation with wall stubs and
  bent girders.
- **Materials** (`three/materials.ts`): one shared, flat-shaded model
  material with uniform variants — hit flash (warm light over the shaded
  model, barely bleaching the paint), building hit (fire light), damaged
  (greyed, sooty), burnt wreck (neutral charcoal, matte), elite (a gold edge
  light and a glint sweeping over the hull), and green/red placement ghosts
  — that share one shader program, so swapping is free. Walls darken near
  the ground (contact shading), with or without shadows. Every lit material
  is patched to sample the **fog of war** texture (a texel per tile, blurred
  on the CPU, smoothed in the shader) by world position: unexplored ground
  is an opaque, biome-tinted **shroud** with slow wisps (from the cloud
  texture, looked up where the view ray meets the ground, so nothing under
  the shroud shows a silhouette) and a faint mist band at its edge;
  explored ground is a greyed **memory** of the terrain. At every fog level
  the ground shows through no more than under a plain half-darkening. The
  ground also takes the drifting **cloud shadows**, tinted per biome.
- **Effects** (`three/particles.ts`, `render/fx.ts`): two instanced quad
  pools (additive light, alpha-blended matter) plus a ground pool for flat
  marks, drawing from a 4×4 procedural atlas (ragged flame, sun-lit smoke
  puffs, shock ring, muzzle burst, shards, a soft scorch) built once per
  session. Explosions are layered — a hot flash, a ragged fireball cooling
  from yellow to red, sun-lit smoke that outlives the fire, embers, a shock
  ring, kicked-up dust and a scorch (none on water or lava); buildings add a
  blast front and a smoke pillar. Muzzle bursts, gun smoke and back-blast,
  tracers held to a minimum screen size, trails laid by distance flown,
  beams with a white core in a coloured sheath, wrecks that smoulder with
  oily smoke leaning downwind, and damaged buildings that smoke (and below
  25% burn) from their real roof. Particle records are recycled; per-frame
  paths don't allocate.
- **Ground marks** (`three/ground-gfx.ts`): an immediate-mode API in the
  shape of Phaser's Graphics (rings, arcs, lines, discs, rectangles) that
  drapes thick lines over the terrain with widths in CSS px — selection and
  combat rings, order lines, reticles, capture rings, the build zone. Lines
  are indexed, mitred polylines with a feathered edge and a soft dark halo
  (weaker for fainter strokes; `halo` 0 turns it off), so marks read on
  snow, sand and lava alike. The hierarchy is selection (2.5 px, opaque,
  a faint fill under our own units) > combat rings (1.6 px) > ambient. A
  selection's orders share one waypoint ring per target. Three layers: under
  the fog, through the fog, and on top of everything.
- **Screen overlay** (`three/screen.ts`): a 2D canvas over the WebGL view
  for health, production and harvester-load bars (one framed style: a 1 px
  rim with cut corners round a dark trough, on the device pixel grid),
  chevrons with a soft dark copy beneath, a marching-dash box select, and
  floating labels ("+100", "VETERAN", placement reasons on a plate that
  slides clear of the HUD), re-projected every frame.
- **Quality** (`three/stage.ts`): shadows from a sun about 48° up in the
  north-west (the painted art's light) that gives about half the light on
  flat ground, so models read with form; the shadow box follows the view;
  1024² shadow maps on touch devices, 2048² on desktop. The clear colour
  past the world's edge is a deep shade of each biome's ground. Shaders
  compile during loading.
  An adaptive controller watches the frame time and, when a device can't
  keep up, steps down in cost order — resolution to 1×, a smaller shadow
  map, no shadows, then resolution below 1× — and creeps back up when
  there's headroom. Software GL (a blocklisted GPU) starts at the cheap end.

## Architecture

```
src/
  sim/        # Pure TS, no engine. The authoritative game state.
    world.ts        # entities, tile grid, occupancy, passability
    balance.ts      # every tunable number: units, buildings, terrain, damage table
    maps.ts         # the 5 maps (seeded painter) + createMapWorld
    modes/survival.ts # Last Stand wave director (pure, seeded)
    rules.ts        # match mutators (World.rules) and their hooks
    ops.ts          # the Ops campaign: op definitions, goals, tickOps
    awards.ts       # medals from an end-of-match recap (pure)
    economy.ts      # scrap, harvesting, depots, tech rules, build queues, selling
    movement.ts     # terrain-weighted A* (ground/hover/air), steering
    combat.ts       # targeting, armor, splash projectiles, healing, veterancy
    fog.ts          # per-side visibility maps + building memory
    placement.ts    # why a spot can't be built on, and a suggested spot

    salvage.ts      # battlefield wrecks: spawn, cool, pick-up, burn-out
    powers.ts       # command meter, calldowns (Barrage/EMP/Drop Pod), Sky Hammer, EMP stuns
    objectives.ts   # Uplink capture bars and income, supply drops and crate rewards
    ai/commander.ts # the enemy commander: strategies, difficulty
    ai/veterans.ts  # wounded veterans fall back to a Mender or the HQ

    ai/salvage.ts   # the commander's wreck sweeps
    ai/powers.ts    # the commander's calldowns and its dodge reflex
    ai/objectives.ts # capture squads, Uplink garrisons, crate races
  game/       # three.js: scene, camera, input, rendering
    three/          # the 3D layer: stage (renderer, lights, adaptive quality), camera rig, builder + models,
                    #   terrain (heightfield, water, props, fog of war), materials, particles, ground-gfx, screen overlay, tweens
    render/         # entities, fx, juice-view, wrecks, powers (reticles, strikes), objectives
    juice.ts        # hit flash / damage trail / combat ring / cue rules (tested)
    audio.ts        # AudioContext, sfx/music/voice buses, settings, procedural SFX
    score.ts        # music rules: harmony, patterns, stingers, battle mood (tested)
    music.ts        # adaptive score: lookahead scheduler + synth voices
    ambience.ts     # biome ambience beds
    voices.ts       # unit chirp-voices: formant synth, line plans, rate limits
    callouts.ts     # announcer moments, kill streaks, radio queue (tested)
    announcer.ts    # radio announcer: squelch + speechSynthesis / radio code
    awareness.ts    # game speed + tempo safety, hotspots, inbound warnings, battle meter rules (tested)
    awareness-view.ts # wires them to the camera, HUD, radio; camera glide
    squads.ts       # squad (control group) rules (tested)
    advisor.ts      # counter advisor + idle-factory watch (tested)
    placement-view.ts # placement ghost: suggested spot, touch move/drag/confirm
    hints.ts        # one-time hint queue: pacing, priority, staleness (tested)
    heroes.ts, hero-fx.ts  # callsigns; promotion titles and hero toasts
    chronicle.ts    # match recorder + story analysis for the report
    calldown-credit.ts # which deaths a calldown caused (kill credit for callouts, chronicle, toasts, hotspots; tested)
    finale.ts       # the cinematic HQ kill
    career.ts, daily.ts, meta.ts  # XP/ranks/stars storage, the Daily Op, match glue
    ops.ts          # Ops narration: briefing banner, countdowns, star notices
  ui/         # DOM HUD (hud.ts; layout.ts: measured top band → ticker/banner/calldown placement; awareness.ts: speed chip, edge arrows, meter; command.ts: squad chips, advisor badges; objectives.ts: Uplink/drop pill; powers.ts: calldown buttons), after-action report (report.ts), career UI (career.ts), Ops UI (ops.ts), menu styles
art/          # image generation + processing pipeline (Python)
tools/        # map export, balance harness, pacing panel, smoke test, screenshot tour
```

- **Fixed-timestep simulation** (10 ticks/sec) decoupled from rendering
  (interpolated at display rate, driven by the raw frame delta so the game
  keeps real time even when the browser throttles its smoothed clock).
  Input produces **commands** applied at tick boundaries; the sim is
  deterministic and testable.
- One 2048² mipmapped sprite atlas (WebP, ~1.3 MB); painted terrain as
  1024 px chunks per map (48 px per tile).

## Explicitly out of scope (for now)

- Online multiplayer (the deterministic command-driven sim keeps the door
  open), a story campaign (Ops are standalone missions), map editor,
  replays, saves mid-match.
- Upgrades research, buildable superweapons (the Sky Hammer is a timed
  HQ power), walls.
