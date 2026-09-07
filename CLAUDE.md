# NoMercy Player Core

Headless, plugin-driven engine shared by `nomercy-music-player` and `nomercy-video-player`. Carries everything not specific to audio or video: queue, transport, auth, i18n, storage, the plugin system, the typed event bus.

## Tech stack

- TypeScript (ES2022), outputs ESM via `tsc`
- Testing: Vitest (unit)
- Linting: `@antfu/eslint-config` (ESLint 9 flat config) + `@nomercy-entertainment/eslint-plugin-player`
- Formatting: Prettier — tabs, width 4, single quotes, semis, printWidth 150

## Structure

```
src/
  core/            # mixins composed onto per-library player prototypes (queue, transport, time, volume, auth, etc.)
  adapters/         # swappable interfaces + defaults (storage, logger, fetch, realtime, preload, url-resolver, shuffle, ...)
  plugins/          # cross-library plugins (cast-sender, media-session, key-handler, embed, ...)
  types/            # BasePlaylistItem, BasePlayerConfig, BaseEventMap, IPlayer, ...
  testing/          # describePlugin conformance harness
  errors/           # PlayerError hierarchy
  i18n/             # kit's own English bundle
  base-player.ts    # shared base-player composition helper
  index.ts          # public API entry point
```

## Conventions

- npm scope: `@nomercy-entertainment/nomercy-player-core`
- Module type: ESM (`"type": "module"`)
- Subpath exports for adapters, plugins, streams, testing — tree-shakable

## Rules

Shared player-trio architecture — `BasePlayerConfig` field-sharing, the
subtitle-method placement rule, the plugin event bus, the auto-advance
asymmetry, and the lint tooling — is documented once in `../PLAYER-TRIO.md`.
Read it; it is not repeated here.

- Every method here must be identical in behavior for music and video, no domain twist. A branch on "is this music or video" means the method belongs in a per-library player class, not here — pull it back down.
- Adapters are interfaces with a default impl, swappable via `setup()`. No subclassing to override cross-cutting concerns.
- Run `npm run typecheck` and `npm test` before committing changes.
