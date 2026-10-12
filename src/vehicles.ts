// Standalone vehicles page (vehicles.html): every unit with its stats, read
// from balance.ts so the page never drifts from the game, plus hand-written
// notes on what makes each one special, and the damage-type table.
import { DAMAGE_VS, GOLIATH, INFANTRY, TERRAIN, UNITS, shotDamage, type GoliathWeaponStats } from "./sim/balance";
import { COUNTERS } from "./game/advisor";
import { Terrain, type ArmorClass, type DamageType, type UnitKind } from "./sim/types";

const FEATURES: Record<UnitKind, string[]> = {
  harvester: [
    "Your economy: drives to the nearest scrap or crystal field, fills its hold and hauls it back to the HQ or a Depot.",
    "Crystal is worth 1.6× scrap per load, so crystal fields are worth fighting over.",
    "Unarmed and slow; air raids hunt them first. Build a Depot near distant fields to shorten the trip.",
    "Leaves no salvage when destroyed."
  ],
  scout: [
    "The fastest thing on the map, with the widest sight of any unit.",
    "Unarmed: use it to find the enemy base, spot fields and watch for attacks coming through the fog.",
    "Cheap and quick to build — losing one is fine if it bought you information."
  ],
  stinger: [
    "Cheap, fast light tank with a turreted cannon — the backbone of an early army.",
    "Quick enough to raid harvesters and outrun slower armour.",
    "Wins cost-for-cost against Flak Crawlers, Mortars and Lancers, but cannot shoot at aircraft."
  ],
  "flak-crawler": [
    "The dedicated anti-air answer: rapid flak bursts that shred drones, extra-effective against light airframes.",
    "Beats every aircraft cost-for-cost, including Hornet bombers.",
    "Completely helpless against ground units — escort it with tanks."
  ],
  mortar: [
    "Long-range artillery: out-ranges every turret and SAM Site, making it the tool for cracking a base.",
    "Shells are real projectiles with splash, aimed where the target was — fast units can dodge them.",
    "Has a minimum range and light armour: anything that closes the distance tears it apart."
  ],
  mastodon: [
    "Super-heavy twin-cannon tank with by far the most HP of any tank.",
    "Its cannons hit heavy armour harder, and it crushes Stingers, Flak and Mortars.",
    "Slow and unable to shoot at air — Wasps and Lancers are its nightmare."
  ],
  lancer: [
    "Hover tank: crosses water and shallows and ignores rough ground, opening routes no tracked unit can take.",
    "Its laser burns through heavy armour (1.55×), making it the Mastodon killer.",
    "The only tank that can also shoot aircraft, at reduced effect."
  ],
  wasp: [
    "Rocket strike drone that flies over every obstacle to hit ground targets.",
    "Beats tanks and artillery cost-for-cost — great for harassing harvesters and Mortars.",
    "Dies quickly to Flak, Raptors and SAM Sites."
  ],
  raptor: [
    "Air superiority interceptor: fast missiles that hunt other aircraft.",
    "Counters Wasps, Hornets and Menders.",
    "Cannot attack anything on the ground."
  ],
  hornet: [
    "Heavy armoured bomber that carpet-bombs ground units and buildings with splash damage.",
    "Explosive bombs do 1.35× damage to structures — ideal for flattening a base.",
    "Bombs are projectiles that can be dodged, and it needs an escort against Flak, Raptors and SAMs."
  ],
  mender: [
    "Repair drone: a beam that heals one damaged friendly unit or building in range at a time.",
    "Keeps an army in the fight longer; the AI uses them as army escorts.",
    "Unarmed and lightly armoured — Raptors and Flak pick them off."
  ],
  trooper: [
    `Five rifle bots fighting as one squad: one HP pool, and a robot falls each time it loses a fifth of it — the squad's firepower falls with them.`,
    "The cheapest unit that can shoot aircraft, at half effect. Every side starts the match with one squad.",
    `Walks through woods and rough ground at full speed, and takes only ${Math.round(INFANTRY.woodsCover * 100)}% damage in woods (vehicles: ${Math.round(TERRAIN[Terrain.Forest].cover * 100)}%).`,
    `Captures Uplinks ${INFANTRY.captureWeight}× as fast as a vehicle and picks up supply crates. Leaves no wreck.`
  ],
  "rocket-squad": [
    `Three bots with shoulder-fired rockets: cannon damage that hits heavy armour ${DAMAGE_VS.cannon.heavy}× — the cheap answer to Mastodons.`,
    `Also fires at aircraft (${UNITS["rocket-squad"].airMult}×), so Hornets and Wasps pay for low passes.`,
    "Weak against other infantry: Troopers and Snipers cut it down."
  ],
  sniper: [
    `Two marksmen with rail-rifles: precision damage, ${Math.round(shotDamage(UNITS.sniper))} per shot and ${DAMAGE_VS.precision.infantry}× against infantry — one shot drops about three Trooper robots.`,
    `Hidden in woods: enemies only see it within ${INFANTRY.concealRadius} tiles, until ${INFANTRY.concealAfterShot} s after it fires.`,
    "Next to useless against armour and buildings, and slow to fire: keep vehicles away from it."
  ],
  condor: [
    `Dropship: carries ${UNITS.condor.capacity} infantry squads over water, rock and anything else in the way. Unarmed.`,
    `Select squads and tap the Condor to load them (1 s each, once they reach it); long-press the map to fly there and drop them (it hovers ${INFANTRY.unloadHover} s), or tap Unload.`,
    `Shot down over land, its squads bail out with at most ${Math.round(INFANTRY.bailoutHp * 100)}% HP; over water or rock they are lost with it.`
  ],
  goliath: [
    "A giant walking mech and a mobile base: shoulder mortars, an eye laser, arm cannons and machine guns that hit aircraft too.",
    `Anchor it (${GOLIATH.anchorTime} s to dig in, ${GOLIATH.packTime} s to pack up) and it takes harvesters' scrap, trains infantry, and lets you build outposts within ${GOLIATH.buildRing} tiles of it, anywhere on the map.`,
    `Loses its weapons as it is hurt: mortars below ${Math.round(GOLIATH.weapons.mortars.lostBelow * 100)}% HP, the laser below ${Math.round(GOLIATH.weapons.laser.lostBelow * 100)}%, the cannons below ${Math.round(GOLIATH.weapons.cannons.lostBelow * 100)}%. Only Menders repair it, and each weapon reboots once it is mended.`,
    `Always visible to the enemy. Two empty Condors can carry it; while a side has a Goliath, losing its HQ doesn't lose the game. Each one costs ${Math.round(GOLIATH.costStep * 100)}% more for every Goliath you already have.`
  ]
};

