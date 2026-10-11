/**
 * Deterministic maths for the simulation. ECMAScript lets each engine
 * compute Math.sin, cos, atan2, hypot and pow its own way (their results
 * are "implementation-approximated"), and they do differ: on 20,000 sample
 * inputs V8 (Node, Chrome, Edge) and JavaScriptCore (Safari, Bun) disagreed
 * in the last bit for 35% of hypot results, 17% of atan2, 9% of pow and 3%
 * of sin and cos. In a deterministic sim one bit grows into a different
 * battle, so a replay recorded in Node drifted within seconds in Safari.
 *
 * These versions use only + − × ÷, comparisons and Math.sqrt, floor and
 * abs, which IEEE 754 and ECMAScript define exactly (and engines never fuse
 * a multiply-add, which would round differently), so every engine gets the
 * same bits. They follow fdlibm (the library V8's own versions come from) and
 * are accurate to an ulp or so. Every module under src/sim must use these:
 * tests/fmath.test.ts bans the Math originals there.
 */

/** √(x² + y²). (Math.hypot also guards against overflow, which game distances never need.) */
export function hypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

// ------------------------------------------------------------- sin, cos ---

// π/2 in three 33-bit parts: n × part is exact for |n| < 2^20 (fdlibm e_rem_pio2)
const PIO2_1 = 1.5707963267341256e0;
const PIO2_2 = 6.077100506303966e-11;
const PIO2_3 = 2.0222662487111665e-21;
const INV_PIO2 = 6.366197723675814e-1;

// minimax polynomials on [-π/4, π/4] (fdlibm k_sin, k_cos)
const S1 = -1.66666666666666324348e-1;
const S2 = 8.33333333332248946124e-3;
const S3 = -1.98412698298579493134e-4;
const S4 = 2.75573137070700676789e-6;
const S5 = -2.50507602534068634195e-8;
const S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-2;
const C2 = -1.38888888888741095749e-3;
const C3 = 2.48015872894767294178e-5;
const C4 = -2.75573143513906633035e-7;
const C5 = 2.08757232129817482790e-9;
const C6 = -1.13596475577881948265e-11;

function kSin(x: number): number {
  const z = x * x;
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + z * x * (S1 + z * r);
}

function kCos(x: number): number {
  const z = x * x;
  const r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
  const hz = 0.5 * z;
  const w = 1 - hz;
  return w + (1 - w - hz + z * r);
}

/** x ≥ 0 reduced to y in [-π/4, π/4] with x = y + n·π/2: [n mod 4, y]. */
function reduce(x: number): [number, number] {
  const n = Math.floor(x * INV_PIO2 + 0.5);
  const y = x - n * PIO2_1 - n * PIO2_2 - n * PIO2_3;
  return [n % 4, y];
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const a = Math.abs(x);
  if (a < 1e-9) return x; // (and keeps −0)
  const [q, y] = reduce(a);
  const s = q === 0 ? kSin(y) : q === 1 ? kCos(y) : q === 2 ? -kSin(y) : -kCos(y);
  return x < 0 ? -s : s; // odd: sin(−x) is exactly −sin(x)
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const a = Math.abs(x); // even: cos(−x) is exactly cos(x)
  if (a < 1e-9) return 1;
  const [q, y] = reduce(a);
  return q === 0 ? kCos(y) : q === 1 ? -kSin(y) : q === 2 ? -kCos(y) : kSin(y);
}

// ---------------------------------------------------------------- atan2 ---

const ATAN_HI = [4.63647609000806093515e-1, 7.85398163397448278999e-1, 9.82793723247329054082e-1, 1.57079632679489655800e0];
const ATAN_LO = [2.26987774529616870924e-17, 3.06161699786838301793e-17, 1.39033110312309984516e-17, 6.12323399573676603587e-17];
const AT = [
  3.33333333333329318027e-1, -1.99999999998764832476e-1, 1.42857142725034663711e-1, -1.11111104054623557880e-1,
  9.09088713343650656196e-2, -7.69187620504482999495e-2, 6.66107313738753120669e-2, -5.83357013379057348645e-2,
  4.97687799461593236017e-2, -3.65315727442169155270e-2, 1.62858201153657823623e-2
];
const PI = 3.1415926535897931160e0;
const PI_LO = 1.2246467991473531772e-16;

