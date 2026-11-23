# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tzf12138/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tzf12138/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend applies the edits AI models write — unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor calls — to a tree of text files. It matches lines at three tiers of whitespace forgiveness, re-indents drifted edits, and changes every file or none: a failed edit is reported and nothing is written.

## Run it

```sh
node main.ts [options] [PATCH]
```

Node 22, standard library only, no dependencies. `PATCH` is the patch file (or `-`, or nothing, to read standard input). `--format=auto` (the default) detects the format; `--format=unified`, `--format=search-replace`, `--format=v4a` or `--format=json` force one. `--check` reports what would change without writing; `--strict` matches lines exactly. See `SPEC.md` for the full specification.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9ewgsfmm&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
