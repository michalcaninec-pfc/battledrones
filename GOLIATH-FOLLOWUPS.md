# Goliath — follow-ups

The Goliath, the Gantry, Nomads and Robot Love shipped with every finding
from the final adversarial review either fixed (each with a test) or listed
here. The AI's own list is longer and lives in `AI-GOLIATH-NOTES.md`.

## To fix later

- **AI endgame stalemates.** On the Archipelago about one match in five of
  Balanced v Ironclad is still level at 25:00, and a Nomads match on a
  mined-out Riverlands can stand still: armies parked as escorts for
  Goliaths with nowhere left to go. Details and a plan in
  `AI-GOLIATH-NOTES.md` (*Known bad behaviour*, *What to do next*).
- **Wounded veteran escorts flip-flop** between home and their post
  (one-line fix in `keepEscorts`, held back because it tips the Nomads test
  match into that standstill; fix the standstill first).
- **An island relay's own Goliath can't re-pick it** after packing up
  there (`chooseSite` skips the relay on its own island).
- **Replay seek to the end** now names a Goliath as what decided the match
  (`GameScene.seek` runs `noteDecider`), but nothing tests it: the scene
  needs a browser. Worth a check in the replay viewer on a Nomads record.
- **Symmetry tests** avoid one Goliath matchup because of a float tie in
  `movement.ts` (waypoint consumption at exactly 0.7 tiles).
- **The final review stopped early.** All five lenses reported and every
  finding was handled, but some verifier passes were cut short; they had
  only been confirming findings already fixed.
- **Playtest on a phone.** The controls were checked headless and in
  desktop Chromium (the Anchor / Pack up chip end to end), not on a real
  touch screen: the lift's tap / long-press flow most of all.
