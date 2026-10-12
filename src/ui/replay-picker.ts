/**
 * The menu's "🎬 Watch a replay" sheet: paste a battle record (the JSON an
 * agent battle writes to battles/, AGENT-BATTLES.md "Battle records") or pick
 * its file, and watch it in the battle viewer. The viewer itself loads only
 * once a record is chosen (main.ts). A record from another release of the
 * game offers to watch it there.
 */
import type { OtherVersion } from "../game/replay";
import { openSheet } from "./career";

const isOtherVersion = (e: unknown): e is OtherVersion => e instanceof Error && typeof (e as Partial<OtherVersion>).open === "function";

export function showReplayPicker(host: HTMLElement, watch: (json: string) => Promise<void>): void {
  const wrap = openSheet(
    host,
    "replaysheet",
    `<h2>🎬 Watch a replay</h2>
     <p class="sh-sub">Paste a battle record: the <b>.json</b> file an agent battle writes to <code>battles/</code> (<code>llm battledrones run</code>, <code>tools/arena.ts</code>). Or pick the file.</p>
     <textarea id="replay-json" spellcheck="false" autocomplete="off" placeholder='{"v":1,"map":"riverlands",…}'></textarea>
     <label class="cta alt replay-file">📂 Choose a file…<input type="file" accept=".json,application/json" hidden></label>
     <p class="sh-note replay-error" role="alert" hidden></p>
     <div class="sh-actions"><button class="cta alt sheet-close">Cancel</button><button class="cta" id="replay-go">▶ Watch</button><button class="cta" id="replay-there" hidden></button></div>`
  );
  const text = wrap.querySelector<HTMLTextAreaElement>("#replay-json")!;
  const error = wrap.querySelector<HTMLElement>(".replay-error")!;
  const go = wrap.querySelector<HTMLButtonElement>("#replay-go")!;
  const there = wrap.querySelector<HTMLButtonElement>("#replay-there")!;
  // a record from another release: ▶ Watch becomes "▶ Watch it in v10", until the text changes
  let other: OtherVersion | null = null;
  const elsewhere = (e: OtherVersion | null) => {
    other = e;
    go.hidden = !!e;
    there.hidden = !e;
    if (e) there.textContent = `▶ Watch it in ${e.version}`;
  };
  const play = async (json: string) => {
    error.hidden = true;
    go.disabled = true;
    try {
      await watch(json);
      wrap.remove();
    } catch (e) {
      error.textContent = e instanceof Error ? e.message : String(e);
      error.hidden = false;
      go.disabled = false;
      elsewhere(isOtherVersion(e) ? e : null);
    }
  };
  go.addEventListener("click", () => void play(text.value));
  there.addEventListener("click", () => {
    if (!other || other.open(null)) return;
    // (no sessionStorage to carry it in: the player takes it there)
    error.textContent = `${other.message} Open it there and paste it again: `;
    const link = document.createElement("a");
    link.href = link.textContent = other.url;
    error.appendChild(link);
  });
  text.addEventListener("input", () => {
    if (!other) return;
    elsewhere(null);
    error.hidden = true;
  });
  wrap.querySelector<HTMLInputElement>("input[type=file]")!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    text.value = await file.text();
    void play(text.value);
  });
  text.focus();
}
