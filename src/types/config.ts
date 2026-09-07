// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { ICueParser } from '../adapters/cue-parser/ICueParser';
import type { ILogger } from '../adapters/logger/ILogger';
import type { IPlatform } from '../adapters/platform/browser';
import type { IPreloadStrategy, ITransitionStrategy } from '../adapters/preload/default';
import type { HdrOnSdrFallback } from '../adapters/quality/hdr-policy';
import type { RealtimeFactory } from '../adapters/realtime/IRealtimeChannel';
import type { IShuffleStrategy } from '../adapters/shuffle-strategy/IShuffleStrategy';
import type { IStorage } from '../adapters/storage/IStorage';
import type { ITranslator } from '../adapters/translator/translator';

import type { LogLevel } from './log';
import type { BasePlaylistItem } from './playlist';
import type { PluginSpec } from './plugin';
import type { TranslationLoader, Translations } from './translations';
import type { IUrlResolver } from './url';

/**
 * An `Authorization` header value — accepted as a static string, a sync
 * getter, or an async getter so Vue refs, signals, and reactive stores all
 * plug in naturally: `bearerToken: () => myStore.token`.
 */
export type AuthHeaderValue = string | (() => string) | (() => Promise<string>);

/**
 * Unified auth pipeline applied to every kit-internal fetch — playlist URLs
 * at setup, lyrics, subtitles, sprite previews, and all `Plugin.fetch` calls.
 *
 * Hard rules baked in:
 *  - **401 (unauthenticated) → may invoke `refreshOnUnauthenticated`, retry once.**
 *  - **403 (unauthorized / forbidden) → propagates immediately. Never refreshed, never retried.**
 *  - The lint pack flags any code that handles 401 and 403 in the same branch.
 */
export interface AuthConfig {
	/**
	 * Convenience for the most common case — value goes into `Authorization: Bearer {value}`.
	 * Accepts a static string, a sync getter, or an async getter so Vue refs, signals, and
	 * reactive stores all work: `auth: { bearerToken: () => myRef.value }`.
	 */
	bearerToken?: AuthHeaderValue;

	/**
	 * The `Authorization` header to send with one media request — the manifest,
	 * each HLS segment, and the element `src` fallback.
	 *
	 * Separate from `bearerToken`, which covers the kit's own fetches to a known
	 * API. Media is different: the player plays what the consumer hands it, and
	 * a playlist entry can name anyone's host. Deciding whether a credential
	 * belongs on a given request needs the URL and a rule only the consumer has,
	 * so the kit asks rather than assumes — unset, media requests carry no
	 * `Authorization` at all.
	 *
	 * Synchronous: hls.js resolves headers per segment in a synchronous
	 * callback. Read a store or a ref here; do not fetch.
	 */
	mediaAuthorization?: (url: string) => string | undefined;

	/** Arbitrary headers — static, sync getter, or async getter. */
	headers?: Record<string, AuthHeaderValue>;

	/** `credentials` mode for fetch. Use `'include'` for cookie/session-based auth. */
	credentials?: 'omit' | 'same-origin' | 'include';

	/**
	 * URL rewriter. Runs before fetch. Use this for custom-scheme URLs
	 * (`nmsync://...`), pre-signed URL generation, or any scheme-translation
	 * the consumer needs.
	 */
	transformUrl?: (url: string) => string | Promise<string>;

	/**
	 * Escape hatch — receives the live Request, returns a modified Request.
	 * For HMAC payload signing, AWS Signature v4, custom challenge-response,
	 * anything that doesn't fit the simpler fields above.
	 */
	signRequest?: (request: Request) => Request | Promise<Request>;

	/**
	 * Called ONLY on 401 responses. Implementer refreshes the token. After
	 * this resolves, the kit retries the original request once with the new
	 * `bearerToken` / `headers` values resolved fresh. Never invoked on 403.
	 */
	refreshOnUnauthenticated?: () => Promise<void>;

	/** Default 1. Set to 0 to disable retry-after-refresh entirely. */
	retryAfterRefresh?: number;
}

