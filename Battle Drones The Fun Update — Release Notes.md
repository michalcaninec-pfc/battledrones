# Battle Drones: The Fun Update — Release Notes

Oct 7, 2026 · @Simon Willison

*The super-heavy tank these notes call the Mastodon shipped as the Titan; it was renamed when the Goliath mech arrived (GOLIATH.md).*

## What's new

The Fun Update went live at [simonw.github.io/battledrones](https://simonw.github.io/battledrones/) on 7 October 2026 ([PR #3](https://github.com/simonw/battledrones/pull/3)). Every skirmish and Daily Op now opens with a choice, gives the side that's losing a way back, and pulls the armies into the middle of the map. There are also two new ways to play.

- **Openers**: pick Blitz, Industry or Air Wing before the clock starts.
- **Call-down powers**: Barrage, EMP, Drop Pod and the Sky Hammer orbital strike.
- **Objectives and salvage**: Uplink relays, supply drops and wrecks worth scrap.
- **Feel**: combat juice, adaptive music, unit voices and an announcer.
- **Command**: battle alerts, game speed, saved squads and touch placement.
- **New modes**: Last Stand survival waves and an 8-mission Ops campaign.
- **Progression**: heroes, an after-action report with awards, a career, 7 mutators and a Daily Op.

Fights run longer and swing more. In 1,200 AI-vs-AI test matches on Normal, games still undecided after 25 minutes fell from 14% to 0.9%. The share of wins by a side that had been 800+ scrap behind rose from 24% to 46%.

## Openers

Every skirmish and Daily Op now starts with a choice. Three cards appear over the frozen battlefield, and the clock doesn't start until you pick one. The enemy picks too, and the screen tells you which AI personality you're facing.

| Opener | Pitch | Free building | Units | Harvesters | Starting scrap |
| --- | --- | --- | --- | --- | --- |
| 1 Blitz | Strike first. Raid their harvesters before they're ready. | Fab Plant | 3 Stingers | 2 | 500 (−100) |
| 2 Industry | Out-mine them now, out-build them later. | Fab Plant | None | 3 | 800 (+200) |
| 3 Air Wing | Own the skies. Wasps hunt tanks and harvesters. | Airpad | 3 Wasps | 2 | 600 |

- Tap or click a card, or press 1, 2 or 3. "‹ Menu" goes back to the menu.
- Your factory appears about 4.5 tiles from your HQ, toward the middle of the map. Its units wait in front of it, and every harvester is already mining.
- The AI's pick follows its personality:
  - Rush plays Blitz.
  - Boom plays Industry.
  - Air Swarm and Skyforce play Air Wing.
  - Ironclad plays Blitz or Industry.
  - Balanced plays any of the three.
- AI raiders stay home for the first 45 s.
- Under the Air War mutator, Blitz and Industry are greyed out with "Disabled: Air War". Under Veterans, your opener's units start at rank 1.
- Last Stand and Ops have no openers. When you watch AI vs AI, both sides pick instantly.

## Call-down powers

Each side now has four strikes, fired from the round buttons on the right of the screen, next to the ⚡ Command meter. Three of them spend a shared Command meter. The Sky Hammer comes online at 6:00 and runs on its own cooldown.

### The Command meter

- It fills slowly over time: 0.035 a second, up to 100.
- Each Uplink you hold adds 0.06 a second, and a charge supply crate adds 40.
- Losses fill it 4× faster than kills: 0.008 per scrap of your own units and buildings destroyed, against 0.002 per scrap you destroy. The side that's losing gets its strikes sooner.
- In AI-vs-AI testing, each side called a median of 6 strikes per match.

| Power | Cost | Cooldown | Warning | Radius | Effect |
| --- | --- | --- | --- | --- | --- |
| Barrage | 60 charge | 45 s | 2.5 s | 2.9 tiles | 3 shells, 0.3 s apart. Each does 170 damage with 2-tile splash. Hits ground units and buildings, not aircraft. |
| EMP | 40 charge | 40 s | 0.8 s | 3 tiles | No damage. Enemy units, aircraft included, and buildings freeze for 4 s: they can't move, fire, heal, mine or produce. |
| Drop Pod | 70 charge | 60 s | 2 s | 1.2 tiles | Lands 2 Stingers and a Flak Crawler, or 2 Lancers and a Flak Crawler while you have a Tech Lab. Enemies under it take 60 damage. |
| Sky Hammer | No charge; online at 6:00 | 150 s | 3 s | 2.5 tiles | Up to 260 damage to every enemy unit, ground and air, ignoring armour (130 at the edge). Every enemy building in range takes 700. Your own side is safe. |

### Firing a strike

1. Tap or click a glowing power button. A "Tap map: Barrage" chip appears, and a radius preview follows your finger or cursor.
2. Tap the map to fire. Where the strike can't go, the preview turns grey with a red ✕. An invalid tap tells you why and keeps the power armed.
3. To cancel, tap the button again, tap ✕, press Esc or right-click.

- You can target any explored ground, including ground under fog. A Drop Pod needs open ground that you can see right now.
- Long-press or right-click a button for its details. A button that isn't ready says why, for example "Barrage recharging: 12 s" or "Sky Hammer comes online at 6:00".
- Every power needs your HQ standing.

### Seeing it coming

- Every strike is telegraphed above the fog as a reticle that shrinks until impact. The enemy's reticles are red, and they also show on the minimap. The Sky Hammer adds an orbital lance.
- An enemy strike sounds a siren. If it threatens your units or buildings, you get:
  - a minimap ping
  - an alert if the strike is off screen
  - a radio line: "Incoming artillery!", "EMP inbound!" or "Enemy drop pod!"
  - a drop back to 1× speed
- At 6:00 a "Sky Hammer online" banner appears. An enemy Hammer gets "Enemy Sky Hammer inbound! Get clear of the red circle".
- You can dodge by moving units out of the reticle before it lands. The AI dodges too, after a reaction time of 1.1 s on Easy, 0.6 s on Normal and 0.4 s on Hard.

### Credit and medals

- Big strike kills, such as a Mastodon, a Hornet or an elite unit, are named on the radio, for example "Enemy Mastodon destroyed by a Barrage". A strike that destroys a building gets "Direct hit!", and several kills from one strike get banners like "Sky Hammer: triple kill".
- The after-action report has a Calldowns row.
- Two new medals:
  - **Orbital**: destroy 1,000 scrap with one Sky Hammer.
  - **Steady Hands**: dodge 3 enemy Barrages or Sky Hammers in one match. Each must have had at least 2 of your units in its circle when it was called, and hit nothing.

### Where powers apply

- **Skirmish and the Daily Op**: both sides have them.
- **Last Stand**: only you have them, Sky Hammer included.
- **Ops**: every mission except Decapitation and Frozen Assets, whose briefings say "⚡ No calldowns".
- **Mutators**:
  - Under Air War, a Drop Pod lands 2 Wasps and a Raptor.
  - Under Veterans, its crew starts at rank 1.

## Map objectives

Skirmishes, the Daily Op and AI-vs-AI matches now have two prizes to fight over away from the bases: Uplink relays and supply drops. Last Stand and Ops don't have them.

### Uplink relays

- Riverlands has 3 relays: the centre bridge and both fords. Every other map has 2, one on each flank.
- To capture a relay, move units into its 2.5-tile ring. There's no button.
- More units capture faster. One unit takes about 29 s to capture a neutral relay; four or more take about 7 s. Aircraft and unarmed units count half, and harvesters don't count.
- If both sides have units inside, the bar freezes. To take an enemy relay, you first knock it back to neutral (about 7 s with four units), then capture it.
- A relay you hold never decays while it's empty: its bar drifts back to full. A half-finished capture of a neutral relay slowly drifts back to neutral once everyone leaves.
- A held relay:
  - pays 1.5 scrap a second (90 a minute)
  - gives 7 tiles of vision
  - adds 0.06 a second to your Command meter
- Relays show through the fog in the holder's colour, or gold when neutral, and pulse orange when contested. They also appear as diamonds on the minimap. In the top bar, 📡 is followed by one dot per relay in its holder's colour, and a dot pulses while its relay is contested.
- Banners and alerts:
  - "Uplink captured"
  - "Uplink lost: get units back on it before they take it"
  - "⚠ Uplink under attack!" when the enemy starts taking one of your relays off screen

### Supply drops

- The first drop lands at 1:30, then one every 75 s. Each is announced 10 s ahead, and the banner says what's inside.
- Each drop is two identical crates, one on each half of the map. Every map has 3 mirrored drop sites. A crate burns out 45 s after landing.
- The first unit to reach a crate claims it instantly. Ground or air units can claim; harvesters can't.
- A "📦 m:ss" countdown in the top bar shows when the next drop lands.

| Crate | Chance | Effect |
| --- | --- | --- |
| Scrap | 38% | +200 scrap |
| Veterans | 20% | +1 rank for your units within 3 tiles, up to rank 3 |
| Command charge | 17% | +40 charge for your Command meter |
| Field Repair | 15% | Your units within 4 tiles heal 50% of their max HP |
| Free Lancer | 10% | A rank-1 Lancer, announced as "Rare supply drop!" |

A crate that would do nothing, such as a repair kit with no wounded units nearby, pays 150 scrap instead.

### How the AI plays them

- **Uplinks**: the AI sends capture squads from 0:20 and garrisons relays it holds.
  - Boom only holds its own flank.
  - Ironclad prefers the centre.
  - On Easy, the AI never retakes a relay from you.
- **Supply drops**: the AI races units to crates within 30 tiles, or 18 on Easy.
- **After the match**: the report adds "Uplinks captured", "Crates claimed" and "Objective scrap" rows.

## Salvage

Destroyed units now leave wrecks worth scrap, so a fight in the open pays whoever holds the ground afterwards.

- Every unit except a harvester leaves a wreck worth 30% of its cost, ground and air alike. That ranges from 23 scrap for a Scout to 143 for a Mastodon. Buildings leave no wreck.
- A wreck is too hot to touch for 2.5 s, then glints gold. It lasts 60 s and fades over its last 10 s.
- Drive any ground unit over a wreck, harvesters included, to collect all of it at once. Aircraft can't collect. Either side can take any wreck.
- Your pickups pop a gold "+N" with a coin sound. Collecting 400+ scrap within 9 s triggers a "Salvage haul" banner.
- Wrecks you've seen show as gold dots on the minimap. Salvage counts toward your +N/m income readout.
- Gold Rush pays 1.5× for salvage too.
- The AI sends idle units for wrecks it can see. It avoids wrecks near enemy armies or defences.
- The after-action report has a "Scrap salvaged" row, and the new Scavenger medal needs 3,000.
- In Last Stand, wrecks from the waves are worth only 5%. Your own are worth the usual 30%, and the waves can't collect.

## Feel: juice, music and voices

Combat now hits harder on screen and in your ears. Hits flash, deaths shake the screen, and the music builds as the fighting does. All sound is synthesised live in the browser, with no recorded samples.

### Combat juice

- **Hits**: a unit flashes white for 70 ms, and a building glows for 100 ms. Lost HP lingers as a pale chunk for 300 ms before it drains. Enemy health bars blink below 25%.
- **Team rings**: a blue or red ring sits under any unit that fired or was hit in the last 3 s, so you can tell sides apart in a melee.
- **Kills**: an expanding ring in the dead unit's colour plus a two-note ting. Your own losses play a power-down whine.
- **Screen shake** grows with what died, and only for deaths on screen. A unit gets 90 ms, a Mastodon or Hornet 140 ms, a small building 250 ms, a 2×2 building 340 ms, and an HQ 600 ms. A Sky Hammer impact shakes for 520 ms.
- **Income**: each harvester delivery pops a gold "+N" over the drop-off. Quick deliveries climb a scale in the map's musical key.
- **Promotions** pop in a new chevron, and elite units shimmer gold.
- **Phones** vibrate briefly when you lose a building (Android only).

### Adaptive music

- Five layers come in on bar lines as the fighting builds:
  - a pad, always on
  - a calm melody, which fades out once fighting starts
  - bass
  - drums, which enter with a crash
  - an arpeggio at full intensity
- Intensity follows visible shots, attacks on your base, your losses and calldown impacts. Once the shooting stops it eases back down slowly, but the bass stays in for 8 s after your units fight.
- While your base is under attack, the arpeggio turns tense for up to 15 s.
- Each map has its own instruments:
  - kalimba on Riverlands and Proving Grounds
  - oud and tabla on Dune Sea
  - glass bells on Frostbite
  - marimba and distorted bass on Ashlands
- Each map also has a quiet ambient bed under the music: wind and birdsong, desert wind, an arctic whistle or a volcanic rumble.
- Stingers mark the big moments:
  - a drum and brass hit for First blood
  - a rising brass call for Sky Hammer online, supply drops and Rampage
  - low stabs for Uplink lost or an incoming enemy Sky Hammer
  - a victory fanfare or a defeat lament at the end

### Voices and the announcer

- Each of the 11 unit types has its own robot chirp. Units chirp when selected, when ordered, when they roll out and when they're promoted.
- A radio announcer uses your browser's text-to-speech and plays a squelch before each line. It reads every banner and calls the battle: "Warning: our HQ is under attack", "Enemy aircraft detected", "Incoming artillery!", "Construction complete", "Structure lost".
- Kill banners:
  - First blood
  - Double kill (2 kills within 4 s), Triple kill and Rampage (5)
  - Mastodon down, Hornet down, and Elite … down for an elite unit
  - Direct hit! when your strike destroys an enemy building
- Other banners:
  - Uplink captured and Uplink lost
  - Supply drop inbound and Rare supply drop!
  - Sky Hammer online
  - Salvage haul
  - your opener's name as the match starts
- Tap a banner, or a radio caption marked ›, to jump the camera there.
- Spectators hear a neutral caster, for example "Double kill for Red".

### Audio settings

- The 🔊 button at the top left mutes everything in one tap, in a match and on the menu.
- The pause menu has four toggles. Open it with ❚❚, P or Space.
  - 🔊 Sound
  - 🎵 Music, which covers the score and the ambience
  - 💥 Effects
  - 🗣 Voice, which cycles Voice → Chirps (no speech) → off
- The device remembers these settings.

## Command and battle awareness

You now hear about trouble anywhere on the map and can get there in one tap. Squads, game speed and a new placement flow make a phone screen easier to command.

### Alerts

- An attack you can't see raises an alert: "HQ under attack!" (new), "Base under attack!" or "Units under attack!". There's at most one every 12 s, and every hit pings the minimap.
- Raids are flagged before they land. When armed enemies come within 12 tiles of your buildings or harvesters, a siren sounds and amber rings appear on the minimap.
- The first air raid and the first ground raid each get a banner with a counter tip, for example "Drones inbound" with "Counter: Flak, Raptors or a Turret".
- Up to 3 pulsing arrows at the screen edge point at action you can't see. Their labels are HQ!, Base, Harvesters, Units, Attack, Raid and Air raid. Red means you're being hit; amber means you're attacking.
- Tap an edge arrow to glide the camera there. Tap an alert, a banner or a radio caption marked › to jump there.
- The ⚡ button under the zoom controls, or the J key, cycles through the hotspots, most urgent first.
- A You/Foe battle meter under the clock flashes "Turning point!" when the balance of the fight shifts.

### Game speed

- Tap the speed chip beside the clock to cycle 1×, 1.5× and 2×, or press the . key. Spectators also get 4×.
- Hold the clock to run at 3× for as long as you hold it.
- Above 1×, the game drops back to 1× by itself and says why when:
  - an enemy strike threatens you
  - your HQ comes under a new attack
  - a raid is called out
- Pause still works: ❚❚, P or Space.

### Squads

- Three squad chips sit in the command row. They're on the left in portrait and on the right in landscape, and they don't move when the selection changes.
- Hold a chip for 0.4 s to save the current selection to it. Hold it with nothing selected to clear it.
- Tap a chip to select its squad. Double-tap to glide the camera to the squad.
- Keyboard: 1–3 select a squad, and pressing the key twice flies the camera there. Ctrl, Cmd or Shift with 1–3 saves.
- Each chip shows the squad's unit icon, count and health, and flashes red when a member is hit. A unit belongs to one squad at a time.
- The command row also gains a "💤 Idle N" chip, which appears when part of your army is standing idle.

### Placing buildings

1. Tap a finished building on the build bar, or tap its toast, for example "Fab Plant ready — tap here to place it". A ghost appears on a suggested valid spot, and the camera glides there if needed.
2. Tap the map to move the ghost. It snaps one tile onto a valid spot when that's enough. You can also drag it.
3. Tap the ghost, or the "✓ Place" chip, to build.

- A breathing green ghost is a valid spot. A red ghost says why it isn't, for example "Too far from base", "Blocked" or "Unit in the way". Your build zone is tinted green.
- With a mouse, the ghost follows the cursor and a click builds. Right-click or Esc cancels.

### Advisor and tips

- A build button lights an amber ⚔ when you've seen at least two enemy units it counters in the last 60 s. The light goes out once your own force of that unit, built and queued, is worth 75% of those enemies.
- Long-press a button to see what it counters, for example "⚔ Counters Wasps (seen ×4)".
- An IDLE tag appears on the Vehicles or Aircraft tab when its queue has been empty for 6 s and you can afford a unit.
- New 💡 tips cover squads, placement, calldowns and salvage. Each one shows once per device, at most one every 12 s.
- The pause menu's How to play has new Squads and Speed entries, and its Camera entry now explains the edge arrows and the ⚡ button.

## New mode: Last Stand

Last Stand is a survival mode. You defend your HQ against endless waves that keep getting bigger, and your score is the number of waves you survive.

### Starting a run

1. Choose the 🛡 Last Stand tab on the menu.
2. Pick any of the 5 maps and a difficulty.
3. Tap "▶ Start Last Stand", or "🤖 Watch AI defend" to watch the AI play it.

- You start with your HQ, 1 harvester and 600 scrap.
- There are no openers, Uplinks, supply drops or mutators.
- Your call-down powers work, Sky Hammer included. The waves have none.

| Difficulty | First wave lands | Wave size | XP per wave |
| --- | --- | --- | --- |
| Easy | 1:50 | ×0.7 | 10 |
| Normal | 1:35 | ×1 | 15 |
| Hard | 1:25 | ×1.3 | 22 |

### The waves

- After the first wave, a new one comes every 50 s, or 60 s after a boss.
- Clearing the field brings the next wave forward to at most 30 s away. Once the field is clear, the "⏩ Call wave N" chip starts the next wave's 15 s warning straight away and pays a bonus for every second you skip.
- Each block of five waves has four themed waves in shuffled order, then a boss:
  - **Air Raid**: Wasps, later Hornets and Raptors. It goes for your harvesters.
  - **Armour Column**: Stingers, later Lancers and Mastodons.
  - **Artillery**: Mortars and Stingers, later Lancers and Flak Crawlers.
  - **Mixed Assault**: a bit of everything.
  - **Boss**, every 5th wave: Mastodon Spearhead, Bomber Wing or Elite Strike Force. It heads for your HQ.
- Waves grow fast. On Normal, wave 1 is worth 468 scrap, wave 5 about 2,650 and wave 10 about 6,560. A wave holds at most 36 units.
- Waves arrive at rank 1 from wave 6 and at rank 2 from wave 12. Bosses get one extra rank, up to rank 3.
- Waves come from the far edges and corners of the map, and never from the same direction twice in a row.
- 15 s before each wave, a banner names it and its direction, for example "Wave 3 from the north-east in 15 s". An alert also sounds and an arrow appears on the minimap. Between waves, the top bar shows the next wave's number, theme and countdown. During a wave it shows how many attackers are left and the time to the next wave.

### Rewards and records

- Clearing a wave pays 60 scrap × the wave number. The banner names the next wave's theme and what counters it.
- Wrecks from the waves are worth only 5% of their cost.
- Your best wave count is saved for each map and difficulty. Beating it during a run shows "New record!".
- Medals: Holdout for 10 waves and Unbreakable for 20.
- When the HQ falls, the finale shows "Base overrun". The end screen then shows:
  - waves survived and your best
  - your MVP unit
  - the run's stats

In testing, a scripted player survived a median of 15 waves on Easy, 10 on Normal and 8 on Hard.

## New mode: Ops

Ops is a campaign of 8 short missions, each with a twist and three stars to win. Open the 🎖 Ops tab on the menu, pick a mission and read its briefing, then tap "▶ Start op".

- The first three ops are open from the start. Every op you complete, at any star level, opens the next locked op, so you can skip one that's giving you trouble.
- Completing the goal earns ★. The ★★ and ★★★ conditions are separate bonuses, both checked when you win. Your best stars and best time are kept for each op, and any open op can be replayed.

| Op | Setup | Goal | ★★ | ★★★ |
| --- | --- | --- | --- | --- |
| 1 Bridgehead | Riverlands vs a Hard Rush that starts with 6 extra Stingers. You hold two bridge Turrets with a small force. | Hold out for 4:00. You fail if both bridge Turrets fall. | Lose 6 units or fewer | Both bridge Turrets standing |
| 2 Harvest Moon | Dune Sea vs a Hard Air Swarm raiding your harvesters. | Deliver 10,000 scrap before 5:00. Salvage doesn't count. | Lose 1 Harvester or fewer | Finish in under 4:00 |
| 3 Decapitation | Proving Grounds. You have a fixed strike group of 2 Mastodons, 3 Stingers, 2 Hornets, 2 Raptors and a Mender: no scrap, no factories, no calldowns. | Destroy the enemy HQ before 3:00. | Lose 4 units or fewer | Finish in under 2:00 |
| 4 Frozen Assets | Frostbite vs Boom. You have 3,000 scrap, no income, no harvesters, no calldowns, and a ready-built Fab Plant, Airpad and Tech Lab. | Destroy the enemy HQ before 6:00. | Destroy 4 enemy Harvesters | Finish in under 4:00 |
| 5 Sky Pirates | Ashlands. Air units only, against SAM sites already in place. | Destroy the enemy HQ before 7:00. | Lose 12 units or fewer | Finish in under 4:30 |
| 6 Glass Jaw | Dune Sea vs Rush. Both sides deal double damage and build twice as fast. | Destroy the enemy HQ before 6:00. | Lose no buildings | Finish in under 4:00 |
| 7 Iron Tide | Frostbite vs a Hard Ironclad. | Hold out for 6:00. | Destroy 2 enemy Mastodons | Lose 1 building or fewer |
| 8 Last Light | Riverlands. Fast Last Stand waves: the first at 0:45, then one every 40 s. You start with 1,200 scrap and a ready base. | Survive 10 waves. | Lose 2 buildings or fewer | Finish in under 7:00 |

- Losing your HQ always fails an op, and destroying the enemy HQ always wins it.
- A goal pill under the clock shows your three stars live. Toasts tell you when a star is secured or lost. Ops with a deadline warn "One minute left" and "⏱ 15 seconds left!". Hold-out ops say "One minute to hold" and "⏱ 15 seconds — hold on!".
- Ops have no openers, Uplinks or supply drops, and your mutator picks don't apply. Glass Jaw brings its own: Glass Cannons and Rapid Fab. Calldowns work in every op except Decapitation and Frozen Assets.
- XP: 60 per clear, +100 for a first clear and +40 for each new star. Ops don't award medals.
- The end screen shows your stars, your best result and any newly unlocked op. After a win you get "▶ Next" (except after the last op), "↻ Replay" and "Main menu". After a failure you get "↻ Retry" and "Main menu".

## Heroes, the finale and the after-action report

Units that rack up kills now earn callsigns, matches end in a slow-motion finale, and a new after-action report tells the story of the battle.

### Heroes

Veterancy isn't new: each rank still gives +15% damage, and rank 3 units still repair themselves. Promotions already showed a chevron, a gold pulse and a sound. What's new is that your best units get names and kill counts, and promotions are easier to spot.

- The ranks are Veteran, Hardened and Elite. A unit ranks up after destroying 1×, 2.5× and 5× its own cost in scrap. For a Stinger, which costs 150, that's 150, 375 and 750.
- On each promotion the new chevron now pops in and the rank title floats over the unit. Elite units shimmer gold.
- At rank 2 a unit earns a callsign from a pool of 48, such as Viper, Ironhide, Havoc or Valkyrie. You see "★★ Your Lancer earned a callsign: Viper", and selecting the unit shows "★★ Viper · Lancer · 9 kills".
- At rank 3 a banner announces "Viper is Elite", with "★★★ Lancer · 9 kills · self-repairing".
- Units now count their kills, buildings included.
- When one of your heroes falls you see, for example, "✝ Viper (Lancer, 9 kills) destroyed". If a Barrage or Sky Hammer killed it, the message says so. Tap the toast to jump there.
- When you kill an enemy ace you see "🎯 Enemy ace Viper (Lancer, 9 kills) down". Killing an enemy Elite gets an "Elite Lancer down" banner.
- Callsigns last for one match.
- The AI pulls its wounded heroes back to a Mender or its HQ: units of rank 2 or higher that drop below 35% HP.

### The finale

When an HQ falls, the match ends in a short cinematic:

1. Everything slows to 0.3× speed and the camera glides in on the HQ.
2. Five blasts go off a quarter of a second apart; the last and biggest is in the centre.
3. At 1.5 s there's a white flash and a hard shake. The result banner appears ("Enemy HQ destroyed: Victory" or "Our HQ has fallen: Defeat"), and the music resolves into a victory fanfare or a defeat lament.
4. The after-action report appears at 2.8 s.

### The after-action report

- **Header**: Victory or Defeat, the opponent and difficulty, and the match length.
- **Army strength chart**: your army against theirs over the whole match.
  - It marks up to 3 key moments: First blood, Biggest battle and Turning point. If the lead never changed hands, "Pulled ahead" replaces Turning point.
  - Tap or drag across the chart to read it.
  - A strike that swung the fight gets named, for example "Your army overtook theirs after your Sky Hammer (1.2k vs 800) and never looked back".
- **MVP cards**: "Your MVP" and "Their ace", each with callsign, rank, kills and whether the unit survived.
- **Stats**, yours against the enemy's:
  - always: Units destroyed, Buildings destroyed, Units built, Units lost, Scrap harvested and Peak army
  - when they apply: Scrap salvaged, Calldowns, Uplinks captured, Crates claimed and Objective scrap
- **Next time**: one tip for your next match.
- **Career**: XP counting up, promotions, medals and map stars. See the next section.
- **Buttons**: "↻ Rematch" starts the same kind of match again; "Main menu" goes back.

### Medals

There are 16 medals, each worth 25 career XP. Last Stand awards only Holdout and Unbreakable, and Ops award none.

| Medal | When | How to earn it |
| --- | --- | --- |
| Lightning War | Win | Win in under 5:00 |
| Untouchable | Win | Lose no buildings |
| Comeback | Win | Win after your army fell to half of theirs, and 800+ behind, after 1:30 |
| Flawless | Win | Lose 5 units or fewer |
| Tycoon | Win | Harvest twice the enemy's scrap, and at least 3,000 |
| Ace | Any result | One unit gets 9 kills |
| Giant Slayer | Any result | Destroy 3 enemy Mastodons |
| Air Superiority | Any result | Destroy 30 enemy aircraft |
| Iron Wall | Any result | Your defences kill 30 enemy units |
| Exterminator | Any result | Destroy 60 enemy units |
| Wrecking Crew | Any result | Destroy 12 enemy buildings |
| Orbital | Any result | Destroy 1,000 scrap with one Sky Hammer |
| Scavenger | Any result | Salvage 3,000 scrap |
| Steady Hands | Any result | Dodge 3 enemy Barrages or Sky Hammers: at least 2 of your units under the reticle when it's called, and nothing hit when it lands |
| Holdout | Last Stand | Survive 10 waves |
| Unbreakable | Last Stand | Survive 20 waves |

## Career, mutators and the Daily Op

Every match now counts toward a career, mutators let you twist the rules, and a new Daily Op gives everyone the same challenge each day.

### Career

- **XP** comes from:
  - wins (100) and losses (30), scaled by difficulty: ×1 on Easy, ×1.5 on Normal and ×2.2 on Hard
  - 25 per medal
  - Last Stand waves
  - Ops
  - the Daily Op

  A loss before 5:00 pays less.
- **Ranks**: XP climbs 10 of them: Cadet, Private, Corporal, Sergeant, Lieutenant, Captain, Major, Colonel, General and Marshal, at 6,000 XP. A rank is a title and an insignia. It doesn't unlock anything.
- **Map stars**: each map has 3 per difficulty, 45 in all:
  - Win.
  - Win in under 8:00.
  - Win without losing a building.

  Only standard skirmishes earn stars, so no mutators and not the Daily Op.
- **The menu badge** shows your rank, XP, medals out of 16 and a progress bar. Tap it for the Career sheet, which lists:
  - wins and losses, stars and your daily streak
  - Ops progress
  - your medals
  - map stars by difficulty
  - Last Stand bests
  - the rank ladder
- **After each match**, the report counts up your XP and fills the bar. It shows "PROMOTED" on a rank-up, marks new medals "NEW", and pops in new stars.
- Watching AI vs AI never counts toward your career.

### Mutators

Tap "🧪 Mutators" on the Skirmish tab to change the rules for both sides. You can combine as many as you like. Mutated matches earn XP and medals, but no map stars.

| Mutator | Effect |
| --- | --- |
| Blitz | Both sides start with 3,000 scrap instead of 600. |
| Gold Rush | Harvesting, HQ income and salvage pay 1.5×. Uplinks and crates don't. |
| Glass Cannons | Every weapon deals double damage. Call-down strikes don't. |
| Rapid Fab | Units and buildings build in half the time. |
| Air War | No ground combat units, Fab Plants or SAM sites. Turrets and HQ guns remain. |
| Veterans | Combat units roll out at rank 1, with +15% damage. |
| Clear Skies | No fog of war: both sides see everything. |

- Your mutator picks don't apply in Last Stand or Ops. The Glass Jaw op sets its own: Glass Cannons and Rapid Fab.
- They do apply when you watch AI vs AI from the Skirmish tab.
- With mutators on, the AI picks a personality whose plan works under those rules.

### The Daily Op

- Every player gets the same new challenge each day. It changes at local midnight.
- Each Daily Op fixes:
  - the map
  - the opponent, from all 6 AI personalities
  - the difficulty: Normal, or Hard about one day in three
  - exactly 2 mutators

  You still choose your opener, and Uplinks and supply drops are on.
- Your first win of the day earns 100 XP on top of the normal match XP, and extends your 🔥 streak. The streak lasts until a whole day passes without a win.
- You can retry until midnight.
- The menu card shows:
  - the op number and the date
  - your streak
  - the map, opponent, difficulty and mutators
  - "▶ Play", which becomes "✓ Won / replay" once you've won

### Watching AI vs AI

"🤖 Watch AI vs AI" was already on the menu. It now has:

- a battle meter, and each side's opener next to its personality in the header
- a 4× speed
- a neutral caster
- a report for both sides, with Blue MVP and Red MVP and each side's medals
- a "↻ Rematch" button that starts another AI-vs-AI match, instead of dropping you into a game

In Last Stand, "🤖 Watch AI defend" lets the AI play a run. Then "▶ Your turn" hands it to you.

### The menu

- The menu has three tabs: ⚔ Skirmish, 🛡 Last Stand and 🎖 Ops.
- Your rank badge and the Daily Op card sit under the logo, and the Mutators button sits above ▶ Play on the Skirmish tab. In landscape, all three move to a column over the key art.
- Map cards show your stars, or your best wave in Last Stand.
- Rematch keeps the match type: Daily Op, op or spectate.

## Balance, pacing and the AI

Matches now last longer, swing more often and are fought more in the middle of the map. These figures come from 1,200 AI-vs-AI matches on Normal, run before and after the update.

| Measure | Before | After |
| --- | --- | --- |
| Still undecided after 25 minutes | 14% | 0.9% |
| Median length of a decided match | 5:51 | 8:17 |
| Side ahead at 4:00 goes on to win | 89% | 78% |
| Winner had been 800+ scrap behind | 24% | 46% |
| Lead changes per match | 1.6 | 2.2 |
| Deaths in the middle 40% of the map | 12% | 28% |

### Tougher units, longer fights

Every combat unit has 50% more HP, except the Hornet, which has 30% more. Costs, damage, build times and harvester income are unchanged.

Half the units in an 8-vs-8 Stinger fight now die in 7.5 s instead of 5.0 s. In Wasps against Flak it's 4.7 s instead of 2.4 s. That leaves time to react, retreat or call in a strike.

| Unit | HP before | HP after |
| --- | --- | --- |
| Stinger | 170 | 255 |
| Flak Crawler | 190 | 285 |
| Mortar | 130 | 195 |
| Mastodon | 700 | 1,050 |
| Lancer | 270 | 405 |
| Wasp | 135 | 205 |
| Raptor | 175 | 265 |
| Hornet | 390 | 505 |
| Mender | 120 | 180 |

### Fair sides

Red used to win more often because it got the better of tied choices. Its pathfinding, harvesting, building placement, targeting and crate races now mirror Blue's exactly.

- In the 1,200 test matches, Red now wins 47–51% of decided games on every map. Before this fix it won 65% on Ashlands.
- Harvest at 4:00 is now within 2% between the sides on every map. On Dune Sea and Ashlands, Red used to harvest about 9% more.

### The AI

- Attacks come in waves with lulls between them. The AI only launches once 75% of its wave has gathered; it used to launch at 60%.
- It doesn't raid in the first 45 s, and it turns more aggressive from 7:00 instead of 9:00.
- It recalls its army when a real attack hits its HQ, and it pulls wounded veterans back.
- It uses every new system: call-down strikes, Uplinks, supply crates and salvage.

The six AI personalities aren't new, but each was retuned:

| Personality | How it plays | Attacks once its army is worth (scrap) |
| --- | --- | --- |
| Balanced | Factory, Airpad and Tech Lab at a steady pace | 1,400 → 1,700 |
| Rush | Two factories, Stinger raids in packs of 5 (was 3), the earliest waves | 800 → 1,400 |
| Air Swarm | Airpad first, constant Wasp raids, bombers later | 1,200 → 1,700 |
| Boom | Extra harvesters, a forward Depot, one huge late push | 2,000 (unchanged) |
| Skyforce | Air first: Wasps, Raptors and Hornets, plus a few Stingers and Flak Crawlers from a late Fab Plant | 1,300 → 2,000 |
| Ironclad | A Turret, then a rushed Tech Lab for Mastodons, Lancers and Mortars | 1,800 → 1,500 |

&#91;embedded content: DESIGN.md and commit f3b1851 · 1,200 AI-vs-AI matches on Normal, before and after the update\]

The tuning aimed to keep every personality between 25% and 75%.

### Difficulty

Easy is gentler. Its opponent is now always Balanced, Rush or Air Swarm; Skyforce no longer appears. On Easy, the AI:

- never Barrages
- is the slowest to dodge your strikes
- only takes neutral Uplinks
- only chases nearby crates

A scripted beginner now wins 89% of matches on Easy, up from 72%.

### Maps

Proving Grounds gains two mirrored scrap fields on its flanks, adding 27,000 scrap for 57,000 in total. Its terrain is repainted.

## Known issues

All the balance figures above come from AI-vs-AI and scripted-player simulations. No human has playtested this update yet, and nobody has listened to the new audio.

- **Getting the update**: the game updates itself in the background. If you've played before, your first launch may still run the old version. Reload, or finish a match, to get the new one.
- **Turtling beats Normal**: a simple scripted strategy, two Turrets and then a push, wins 84% of the time against Normal. The AI throws its waves into the Turrets and has nothing left to defend with.
- **Long Last Stand runs**: waves stop growing at 36 units, and ranks stop rising at wave 12. A defender who holds past about wave 20 can keep going for a long time.
- **Rush is the weakest personality**, at a 27% win rate.
- **Uplinks favour the side that's ahead**, because they pay whoever already holds the field. They pay only 1.5 scrap a second, kept low to limit this.
- **Ops**: Glass Jaw's ★★★ is swingy, and Last Light's under-7:00 ★★★ needs you to call waves early.
- **Leftover side noise**: in small samples a single map can still swing ±15 points between Red and Blue.
- **Long matches**: in testing, 0.9% of AI-vs-AI matches were still undecided after 25 minutes, mostly air-heavy AIs against anti-air on Ashlands. Real matches have no time limit.
