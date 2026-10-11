import { describe, expect, it } from "vitest";
import { atan2, cos, hypot, pow, sin } from "../src/sim/fmath";
import { fmathDigest } from "./fmath-sample";

/**
 * The sim must replay bit for bit in every JavaScript engine (battle records,
 * and one day online play), so it can't use the Math functions ECMAScript
 * leaves to each engine: src/sim/fmath.ts has its own (AGENT-BATTLES.md
 * "Watching", "Browsers").
 */
describe("deterministic maths for the sim", () => {
  it("no module under src/sim calls the engine-dependent Math functions (or **)", () => {
    const sources = import.meta.glob("../src/sim/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const banned = /\bMath\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|exp|expm1|log|log1p|log2|log10|hypot|pow|cbrt)\b|\*\*(?![/*])/;
    expect(Object.keys(sources).length).toBeGreaterThan(30);
    for (const [path, src] of Object.entries(sources)) {
      if (path.endsWith("/fmath.ts")) continue;
      // (comments may name them)
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const hit = banned.exec(code);
      expect(hit, `${path} uses ${hit?.[0]}: use src/sim/fmath.ts`).toBeNull();
    }
  });

  it("gives the same bits as it always has (and as in JavaScriptCore: `bun tests/fmath-sample.ts`)", () => {
    // computed in V8 (Node) and in JavaScriptCore (Bun): the same
    expect(fmathDigest()).toBe("134d5dc9");
  });

  it("stays within an ulp or so of Math", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const ulps = (a: number, b: number) => Math.abs(a - b) / (Number.EPSILON * Math.max(Math.abs(b), 1e-300));
    let worst = { hypot: 0, sin: 0, cos: 0, atan2: 0, pow: 0 };
    for (let i = 0; i < 20_000; i++) {
      const a = (rnd() - 0.5) * 200;
      const b = (rnd() - 0.5) * 200;
      const t = (rnd() - 0.5) * 100;
      const n = 1 + rnd() * 80;
      worst = {
        hypot: Math.max(worst.hypot, ulps(hypot(a, b), Math.hypot(a, b))),
        sin: Math.max(worst.sin, Math.abs(sin(t) - Math.sin(t)) / Number.EPSILON),
        cos: Math.max(worst.cos, Math.abs(cos(t) - Math.cos(t)) / Number.EPSILON),
        atan2: Math.max(worst.atan2, ulps(atan2(a, b), Math.atan2(a, b))),
        pow: Math.max(worst.pow, ulps(pow(n, 1.4), Math.pow(n, 1.4)))
      };
    }
    expect(worst.hypot).toBeLessThanOrEqual(2);
    expect(worst.sin).toBeLessThanOrEqual(2);
    expect(worst.cos).toBeLessThanOrEqual(2);
    expect(worst.atan2).toBeLessThanOrEqual(2);
    expect(worst.pow).toBeLessThanOrEqual(8);
  });

  it("keeps the symmetries the mirrored maps lean on, exactly", () => {
    for (const t of [0.1, 0.5, 1, 2, 3, Math.PI / 3, 10, 123.456]) {
      expect(sin(-t)).toBe(-sin(t));
      expect(cos(-t)).toBe(cos(t));
    }
    for (const [x, y] of [[3, 4], [0.25, -7], [-12.5, 0.75]] as const) {
      expect(hypot(-x, -y)).toBe(hypot(x, y));
      expect(atan2(-y, x)).toBe(-atan2(y, x));
    }
    expect(hypot(3, 4)).toBe(5);
    expect(pow(7, 3)).toBe(343);
  });

  it("matches Math.atan2 on the edge cases", () => {
    const cases: [number, number][] = [[0, 0], [-0, 0], [0, -0], [-0, -0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, -1], [5, Infinity], [5, -Infinity], [Infinity, 3], [-Infinity, Infinity], [1e-300, -1], [1e300, 1e-10]];
    for (const [y, x] of cases) expect(Object.is(atan2(y, x), Math.atan2(y, x)) || Math.abs(atan2(y, x) - Math.atan2(y, x)) < 1e-15, `atan2(${y}, ${x})`).toBe(true);
    expect(atan2(0, 0)).toBe(0); // (powers.ts leans on a zero vector giving 0: `atan2(…) || u.facing`)
  });
});