/**
 * DRM configuration. Passed to a library-specific DRM plugin (e.g. the video
 * package's `DrmPlugin`) via `addPlugin(DrmPlugin, config)`.
 *
 * DRM is a video-only concern — this type is defined in the kit for
 * cross-package type sharing, but `BasePlayerConfig` does not include a `drm`
 * field. Configure DRM through the plugin directly.
 */
export interface DrmConfig {
	/** EME key system string (e.g. `'com.widevine.alpha'`, `'com.apple.fps'`). */
	keySystem: string;
	/** License server URL. The kit's fetch pipeline (including auth headers) is used. */
	licenseUrl: string;
	/** Optional server certificate for FairPlay and some Widevine deployments. */
	certificate?: ArrayBuffer | string;
	/** Optional per-request signing override — same contract as `AuthConfig.signRequest`. */
	customSignRequest?: (request: Request) => Request | Promise<Request>;
}

/**
 * The set of playback targets accepted by `transferTo()`.
 *
 *  - `'cast'` — Google Cast / Chromecast. Requires the Cast Web Sender SDK.
 *  - `'airplay'` — Safari / WebKit AirPlay picker. Opens on the bound `<video>` element.
 *  - `'remote-playback'` — W3C RemotePlayback API (Chrome desktop / Android).
 *  - `'local'` — Return playback to the local element (end an active cast/handoff session).
 */
export type CastTarget = 'cast' | 'airplay' | 'remote-playback' | 'local';

/**
 * Cast / Chromecast configuration for `transferTo('cast')`. All fields
 * optional — leave unset to use the Cast Web Sender SDK's own defaults
 * with the standard Google media receiver.
 */
export interface CastConfig {
	/**
	 * Auto-inject the Cast Web Sender SDK on first `transferTo('cast')`.
	 * When `false` (the default), `transferTo('cast')` throws
	 * `core:policy/castUnavailable` if the SDK script tag isn't already on
	 * the page — the consumer must include the script manually.
	 *
	 * Set `true` for the on-demand path: the SDK only loads when the user
	 * actually clicks Cast, no third-party network hit before then.
	 */
	autoLoad?: boolean;

	/**
	 * Cast receiver application ID. Defaults to the standard Google media
	 * receiver. Set this to your custom receiver's app ID (registered in the
	 * Google Cast Developer Console) to cast to a custom receiver app.
	 */
	receiverApplicationId?: string;

	/**
	 * Auto-join policy for existing Cast sessions on page load.
	 *  - `'origin-scoped'` (default) — rejoin sessions started anywhere on the same origin.
	 *  - `'tab-and-origin-scoped'` — rejoin only sessions started in the same tab.
	 *  - `'page-scoped'` — never auto-rejoin; user must reconnect explicitly.
	 */
	autoJoinPolicy?: 'origin-scoped' | 'tab-and-origin-scoped' | 'page-scoped';

	/** Resume the most recent saved session when the SDK initialises. Default `true`. */
	resumeSavedSession?: boolean;

	/**
	 * Override the SDK script URL. Useful for self-hosted mirrors or testing.
	 * Default: `https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1`.
	 */
	scriptUrl?: string;

	/**
	 * Timeout for SDK script load when `autoLoad: true`. Default `10000` ms.
	 * Past this, throws `core:policy/castLoadTimeout` so the UI can fall back
	 * to a non-Cast playback target.
	 */
	loadTimeoutMs?: number;
}

/**
 * Configuration accepted by both music and video players at `setup()`. Each
 * library extends this interface with its own domain-specific fields
 * (e.g. `NMMusicPlayerConfig` adds `crossfadeEnabled`; `NMVideoPlayerConfig`
 * adds `octopus`).
 */
export interface BasePlayerConfig {
	/** Logger verbosity. Controls output from the player and all registered plugins. */
	logLevel?: LogLevel;

	/** Consumer-supplied logger. Any `ILogger` impl (kit's `Logger`, Pino, Winston, custom). */
	logger?: ILogger;