const GROUPS: { title: string; kinds: UnitKind[] }[] = [
  { title: "Built at the HQ", kinds: ["harvester"] },
  { title: "Fab Plant — ground vehicles", kinds: ["stinger", "flak-crawler", "mortar", "mastodon", "lancer"] },
  { title: "Assembly Bay — robot infantry", kinds: ["trooper", "rocket-squad", "sniper"] },
  { title: "Airpad — flying drones", kinds: ["scout", "wasp", "raptor", "hornet", "mender", "condor"] },
  { title: "Gantry — Goliath", kinds: ["goliath"] }
];

const BUILT_AT: Record<string, string> = { hq: "HQ", "fab-plant": "Fab Plant", airpad: "Airpad", "assembly-bay": "Assembly Bay", gantry: "Gantry" };
const TARGETS = { ground: "Ground", air: "Air", both: "Ground + air", none: "Unarmed" };

type Threat = UnitKind | "turret" | "sam-site";
const threatName = (k: Threat): string =>
  k === "turret" ? "Turret" : k === "sam-site" ? "SAM Site" : UNITS[k].name;
const threatLink = (k: Threat): string =>
  k in UNITS ? `<a href="#${k}">${threatName(k)}</a>` : threatName(k);

// "Weak against" is the inverse of the advisor's counter table
const counteredBy = (kind: UnitKind): Threat[] =>
  (Object.entries(COUNTERS) as [Threat, Threat[]][]).filter(([, beats]) => beats.includes(kind)).map(([k]) => k);

const stat = (value: string | number, label: string): string =>
  `<div class="stat"><b>${value}</b><span>${label}</span></div>`;

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

/** One of the Goliath's weapon systems: what it fires, how hard and how far, and when damage takes it offline. */
function goliathWeapon(w: GoliathWeaponStats): string {
  const bits = [
    `<b>${w.name}</b> ${w.dmgType}`,
    `${fmt(shotDamage(w))} every ${w.shotInterval ?? 0.5}s`,
    `range ${w.range}${w.minRange ? ` (min ${w.minRange})` : ""}`,
    w.targets === "both" ? "ground + air" : w.targets,
    w.lostBelow > 0 ? `offline below ${Math.round(w.lostBelow * 100)}% HP` : "never offline"
  ];
  return bits.join(" · ");
}

