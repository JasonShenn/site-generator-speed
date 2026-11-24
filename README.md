# site-generator-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/JasonShenn/site-generator-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/JasonShenn/site-generator-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast static site generator written from scratch (zero dependencies, ES module).

Built for the make.fun bounty [site-generator-speed-01-run-20261122](https://make.fun/competitions/site-generator-speed-01-run-20261122) — "Build a static site faster, 22 November 2026".

`run(input)` returns byte-exact output matching the `makefun-site` 1.0.0 reference behaviour: per-page `index.html`, index and tag pages, `build-report.txt`, and static files.

## Run it

```sh
node main.ts
```

Reads `/input/cases.json`, writes `/output/answers.json` (`MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` override the paths outside a container).

## Layout

- `solve.js` — the generator (`run(input)`).
- `main.ts` — harness entry point: reads `/input/cases.json`, calls `run`, writes `/output/answers.json`.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=c6gdgq6q&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