	/**
	 * Base URL prepended to relative media URLs in playlist items. Absolute
	 * URLs are passed through unchanged.
	 */
	baseUrl?: string;

	/** Initial volume on the public 0–100 scale. Default `100`. */
	defaultVolume?: number;

	/**
	 * What to do when an item is all-HDR and the display cannot render HDR,
	 * and the backend cannot tone-map it down either. `'play'` (default) shows
	 * the washed-out picture; `'refuse'` surfaces an error instead. Read lazily
	 * wherever the decision is made — see `HdrOnSdrFallback` in
	 * `adapters/quality/hdr-policy`. Lives on the base config rather than
	 * `VideoPlayerConfig` because the native trio mirrors this on its shared
	 * config for the same reason.
	 */
	hdrOnSdr?: HdrOnSdrFallback;

	/** Auth pipeline applied to every kit-internal fetch. */
	auth?: AuthConfig;

	/** I18n language tag (`'en'`, `'nl-NL'`). Defaults to `navigator.language`. */
	language?: string;

	/** Translation bundles by language tag. The kit's English bundle is always merged underneath. */
	translations?: Translations;

	/**
	 * Async loader for translation bundles. Invoked on `setLanguage(lang)` when
	 * the bundle isn't already loaded. Use this to fetch from an API, dynamically
	 * import bundled JSON, or any other source. Return `undefined` to fall through
	 * to the static `translations` config.
	 */
	loadTranslations?: TranslationLoader;

	/**
	 * Fallback when `t(key)` finds no value. Default returns the key itself.
	 * Useful for surfacing missing keys to telemetry / dev-time overlays.
	 */
	onMissingTranslation?: (key: string, lang: string) => string;

	/**
	 * Pluggable storage backend. Default: `LocalStorageBackend`.
	 *
	 * This field is not read by any player mixin — `Plugin.storage` is the sole
	 * read path. Each plugin receives an auto-namespaced wrapper around this
	 * backend so plugin keys never collide with each other or with player-level keys.
	 * See `Plugin.storage` in the plugin authoring guide.
	 */
	storage?: IStorage;

	/**
	 * Realtime channel factory used by `Plugin.websocket(url)`. Swap to inject
	 * SignalR / Socket.IO / custom transport. Default: `nativeWebSocketAdapter`.
	 *
	 * This field is not read by any player mixin — `Plugin.websocket()` is the
	 * sole read path. Plugins access it automatically when they call `this.websocket(url)`.
	 */
	websocketFactory?: RealtimeFactory;

	/**
	 * Custom URL resolver invoked by `player.resolveUrl(url, category)`. Use
	 * to inject CDN-specific signing, per-category routing, or to short-circuit
	 * the auth pipeline for select asset types. Default applies
	 * `auth.transformUrl` + structured parsing via `buildResolvedUrl`.
	 *
	 * Custom resolvers can call `ctx.defaultResolve(url)` to delegate back to
	 * the built-in path for any category they don't want to handle.
	 */
	urlResolver?: IUrlResolver;

	/**
	 * Pluggable translation engine. Default kit impl is a key+`{vars}` lookup
	 * over the merged bundle table. Swap to plug in i18next / FormatJS / custom
	 * for pluralization, gender, ICU MessageFormat, RTL handling, etc.
	 *
	 * When supplied, the engine owns translation state and the kit-level
	 * `translations` / `loadTranslations` / `language` config is forwarded to
	 * the engine at construction.
	 */
	translator?: ITranslator;

	/**
	 * Platform abstraction bundle. Defaults to `browserPlatform`. Native-shell
	 * consumers (Capacitor, Tauri, Electron) inject native equivalents via
	 * `setup({ platform: capacitorPlatform })` or partial overrides
	 * `setup({ platform: { ...browserPlatform, wakeLock: capacitorWakeLock } })`.
	 */
	platform?: IPlatform;

