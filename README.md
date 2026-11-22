# site-generator-speed

A fast static site generator written from scratch (zero dependencies, ES module).

Built for the make.fun bounty [site-generator-speed-01-run-20261122](https://make.fun/competitions/site-generator-speed-01-run-20261122) — "Build a static site faster, 22 November 2026".

`run(input)` returns byte-exact output matching the `makefun-site` 1.0.0 reference behaviour: per-page `index.html`, index and tag pages, `build-report.txt`, and static files.

## Layout

- `solve.js` — the generator (`run(input)`).
- `main.ts` — harness entry point: reads `/input/cases.json`, calls `run`, writes `/output/answers.json`.

## License

MIT — see `LICENSE`.
