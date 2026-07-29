- **AI ignore patterns now follow `.gitignore`'s matching rules.** A bare name
  matches at any depth (`secrets.env` also covers `config/secrets.env`), a bare
  folder name hides that folder's contents wherever it sits (`node_modules`), a
  leading `/` anchors a pattern to the repo root, and `*` stops at a `/`, so
  `docs/*.log` covers `docs/a.log` but not `docs/sub/b.log`. **Patterns you
  already have may hide more than they did:** saved lines carry no anchor —
  including every one *Exclude from AI* added — so a stored `notes.md` now hides
  each file of that name rather than only the copy at the root, and a stored
  `build` or `node_modules` now hides those folders instead of nothing at all.
  That only ever withholds more from a model, never less, but it's worth a look
  at your lists. *Exclude from AI* now writes anchored lines
  (`/src/config.ts`, `/vendor/`) that mean the one file or folder you picked,
  matching what *Ignore* writes to `.gitignore`. `!` re-include lines aren't
  supported.
