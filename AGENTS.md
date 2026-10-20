# Notes for coding agents

## Preview deploys

Every pull request gets a preview deploy through Cloudflare Workers Builds, so
any code pushed to an open PR can be tried in a browser (or on a phone) without
merging. The `cloudflare-workers-and-pages` bot comments on the PR with two
links and updates the comment on each push:

- **Commit Preview URL**: that exact commit, e.g. `https://522faf09-battledrones.simonw.workers.dev`
- **Branch Preview URL**: the latest commit on the branch, at
  `https://<branch-slug>-battledrones.simonw.workers.dev` (the branch name
  with `/` turned into `-`; `claude/wonderful-meitner-m2zye5` became
  `claude-wonderful-meitner-m2zye5-battledrones.simonw.workers.dev`)

Point people at the preview when a change needs testing by hand, such as on
real phones. GitHub Pages (`simonw.github.io/battledrones/`) only deploys from
`main`; the Pages workflow builds pull requests but doesn't publish them.
