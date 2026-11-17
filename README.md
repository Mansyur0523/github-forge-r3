[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Mansyur0523/github-forge-r3/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Mansyur0523/github-forge-r3/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-forge

A fast, dependency-free GitHub-compatible git forge built from scratch in
Node.js (standard library only, no git binary). It speaks the GitHub
REST v3 API, a GraphQL endpoint, MCP over Streamable HTTP, and git smart
HTTP (upload-pack v2 / receive-pack v0) — all backed by one in-memory store
with deterministic timestamps, so a replay leaves the same bytes.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

The server binds an ephemeral port on 127.0.0.1, registers it with the
harness at `$MAKEFUN_ENV_URL`, and exits when the harness reports done.
Without `MAKEFUN_ENV_URL` it just listens until killed.

## Test

```sh
npm test
```

The smoke test boots the server on a scratch port and exercises
health, REST repos/issues, GraphQL viewer, and MCP discover/tools.

<sub>Entered on [make.fun](https://make.fun/?ref=bttrf0vb&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
