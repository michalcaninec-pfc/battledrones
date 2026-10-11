// A fixed sample of src/sim/fmath.ts results, digested: the same bits in every
// JavaScript engine, which is the point. tests/fmath.test.ts pins the digest;
// `bun tests/fmath-sample.ts` prints it from JavaScriptCore to compare.
import { atan2, cos, hypot, pow, sin } from "../src/sim/fmath";

const view = new DataView(new ArrayBuffer(8));

export function fmathDigest(n = 50_000): string {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let h = 0x811c9dc5;
  const add = (x: number) => {
    view.setFloat64(0, x);
    for (let i = 0; i < 8; i++) h = Math.imul(h ^ view.getUint8(i), 0x01000193);
  };
  for (let i = 0; i < n; i++) {
    const a = (rnd() - 0.5) * 120;
    const b = (rnd() - 0.5) * 120;
    const t = (rnd() - 0.5) * 40;
    add(hypot(a, b));
    add(sin(t));
    add(cos(t));
    add(atan2(a, b));
    add(pow(1 + rnd() * 60, 1.4));
  }
  return (h >>> 0).toString(16);
}

// run directly (bun tests/fmath-sample.ts, or vite-node): print the digest
const argv = (globalThis as { process?: { argv: string[] } }).process?.argv ?? [];
if (argv.some((a) => a.endsWith("fmath-sample.ts"))) console.log(fmathDigest());