	/**
	 * Custom cue parsers registered after the kit's defaults (LRC, VTT,
	 * sprite-VTT). Use this for TTML, SRT, ASS-as-cues, or proprietary
	 * formats. Most-recently-registered wins, so consumer parsers can override
	 * built-ins for the same URL pattern.
	 */
	cueParsers?: ReadonlyArray<ICueParser>;

	/** How often the player emits `playback:metrics` (ms). `0` disables. Default 10000. */
	metricsIntervalMs?: number;

	/**
	 * How often the player emits `progress` (throttled time updates for
	 * server-side watch-position persistence, ms). `0` disables. Default 5000.
	 * Consumers use `progress` instead of `time` when a few callbacks a second is
	 * more than they need.
	 */
	progressIntervalMs?: number;

	/** Pause when document goes hidden. Default `false`. */
	pauseWhenHidden?: boolean;

	/**
	 * Render the browser's native media controls on the backing element
	 * (`<audio controls>` / `<video controls>`). Useful when no UI plugin is
	 * loaded. Default `false`.
	 *
	 * Loading a UI plugin (e.g. video's `DesktopUiPlugin` / `TvKeyHandlerPlugin`)
	 * alongside `controls: true` results in doubled controls; use one or the other.
	 */
	controls?: boolean;

	/**
	 * Milliseconds of viewer inactivity (no pointer, touch, or key input on
	 * the container) before the player emits `activity { active: false }`
	 * while playing, which swaps the container's `.active` class for
	 * `.inactive` so UI CSS can fade controls. Any input emits
	 * `activity { active: true }` and restores `.active`. Hiding never happens
	 * while paused. `0` disables built-in activity tracking. Default 4000.
	 */
	inactivityMs?: number;

	/** Behavior on `network:offline`. Default `'continue-buffered'`. */
	onOffline?: 'pause' | 'continue-buffered' | 'ignore';

	/** Wake-lock policy. Video defaults `'auto'`; music defaults `'never'`. */
	wakeLock?: 'auto' | 'always' | 'never';

	/**
	 * Cast / Chromecast configuration. Set `cast: { autoLoad: true }` for the
	 * SDK to inject itself on first `transferTo('cast')`; set
	 * `receiverApplicationId` to point at a custom receiver app. See
	 * `CastConfig` for the full surface.
	 */
	cast?: CastConfig;

	/** Clock source for timestamps used in distributed-sync plugins. Defaults to `Date.now`. */
	clockSource?: () => number;

	/**
	 * Plugins to register before the setup pipeline's `pluginsRegistering`
	 * stage runs — the declarative alternative to calling `addPlugin(...)`
	 * yourself between construction and `setup()`. Each entry is a class ref
	 * (no options) or `{ plugin, opts }`; see `PluginSpec`. Sugar over
	 * `addPlugin()`, not a second registration path — identical validation
	 * and timing either way.
	 */
	plugins?: ReadonlyArray<PluginSpec>;

	/** Cap on plugin `use()` Promise resolution before marking the plugin failed (ms). Default 30000. */
	pluginInitTimeoutMs?: number;

	/**
	 * Cap on `BeforeEvent.delay(promise)` waits before timing out the action (ms).
	 * Timeout is treated as `preventDefault` — fires `<action>Prevented` with
	 * `reason: 'delay-timeout'`. Default 10000.
	 */
	beforeEventTimeoutMs?: number;

	/**
	 * Phase-aware mutation guards. Controls which mutating methods fire the
	 * `beforeMutation` event (and run plugin advisories).
	 *
	 *  - `false` — disable entirely. Fastest path, no advisory checking.
	 *  - `'all'` — guard every mutating method including hot-path ones
	 *    (`time`, `volume`, `playbackRate`, etc.). Use for dev/debug.
	 *  - `string[]` — guard only the named hot methods, in addition to the
	 *    always-on normal-mutation list.
	 *  - `undefined` (default) — guard only normal mutations
	 *    (`load`, `setCurrent`, `queue*`, `setSubtitle`, etc.); hot methods
	 *    skip the guard for performance.
	 */
	mutationGuards?: false | 'all' | ReadonlyArray<string>;