function weaponLine(kind: UnitKind): string {
  const u = UNITS[kind];
  // four weapon systems, the long-ranged first (damage takes them in that order)
  if (kind === "goliath")
    return (["mortars", "laser", "cannons", "mg"] as const).map((k) => goliathWeapon(GOLIATH.weapons[k])).join("<br />");
  if (u.heal) return `<b>Repair beam</b> · ${u.heal} HP/s · range ${u.range}`;
  if (u.targets === "none") return "<b>No weapon</b>";
  const strong = (Object.entries(DAMAGE_VS[u.dmgType!]) as [ArmorClass, number][])
    .filter(([a, m]) => a !== "structure" ? m > 1 : m >= 1.3)
    .map(([a, m]) => `${a === "structure" ? "buildings" : a === "infantry" ? "infantry" : `${a} armour`} ×${m}`);
  const bits = [
    `<b>${u.dmgType}</b> damage`,
    `${fmt(shotDamage(u))} per shot every ${u.shotInterval ?? 0.5}s`,
    u.minRange ? `min range ${u.minRange}` : "",
    u.splash ? `splash ${u.splash} tiles` : "",
    u.airMult ? `×${u.airMult} vs air` : "",
    strong.length ? `strong vs ${strong.join(", ")}` : ""
  ];
  return bits.filter(Boolean).join(" · ");
}

function card(kind: UnitKind): string {
  const u = UNITS[kind];
  const beats = (COUNTERS[kind] ?? []) as Threat[];
  const fears = counteredBy(kind);
  const tags = [
    `<span class="tag">${u.hover ? "Hover" : u.squad ? "Infantry" : u.domain === "air" ? "Air" : "Ground"}</span>`,
    `<span class="tag">${u.armor === "infantry" ? `squad of ${u.squad}` : `${u.armor} armour`}</span>`,
    u.capacity ? `<span class="tag">Carries ${u.capacity} squads</span>` : "",
    `<span class="tag">${BUILT_AT[u.builtAt]}</span>`,
    u.requires ? `<span class="tag tech">⚗ Needs Tech Lab</span>` : ""
  ].join("");
  const matchups =
    beats.length || fears.length
      ? `<div class="matchups">
          <div class="beats"><h4>Strong against</h4>${beats.map(threatLink).join(", ") || "—"}</div>
          <div class="fears"><h4>Weak against</h4>${fears.map(threatLink).join(", ") || "—"}</div>
        </div>`
      : "";
  return `<article id="${kind}">
    <div class="head">
      <img src="./assets/icons/${kind}.webp" alt="" loading="lazy" />
      <div>
        <h3>${u.name}</h3>
        <div class="role">${u.role}</div>
        <div class="tags">${tags}</div>
      </div>
    </div>
    <div class="stats">
      ${stat(u.cost, "Scrap")}
      ${stat(u.hp, "HP")}
      ${stat(u.speed, "Speed")}
      ${stat(u.sight, "Sight")}
      ${stat(u.dps || (u.heal ? `+${u.heal}` : "—"), u.heal ? "Heal/s" : "DPS")}
      ${stat(u.range || "—", "Range")}
      ${stat(TARGETS[u.targets], "Hits")}
      ${stat(`${u.buildTime}s`, "Build")}
    </div>
    <div class="weapon">${weaponLine(kind)}</div>
    <ul class="features">${FEATURES[kind].map((f) => `<li>${f}</li>`).join("")}</ul>
    ${matchups}
  </article>`;
}

document.getElementById("nav")!.innerHTML = GROUPS.flatMap((g) => g.kinds)
  .map((k) => `<a href="#${k}"><img src="./assets/icons/${k}.webp" alt="" />${UNITS[k].name}</a>`)
  .join("");

document.getElementById("units")!.innerHTML = GROUPS.map(
  (g) => `<h2 class="group">${g.title}</h2><div class="grid">${g.kinds.map(card).join("")}</div>`
).join("");

// the damage table: every damage type against every armour class, straight from DAMAGE_VS
const ARMOR_NAME: Record<ArmorClass, string> = {
  light: "Light", medium: "Medium", heavy: "Heavy", structure: "Buildings", infantry: "Infantry"
};
const armors = Object.keys(ARMOR_NAME) as ArmorClass[];
const users = (t: DamageType): string =>
  (Object.keys(UNITS) as UnitKind[]).filter((k) => UNITS[k].dmgType === t).map((k) => UNITS[k].name).join(", ");
const cell = (m: number): string => `<td class="${m >= 1.2 ? "hi" : m <= 0.7 ? "lo" : ""}">×${m}</td>`;
document.getElementById("damage")!.innerHTML = `<table class="dmg">
  <thead><tr><th>Damage</th>${armors.map((a) => `<th>${ARMOR_NAME[a]}</th>`).join("")}</tr></thead>
  <tbody>${(Object.keys(DAMAGE_VS) as DamageType[])
    .map((t) => `<tr><th>${t}<small>${users(t)}</small></th>${armors.map((a) => cell(DAMAGE_VS[t][a])).join("")}</tr>`)
    .join("")}</tbody>
</table>`;