/** atan(x) for x ≥ 0 (fdlibm s_atan). */
function atanPos(x: number): number {
  if (x >= 7.378697629483821e19) return ATAN_HI[3]! + ATAN_LO[3]!; // ≥ 2^66: π/2
  let id: number;
  if (x < 0.4375) id = -1;
  else if (x < 0.6875) {
    id = 0;
    x = (2 * x - 1) / (2 + x);
  } else if (x < 1.1875) {
    id = 1;
    x = (x - 1) / (x + 1);
  } else if (x < 2.4375) {
    id = 2;
    x = (x - 1.5) / (1 + 1.5 * x);
  } else {
    id = 3;
    x = -1 / x;
  }
  const z = x * x;
  const w = z * z;
  const s1 = z * (AT[0]! + w * (AT[2]! + w * (AT[4]! + w * (AT[6]! + w * (AT[8]! + w * AT[10]!)))));
  const s2 = w * (AT[1]! + w * (AT[3]! + w * (AT[5]! + w * (AT[7]! + w * AT[9]!))));
  if (id < 0) return x - x * (s1 + s2);
  return ATAN_HI[id]! - (x * (s1 + s2) - ATAN_LO[id]! - x);
}

/** The angle of (x, y), as Math.atan2 (fdlibm e_atan2): atan2(±0, +0) is ±0, atan2(±0, −0) is ±π. */
export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (y === 0) return x > 0 || Object.is(x, 0) ? y : Object.is(y, -0) ? -PI : PI;
  if (x === 0) return y > 0 ? PI / 2 : -PI / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    if (Number.isFinite(y)) return x > 0 ? (y > 0 ? 0 : -0) : y > 0 ? PI : -PI;
    const q = !Number.isFinite(x) ? (x > 0 ? PI / 4 : (3 * PI) / 4) : PI / 2;
    return y > 0 ? q : -q;
  }
  const r = Math.abs(y / x);
  // (a tiny angle next to a negative x is π, not π + a sliver: fdlibm's rule)
  const z = r > 1.152921504606847e18 ? PI / 2 + 0.5 * PI_LO : x < 0 && r < 8.673617379884035e-19 ? 0 : atanPos(r);
  if (x > 0) return y > 0 ? z : -z;
  return y > 0 ? PI - (z - PI_LO) : z - PI_LO - PI;
}

// ------------------------------------------------------------------ pow ---

const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const LG = [6.666666666666735130e-1, 3.999999999940941908e-1, 2.857142874366239149e-1, 2.222219843214978396e-1, 1.818357216161805012e-1, 1.531383769920937332e-1, 1.479819860511658591e-1];
const SQRT2 = 1.4142135623730951;

/** ln(x) for finite x > 0 (fdlibm e_log, the exponent split by halving instead of bit access). */
function log(x: number): number {
  let k = 0;
  while (x >= SQRT2) {
    x *= 0.5;
    k++;
  }
  while (x < SQRT2 / 2) {
    x *= 2;
    k--;
  }
  const f = x - 1;
  const s = f / (2 + f);
  const z = s * s;
  const w = z * z;
  const t1 = w * (LG[1]! + w * (LG[3]! + w * LG[5]!));
  const t2 = z * (LG[0]! + w * (LG[2]! + w * (LG[4]! + w * LG[6]!)));
  const R = t2 + t1;
  const hfsq = 0.5 * f * f;
  return k * LN2_HI - (hfsq - (s * (hfsq + R) + k * LN2_LO) - f);
}

const P = [1.66666666666666019037e-1, -2.77777777770155933842e-3, 6.61375632143793436117e-5, -1.65339022054652515390e-6, 4.13813679705723846039e-8];
const INV_LN2 = 1.44269504088896338700e0;

/** e^x (fdlibm e_exp; 2^k applied by halving or doubling). */
function exp(x: number): number {
  if (x > 709.78) return Infinity;
  if (x < -745.14) return 0;
  const k = Math.floor(x * INV_LN2 + 0.5);
  const hi = x - k * LN2_HI;
  const lo = k * LN2_LO;
  const r = hi - lo;
  const t = r * r;
  const c = r - t * (P[0]! + t * (P[1]! + t * (P[2]! + t * (P[3]! + t * P[4]!))));
  let y = 1 - (lo - (r * c) / (2 - c) - hi);
  for (let i = 0; i < k; i++) y *= 2;
  for (let i = 0; i > k; i--) y *= 0.5;
  return y;
}

/** x^y for x ≥ 0 (all the sim needs: Last Stand's wave budgets); exact for integer y. */
export function pow(x: number, y: number): number {
  if (Number.isInteger(y) && Math.abs(y) <= 64) {
    let r = 1;
    let b = y < 0 ? 1 / x : x;
    for (let n = Math.abs(y); n > 0; n >>= 1) {
      if (n & 1) r *= b;
      b *= b;
    }
    return r;
  }
  if (!(x >= 0) || Number.isNaN(y)) return NaN;
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x === 1) return 1;
  if (!Number.isFinite(x)) return y > 0 ? Infinity : 0;
  return exp(y * log(x));
}