	/**
	 * Base URL prepended to relative image / poster paths in playlist items
	 * (`image`, `poster`, `thumbnail`, `cover`). Absolute URLs are passed
	 * through unchanged. For TMDB: `'https://image.tmdb.org/t/p/w780'`.
	 *
	 * Consumers needing per-category signing use `urlResolver` with
	 * `category: 'poster'` instead.
	 */
	baseImageUrl?: string;

	/** Initial playlist. Pass items directly, or a URL the player will fetch. */
	playlist?: BasePlaylistItem[] | string;

	/**
	 * Reshape every playlist item as it enters the queue — the playlist
	 * counterpart of `transformUrl`. Runs AFTER the player's built-in format
	 * normalization, on every entry path (`playlist` config array, `playlist`
	 * URL responses, `queue()` / `queueAppend()` / `queuePrepend()` /
	 * `queueInsert()`). Return the (new or same) item; keep it synchronous
	 * and pure — async enrichment belongs in plugins.
	 */
	transformPlaylistItem?: (item: BasePlaylistItem) => BasePlaylistItem;

	// ── Preload + transition ──────────────────────────────────────────────────

	/**
	 * Seconds before the natural end at which `itemEndingSoon` fires.
	 * Plugins and consumers listen to `itemEndingSoon` for preload and crossfade
	 * cues. Default `10`.
	 */
	itemEndingSoonThreshold?: number;

	/**
	 * How many seconds before the outgoing item ends the player begins prefetching
	 * the next item's assets (manifest, first segments, poster, sidecars).
	 * Default `10`. Set to `0` to disable preloading.
	 */
	preloadLeadSeconds?: number;

	/**
	 * How many seconds before the outgoing item ends the player begins the
	 * crossfade / transition window. Only used when `crossfadeEnabled: true`.
	 * Default `3`.
	 */
	crossfadeLeadSeconds?: number;

	/**
	 * How many seconds the incoming item plays in parallel with (on top of) the
	 * outgoing item before the outgoing is fully silent. Only used when
	 * `crossfadeEnabled: true`. Default `3`.
	 */
	crossfadeTailSeconds?: number;

	/**
	 * Enable the crossfade / overlap transition between queue items.
	 * When `false` (the default for video) the player uses a hard-cut gapless
	 * transition — assets are still preloaded, but there is no audio overlap.
	 * Per-library defaults:
	 *  - Music: `true`
	 *  - Video: `false`
	 */
	crossfadeEnabled?: boolean;

	/**
	 * Custom shuffle strategy. When supplied, replaces the default
	 * `FisherYatesShuffle`. Inject this to implement cursor-aware ordering,
	 * upcoming-only shuffle, weighted randomisation, or deterministic sequences.
	 *
	 * The strategy must return a permutation of the same items — no drops, no
	 * duplicates. Cursor-follow (keeping the playing item selected after a
	 * shuffle) is handled by `MediaList` automatically for any strategy.
	 */
	shuffleStrategy?: IShuffleStrategy;

	/**
	 * Custom preload strategy. When supplied, replaces the default
	 * `DefaultPreloadStrategy`. Inject this to customise which assets are
	 * prefetched, or to implement a different timing heuristic.
	 *
	 * The strategy is stateless — a single instance is reused across items.
	 * Call `strategy.cancel()` before navigating away if you hold a reference.
	 */
	preloadStrategy?: IPreloadStrategy;

	/**
	 * Custom transition strategy. When supplied, replaces the per-library default
	 * (`CrossfadeTransitionStrategy` for music, `GaplessTransitionStrategy` for
	 * video). Inject this to implement custom fades, cuts, or creative transitions.
	 */
	transitionStrategy?: ITransitionStrategy;

	/**
	 * Attach the player instance to `window.player` for console debugging.
	 * Cleaned up on `dispose()`. Default `false`.
	 *
	 * The library factory (`nmplayer`) additionally attaches itself to
	 * `window.nmplayer` when this is `true`.
	 */
	expose?: boolean;
}
