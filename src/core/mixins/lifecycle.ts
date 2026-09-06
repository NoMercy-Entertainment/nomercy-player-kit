// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { IPlatform } from '../../adapters/platform/browser';
import type { IPreloadStrategy, ITransitionBackend, PreloadAsset } from '../../adapters/preload/default';
import type {
	BasePlayerConfig,
	BasePlaylistItem,
	PlayerPhase,
	TranslationLoader,
	Translations,
} from '../../types';
import type { Internals } from '../state';
import type { ItemWithTracks } from './sidecar-util';
import { builtInCueParsers } from '../../adapters/cue-parser/built-ins';
import { Logger } from '../../adapters/logger/default';
import { LEVEL_RANK } from '../../adapters/logger/ILogger';
import { browserPlatform } from '../../adapters/platform/browser';
import { DefaultPreloadStrategy } from '../../adapters/preload/default';
import { hlsFactory } from '../../adapters/stream/hls';
import { nativeFactory } from '../../adapters/stream/native';
import { StreamRegistry } from '../../adapters/stream/registry';
import { getLazyTranslationLoader } from '../../adapters/translator/loaders/translations-glob';
import { DefaultTranslator } from '../../adapters/translator/translator';
import { makePlayerErrorEvent, stateError, StateError } from '../../errors';
import { enTranslations } from '../../i18n/en';
import { kitTranslations } from '../../kit-translations';

import { SetupState } from '../../types';
import { authFetch } from '../auth-fetch';
import { wireActivityTracking } from './activity';
import { applyPendingSelection } from './queue';

// ──────────────────────────────────────────────────────────────────────────
// Playlist URL resolver
// ──────────────────────────────────────────────────────────────────────────

/**
 * Fetch a playlist URL, parse the JSON response as an array of items, hand
 * off to the queue, and emit `playlistReady`. On any failure (network error,
 * non-array body, JSON parse error) emits `playlistError` with structured info
 * and `playlistReady` with `length: 0` so the player still reaches the ready
 * phase. Never throws — all error paths are handled internally.
 */
async function _resolvePlaylistUrl(self: Internals, url: string): Promise<void> {
	self.emit('playlistResolving', { url });

	try {
		const ctrl = new AbortController();
		const items = await authFetch<BasePlaylistItem[]>({
			url,
			auth: self._authConfig,
			signal: ctrl.signal,
			responseType: 'json',
		});

		if (!Array.isArray(items)) {
			self.emit('playlistError', {
				url,
				error: new Error('Playlist response is not a JSON array'),
				code: 'core:playlist/parse-error',
			});
			self.emit('playlistReady', { length: 0 });
			return;
		}

		// Hand off to the queue mixin — reuses the same validation + event path
		// as a consumer calling `player.queue(items)`.
		self.queue(items);
		self.emit('playlistReady', { length: items.length });
	}
	catch (error) {
		self.emit('playlistError', {
			url,
			error: error instanceof Error ? error : new Error(String(error)),
			code: 'core:playlist/fetch-error',
		});
		self.emit('playlistReady', { length: 0 });
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Mixin: lifecycle — owns the player's birth, ready signal, and death.
// `setup()` wires every cross-cutting concern (visibility / network / wakeLock
// policies, metrics, progress emit, preload + transition orchestration) and
// kicks off the async pipeline that fires `ready`. `dispose()` tears the same
// wiring down via the cleanup queue each `_wire*` helper pushed onto it.
// ──────────────────────────────────────────────────────────────────────────

export const lifecycleMethods = {
	/**
	 * Configure the player and start the async setup pipeline.
	 *
	 * Synchronously: snapshots options, seeds internal state from config,
	 * wires every cross-cutting concern
	 * (visibility, network, wake-lock, metrics, progress, preload+transition,
	 * window expose), and emits `beforeSetup` followed by a `setup` phase
	 * transition.
	 *
	 * Asynchronously: fires the setup pipeline (`setupStart` → `configResolved`
	 * → `pluginsRegistering` → `pluginsRegistered` → `streamsReady` → `authReady`
	 * → `playlistReady` → `mediaReady` → `ready`). Each stage emits its name on
	 * success or a `<stage>Error` event on failure, then rejects the `ready()`
	 * promise.
	 *
	 * Throws `core:lifecycle/already-setup` if called twice without `dispose()`
	 * in between, or `core:player/disposed` if called after dispose. Returns
	 * the player instance so callers can chain.
	 */
	setup(this: Internals, config: BasePlayerConfig): unknown {
		_guardSetup(this);
		this._setupCalled = true;

		_normalizeOptions(this, config);
		_registerConfigPlugins(this, config);
		_seedFromOptions(this);
		this.container.classList.add('nomercyplayer');
		_wireLogger(this);
		_initTranslator(this);
		_registerCueParsers(this);
		_resolvePlatform(this);

		_wireVisibilityPolicy(this);
		_wireNetworkPolicy(this);
		_wireWakeLockPolicy(this);
		_wireMetrics(this);
		_wireTimeAndDurationSync(this);
		_wireChapterGapFillOnDuration(this);
		_wireProgressEmit(this);
		_wirePreloadAndTransition(this);
		_wireWindowExpose(this);
		wireActivityTracking(this);

		this.emit('beforeSetup');
		this._transitionPhase('setup');
		_runSetupPipeline(this);

		return this;
	},

	/**
	 * Returns a promise that resolves when the setup pipeline reaches the
	 * `ready` stage, or rejects if any stage fails or `dispose()` is called
	 * first. Memoised — repeated calls return the same promise.
	 *
	 * Already in `'ready'` phase? Resolves immediately. Already disposed?
	 * Rejects immediately with `core:player/disposed`.
	 *
	 * A post-setup `addPlugin(X)` tracks its in-flight registration in
	 * `_pendingPluginRegistrations` (see `plugin-registration.ts`). When that
	 * set is non-empty, `ready()` waits for it to drain before resolving —
	 * otherwise a consumer calling `addPlugin(X).ready()` after the player
	 * already reached `'ready'` would get back the memoised initial-setup
	 * promise, already resolved, regardless of whether X finished registering.
	 */
	ready(this: Internals): Promise<void> {
		if (!this._readyPromise) {
			this._readyPromise = new Promise<void>((resolve, reject) => {
				if (this._phase === 'ready') {
					resolve();
					return;
				}
				if (this._phase === 'disposed' || this._phase === 'disposing') {
					reject(stateError('core:player/disposed', 'ready() called after dispose()'));
					return;
				}
				this._readyResolve = resolve;
				this._readyReject = reject;
			});
		}

		if (this._pendingPluginRegistrations.size === 0) {
			return this._readyPromise;
		}

		return this._readyPromise.then(() => _drainPendingPluginRegistrations(this));
	},

	/**
	 * Tear down the player. Idempotent — a second call is a no-op.
	 *
	 * Dispatches `beforeDispose` first; a listener may `preventDefault()` to
	 * cancel, in which case `disposePrevented` fires and the player stays
	 * fully alive (no cleanup runs, no listeners are removed, no plugin is
	 * touched). Otherwise disposes every registered plugin (reverse
	 * registration order — see `_disposeAllPlugins`) while the player is
	 * still otherwise intact, THEN drains the policy cleanup queue
	 * (everything `setup()`'s `_wire*` helpers registered: subscriptions,
	 * event listeners, intervals, RAF handles) BEFORE emitting `dispose`, so
	 * handlers observing the transition see a sensible final state. Phase
	 * moves `→ disposing → disposed`, the `ready()` promise rejects if it
	 * hadn't resolved yet, and all listeners are removed.
	 *
	 * After this call the instance is dead — re-setup requires constructing a
	 * new player. Returns a `Promise<void>` so callers can await the full
	 * cancellable cycle; per-library `dispose()` wrappers that tear down their
	 * own backend check `phase() === 'disposed'` after awaiting this to know
	 * whether teardown actually proceeded — plugin disposal always runs
	 * before that backend/element teardown, so a plugin can still read the
	 * player while it cleans up.
	 */
	async dispose(this: Internals): Promise<void> {
		if (this._phase === 'disposed' || this._phase === 'disposing')
			return;

		const result = await this._dispatchBefore<void>('beforeDispose', undefined);
		if (result.prevented) {
			this.emit('disposePrevented', {
				reason: result.reason ?? 'listener-prevented',
				cause: result.cause,
			});
			return;
		}

		const wasReady = this._phase === 'ready';
		this._transitionPhase('disposing');

		this._disposeAllPlugins();

		for (const cleanup of this._policyCleanup) {
			try {
				cleanup();
			}
			catch (cause) {
				// Defensive but observable — surface teardown bugs without
				// blocking the rest of the queue. Listeners are still live
				// (off('all') runs at the end of dispose), so handlers wired
				// for diagnostics will see the warning.
				const error = new StateError({
					code: 'core:lifecycle/cleanup-failed',
					severity: 'warning',
					scope: { kind: 'core' },
					message: 'dispose cleanup callback threw',
					cause,
				});
				try {
					this.emit('warning', makePlayerErrorEvent(error, 'warning', { kind: 'core' }));
				}
				catch { /* belt-and-braces — never let a warning handler abort dispose */ }
			}
		}
		this._policyCleanup = [];
		// Only reject the ready promise when setup never finished — rejecting
		// a settled promise is a no-op but the lying message ("called before
		// ready") would mislead anyone debugging from the rejection stack.
		if (!wasReady) {
			this._readyReject?.(stateError('core:player/disposed', 'dispose() called before ready'));
		}
		this.emit('dispose');
		this._transitionPhase('disposed');
		this.off('all');
	},

	/**
	 * High-level setup status as a `SetupState` enum value. Coarser than `phase()`:
	 * `'idle'` → `NOT_SETUP`, `'setup'` → `SETTING_UP`, `'disposing'`/`'disposed'`
	 * → `DISPOSED`, anything else (loading / ready / playing / paused / etc.)
	 * → `READY`. Useful for "is the player usable right now?" checks.
	 */
	setupState(this: Internals): SetupState {
		switch (this._phase) {
			case 'idle':
				return SetupState.NOT_SETUP;
			case 'setup':
				return SetupState.SETTING_UP;
			case 'disposing':
			case 'disposed':
				return SetupState.DISPOSED;
			default:
				return SetupState.READY;
		}
	},

	/** Current fine-grained player phase (idle / setup / loading / ready / playing / paused / ...). */
	phase(this: Internals): PlayerPhase {
		return this._phase;
	},

	/**
	 * Names of all events currently being dispatched, outermost first.
	 * Populated by `pushDispatch` / `popDispatch` around event emission;
	 * read by `beforeMutation` advisories that gate on which event chain
	 * they're inside.
	 */
	dispatching(this: Internals): ReadonlyArray<string> {
		return [...this._dispatchStack];
	},

	/**
	 * Push an event name onto the dispatch stack. Used by the shared
	 * `runDispatchBefore` helper from both kit transport mixins AND
	 * `Plugin.dispatchBefore`. Pairs with `popDispatch`.
	 */
	pushDispatch(this: Internals, name: string): void {
		this._dispatchStack.push(name);
	},

	/** Pop the most recently pushed dispatch name. Returns the popped name or `undefined`. */
	popDispatch(this: Internals): string | undefined {
		return this._dispatchStack.pop();
	},

	/**
	 * The platform bundle (visibility / network / wake-lock / fullscreen / etc.).
	 * Defaults to `browserPlatform`; consumers swap via `setup({ platform: ... })`
	 * for Capacitor / Tauri / Electron or to mock for tests. Returns the default
	 * even before `setup()` has run so early reads don't need a null check.
	 */
	platform(this: Internals): IPlatform {
		return this._platform ?? browserPlatform;
	},
} as const;

/**
 * Wait for every currently in-flight post-setup plugin registration
 * (`_pendingPluginRegistrations`, written by `addPlugin` in
 * `plugin-registration.ts`) to settle. Loops rather than a single
 * `Promise.allSettled` pass because a plugin's `use()` may itself call
 * `addPlugin`, adding a fresh entry to the set while this drain is in flight.
 */
async function _drainPendingPluginRegistrations(self: Internals): Promise<void> {
	while (self._pendingPluginRegistrations.size > 0) {
		await Promise.allSettled(Array.from(self._pendingPluginRegistrations));
	}
}

// ──────────────────────────────────────────────────────────────────────────
// Setup phase helpers — invoked in order by setup() above
// ──────────────────────────────────────────────────────────────────────────

/** Reject re-entry or post-dispose `setup()` calls with a typed StateError. */
function _guardSetup(self: Internals): void {
	if (self._setupCalled) {
		throw stateError('core:lifecycle/already-setup', 'setup() called twice. Re-setup requires dispose() first.');
	}
	if (self._phase === 'disposed' || self._phase === 'disposing') {
		throw stateError('core:player/disposed', 'setup() called after dispose().');
	}
}

/** Snapshot the config onto `self.options`. */
function _normalizeOptions(self: Internals, config: BasePlayerConfig): void {
	self.options = { ...config };
}

/**
 * Queue every `config.plugins` entry through `addPlugin()` — the declarative
 * config path is sugar over that call, not a second registration mechanism.
 * Same validation (`core:plugin/duplicate-id`, `-missing-dep`,
 * `-version-mismatch`, `-incompatible-core-version`), same pre-setup
 * `pluginsRegistering` queueing. Runs before `_transitionPhase('setup')`
 * below so `addPlugin`'s `'idle'`-phase queueing branch is the one that
 * applies, matching a consumer who called `addPlugin()` manually beforehand.
 */
function _registerConfigPlugins(self: Internals, config: BasePlayerConfig): void {
	if (!config.plugins)
		return;

	for (const spec of config.plugins) {
		const pluginClass = typeof spec === 'function' ? spec : spec.plugin;
		const opts = typeof spec === 'function' ? undefined : spec.opts;
		self.addPlugin(pluginClass, opts);
	}
}

/** Copy options that runtime methods read directly into their `self._*` slots. */
function _seedFromOptions(self: Internals): void {
	// Authoritative auth copy — `auth(config)` and `auth(partial)` mutators
	// write here, the auth-fetch pipeline reads here.
	self._authConfig = self.options.auth ? { ...self.options.auth } : undefined;

	self._urlResolver = self.options.urlResolver;

	if (self.options.baseUrl)
		self._baseUrl = self.options.baseUrl;

	if (typeof self.options.defaultVolume === 'number') {
		self._internalVolume = Math.max(0, Math.min(100, self.options.defaultVolume));
		self._volumeBeforeMute = self._internalVolume;
	}

	if (self.options.shuffleStrategy)
		self._queueList.setShuffleStrategy(self.options.shuffleStrategy);
}

/**
 * Build the i18n translator. Uses the consumer-supplied `options.translator`
 * if present (custom backend like i18next or FormatJS) — the kit does not
 * seed a custom engine, it owns its own translation state end to end.
 *
 * Otherwise constructs a `DefaultTranslator` seeded with the kit's own
 * `core.*` bundle. English (`enTranslations`, `src/i18n/en.ts`) is imported
 * eagerly and merged in synchronously so `t('core.*')` resolves out of the
 * box before any async load completes — it's also the translator's fallback
 * language. Every other kit language (`kitTranslations`, lazy via the same
 * `translationsFromGlob` mechanism plugins use) loads on demand the first
 * time `language(lang)` switches to it; non-active languages never enter
 * memory. Consumer-supplied `options.translations` / `options.loadTranslations`
 * always win a same-key collision against the kit default.
 */
function _initTranslator(self: Internals): void {
	if (self.options.translator) {
		self._translator = self.options.translator;
		return;
	}

	const consumerTranslations = self.options.translations;
	const otherConsumerLanguages: Translations = {};
	if (consumerTranslations) {
		for (const [lang, bundle] of Object.entries(consumerTranslations)) {
			if (lang !== 'en')
				otherConsumerLanguages[lang] = bundle;
		}
	}

	const seededTranslations: Translations = {
		en: {
			...enTranslations,
			...consumerTranslations?.['en'],
		},
		...otherConsumerLanguages,
	};

	const kitLoader = getLazyTranslationLoader(kitTranslations);

	self._translator = new DefaultTranslator({
		language: self.options.language,
		translations: seededTranslations,
		loadTranslations: kitLoader ? _composeKitAndConsumerLoaders(kitLoader, self.options.loadTranslations) : self.options.loadTranslations,
		onMissingTranslation: self.options.onMissingTranslation,
	});
}

/**
 * Merge the kit's lazy `core.*` bundle for a language with the consumer's own
 * `loadTranslations` result for the same tag. Kit resolves first so a
 * consumer-supplied key always wins a collision; either side returning
 * `undefined` falls through to whatever the other produced.
 */
function _composeKitAndConsumerLoaders(
	kitLoader: TranslationLoader,
	consumerLoader: TranslationLoader | undefined,
): TranslationLoader {
	return async (lang: string): Promise<Record<string, string> | undefined> => {
		const kitBundle = await kitLoader(lang);
		const consumerBundle = await consumerLoader?.(lang);
		if (!kitBundle)
			return consumerBundle;
		if (!consumerBundle)
			return kitBundle;
		return {
			...kitBundle,
			...consumerBundle,
		};
	};
}

/**
 * Register cue parsers in priority order. Built-ins (LRC, VTT-subtitle,
 * sprite-VTT) go first so consumer-supplied parsers registered after them win
 * resolution — the registry walks newest-first.
 */
function _registerCueParsers(self: Internals): void {
	for (const parser of builtInCueParsers) {
		self._cueParsers.register(parser);
	}
	if (self.options.cueParsers) {
		for (const parser of self.options.cueParsers) {
			self._cueParsers.register(parser);
		}
	}
}

/**
 * Pin the platform bundle for this player instance. Defaults to
 * `browserPlatform`; consumers swap via `options.platform` for native
 * runtimes (Capacitor / Tauri / Electron) or to mock for tests. Must run
 * before any `_wire*` helper that touches `self._platform`.
 */
function _resolvePlatform(self: Internals): void {
	self._platform = self.options.platform ?? browserPlatform;
}

/**
 * Pause playback when the page goes hidden. Emits `visibility:visible` /
 * `visibility:hidden` regardless of the pause action. Opt-in via
 * `options.pauseWhenHidden` (default off).
 */
function _wireVisibilityPolicy(self: Internals): void {
	if (!self.options.pauseWhenHidden)
		return;

	const platform = self._platform ?? browserPlatform;
	const unsubscribe = platform.visibility.subscribe((visible) => {
		if (!visible) {
			self.pause({ source: 'platform' }).catch(() => { /* swallow */ });
		}
		if (visible) {
			self.emit('visibility:visible');
		}
		else {
			self.emit('visibility:hidden');
		}
	});
	self._policyCleanup.push(unsubscribe);
}

/**
 * React to network state changes per `options.onOffline`:
 *  - `'pause'`              — calls `pause()` when offline.
 *  - `'continue-buffered'`  — emits `network:offline` but doesn't touch transport (default).
 *  - `'ignore'`             — no subscription, no emit.
 * `network:online` fires on reconnect in all non-ignore modes.
 */
function _wireNetworkPolicy(self: Internals): void {
	const onOffline = self.options.onOffline ?? 'continue-buffered';
	if (onOffline === 'ignore')
		return;

	const platform = self._platform ?? browserPlatform;
	let wasNetworkSlow = false;

	const unsubscribe = platform.network.subscribe((state) => {
		if (state.online) {
			self.emit('network:online');

			const downlink = platform.network.downlinkMbps?.();
			const isSlowNow = typeof downlink === 'number' && downlink > 0 && downlink < 1.5;

			if (isSlowNow && !wasNetworkSlow) {
				self.emit('network:slow', { rttMs: platform.network.rttMs?.() });
			}

			wasNetworkSlow = isSlowNow;
		}
		else {
			wasNetworkSlow = false;
			self.emit('network:offline');
			if (onOffline === 'pause') {
				self.pause({ source: 'platform' }).catch(() => { /* swallow */ });
			}
		}
	});
	self._policyCleanup.push(unsubscribe);
}

/**
 * Hold a screen wake lock so the device doesn't sleep during playback.
 * `options.wakeLock`:
 *  - `'never'`   — never acquire (default).
 *  - `'always'`  — acquire at setup, release at dispose.
 *  - `'auto'`    — follow phase transitions: acquire on `'playing'`/`'starting'`,
 *                  release on `'paused'`/`'stopped'`/`'ended'`/`'disposed'`.
 * All acquire/release calls swallow errors — wake-lock is best-effort.
 */
function _wireWakeLockPolicy(self: Internals): void {
	const wakeLockPolicy = self.options.wakeLock ?? 'never';
	const platform = self._platform ?? browserPlatform;

	if (wakeLockPolicy === 'always') {
		void platform.wakeLock.acquire().catch(() => { /* unsupported */ });
		self._policyCleanup.push(() => {
			void platform.wakeLock.release().catch(() => { /* defensive */ });
		});
	}
	else if (wakeLockPolicy === 'auto') {
		const phaseHandler = ({ to }: { to: PlayerPhase }): void => {
			if (to === 'playing' || to === 'starting') {
				if (!platform.wakeLock.isHeld()) {
					void platform.wakeLock.acquire().catch(() => { /* unsupported */ });
				}
			}
			else if (to === 'paused' || to === 'stopped' || to === 'ended' || to === 'disposed') {
				if (platform.wakeLock.isHeld()) {
					void platform.wakeLock.release().catch(() => { /* defensive */ });
				}
			}
		};
		self.on('phase', phaseHandler);
		self._policyCleanup.push(() => {
			self.off('phase', phaseHandler);
			if (platform.wakeLock.isHeld()) {
				void platform.wakeLock.release().catch(() => { /* defensive */ });
			}
		});
	}
}

/**
 * Wire the playback-metrics pipeline. Three signals get populated as the
 * player runs:
 *  - `ttff`           — milliseconds from first `play()` to first `firstFrame`.
 *                       Single-shot; only the first play→frame pair counts.
 *  - `joinTime`       — milliseconds from setup() to first `firstFrame`.
 *  - `rebufferRatio`  — cumulative stall time ÷ session duration. Stall starts
 *                       on `backend:waiting`, ends on `backend:loaded` or `play`.
 *
 * On a non-zero `options.metricsIntervalMs` (default 10s), `playback:metrics`
 * fires periodically carrying the current snapshot (with `sessionDurationMs`
 * refreshed). All listeners and the interval timer are released on dispose
 * via the cleanup queue.
 */
/**
 * Build the player's root logger from config (`logger` instance wins over
 * `logLevel`) and wire the console output `logLevel` promises:
 *
 *  - `error` / `<stage>Error` events always log at error rank — a codec or
 *    stream failure must be visible without any consumer wiring.
 *  - At `debug`, every event except the high-frequency clock (`time`,
 *    `progress`) is logged. At `trace`, everything is.
 *
 * Without this, `logLevel` only fed plugin child-loggers and the core was
 * mute — failures surfaced as events with no listener and vanished.
 */
function _wireLogger(self: Internals): void {
	const logger = self.options.logger ?? new Logger({
		level: self.options.logLevel,
		prefix: 'nmplayer',
	});
	self._logger = logger;

	self.on('all', (event: string, data: unknown) => {
		if (event === 'error' || event.endsWith('Error')) {
			const payload = data as { error?: unknown } | undefined;
			logger.error(event, payload?.error ?? data);
			return;
		}
		if (LEVEL_RANK[logger.level()] < LEVEL_RANK.debug)
			return;
		if ((event === 'time' || event === 'progress') && logger.level() !== 'trace')
			return;
		logger.debug(event, data);
	});
}

function _wireMetrics(self: Internals): void {
	self._metricsStartedAt = Date.now();

	let ttffStartTs = 0;
	let ttffRecorded = false;
	const onPlay = (): void => {
		if (ttffStartTs === 0)
			ttffStartTs = Date.now();
	};
	const onFirstFrame = (): void => {
		if (!ttffRecorded && ttffStartTs > 0) {
			self._metrics.ttff = Date.now() - ttffStartTs;
			ttffRecorded = true;
			if (self._metricsStartedAt > 0) {
				self._metrics.joinTime = Date.now() - self._metricsStartedAt;
			}
		}
	};
	self.on('play', onPlay);
	self.on('firstFrame', onFirstFrame);

	let stallStartTs = 0;
	let cumulativeStallMs = 0;
	const onWaiting = (): void => {
		if (stallStartTs === 0)
			stallStartTs = Date.now();
	};
	const onResume = (): void => {
		if (stallStartTs > 0) {
			cumulativeStallMs += Date.now() - stallStartTs;
			stallStartTs = 0;
			const sessionMs = Date.now() - self._metricsStartedAt;
			if (sessionMs > 0) {
				self._metrics.rebufferRatio = cumulativeStallMs / sessionMs;
			}
		}
	};
	self.on('backend:waiting', onWaiting);
	self.on('backend:loaded', onResume);
	self.on('play', onResume);

	self._policyCleanup.push(() => {
		self.off('play', onPlay);
		self.off('firstFrame', onFirstFrame);
		self.off('backend:waiting', onWaiting);
		self.off('backend:loaded', onResume);
		self.off('play', onResume);
	});

	const interval = self.options.metricsIntervalMs ?? 10_000;
	if (interval > 0) {
		self._metricsTimer = setInterval(() => {
			self._metrics.sessionDurationMs = Date.now() - self._metricsStartedAt;
			self.emit('playback:metrics', self._metrics);
		}, interval);
		self._policyCleanup.push(() => {
			if (self._metricsTimer)
				clearInterval(self._metricsTimer);
			self._metricsTimer = undefined;
		});
	}
}

/**
 * Mirror the latest `time` and `duration` event values onto internal slots
 * so reads from non-event paths (transition tick, progress emit, preload
 * orchestration) don't need to re-derive them from the backend on every call.
 */
function _wireTimeAndDurationSync(self: Internals): void {
	const onTimeSync = ({ time }: { time: number }): void => {
		self._internalCurrentTime = time;
	};
	self.on('time', onTimeSync);
	self._policyCleanup.push(() => {
		self.off('time', onTimeSync);
	});

	const onDurationSync = ({ duration }: { duration: number }): void => {
		self._internalDuration = duration;
	};
	self.on('duration', onDurationSync);
	self._policyCleanup.push(() => {
		self.off('duration', onDurationSync);
	});
}

/**
 * Re-run the malformed-chapter safety net whenever the backend reports a
 * duration. `_resolveAndEmitChapters` (media-tracks.ts) already applies it
 * on cursor change, but chapters routinely resolve before the real
 * duration is known — this is the other half of the same seam, catching
 * the active item up once a duration finally lands or is corrected.
 * `_applyChapterGapFill`'s own changed-only emit guard keeps a no-op
 * duration tick silent.
 */
function _wireChapterGapFillOnDuration(self: Internals): void {
	const onDuration = (): void => {
		const current = self._queueList.current() as ItemWithTracks | undefined;
		if (!current || !Array.isArray(current.chapters) || current.chapters.length === 0)
			return;
		self._applyChapterGapFill(current.id, current.chapters, { alwaysEmit: false });
	};
	self.on('duration', onDuration);
	self._policyCleanup.push(() => {
		self.off('duration', onDuration);
	});
}

/**
 * Re-emit `time` as a throttled `progress` event so consumers can persist
 * watch position without subscribing to a per-frame stream. `time` fires every
 * animation frame; `progress` fires at most every `options.progressIntervalMs`
 * (default 5s, set to 0 to disable). The first `time` event after setup
 * always fires `progress` because `_lastProgressEmit` starts at 0.
 */
function _wireProgressEmit(self: Internals): void {
	const progressInterval = self.options.progressIntervalMs ?? 5_000;
	if (progressInterval <= 0)
		return;

	const onTime = ({ time }: { time: number }): void => {
		const now = Date.now();
		if (now - self._lastProgressEmit < progressInterval)
			return;
		self._lastProgressEmit = now;
		const duration = self.duration();
		const percentage = duration > 0 ? (time / duration) * 100 : 0;
		self.emit('progress', {
			time,
			duration,
			percentage,
		});
	};
	self.on('time', onTime);
	self._policyCleanup.push(() => {
		self.off('time', onTime);
	});
}

/**
 * Wire up next-item preloading and crossfade transitions.
 *
 * Two listeners get registered:
 *  - `current` — bumps `_preloadEpoch`, cancels in-flight work, resets the
 *                "already fired this cycle" flags so the next item starts fresh.
 *  - `time`    — on every tick, asks the preload + transition strategies whether
 *                their thresholds have been crossed; fires `_runPreload` /
 *                `_runTransition` exactly once per cursor cycle.
 *
 * Strategy resolution order: explicit `options.preloadStrategy` /
 * `transitionStrategy` win over per-library defaults. When no custom preload
 * strategy is supplied, `options.preloadLeadSeconds` (default 10) drives a
 * fresh `DefaultPreloadStrategy`.
 *
 * Crossfade only runs when `options.crossfadeEnabled` is true.
 */
function _wirePreloadAndTransition(self: Internals): void {
	if (self.options.preloadStrategy) {
		self._preloadStrategy = self.options.preloadStrategy;
	}
	if (self.options.transitionStrategy) {
		self._transitionStrategy = self.options.transitionStrategy;
	}

	const configuredLeadSeconds = self.options.preloadLeadSeconds ?? 10;
	if (!self.options.preloadStrategy) {
		self._preloadStrategy = new DefaultPreloadStrategy(configuredLeadSeconds);
	}

	const onCurrentChange = (): void => {
		self._preloadFired = false;
		self._transitionFired = false;
		self._preloadStrategy.cancel();
		self._transitionStrategy.cancel('cursor-changed');
		self._preloadEpoch += 1;

		if (self._transitionRafHandle !== undefined) {
			cancelAnimationFrame(self._transitionRafHandle);
			self._transitionRafHandle = undefined;
		}
	};
	self.on('item', onCurrentChange);
	self._policyCleanup.push(() => {
		self.off('item', onCurrentChange);
	});

	const onTimeOrchestration = ({ time }: { time: number }): void => {
		const duration = self._internalDuration;
		const nextItem = self._queueList.peekNext() ?? null;
		const context = {
			currentTime: time,
			duration,
			nextItem,
		};

		if (!self._preloadFired && self._preloadStrategy.shouldPreload(context) && nextItem !== null) {
			self._preloadFired = true;
			void _runPreload(self, nextItem, self._preloadStrategy);
		}

		const crossfadeEnabled = self.options.crossfadeEnabled ?? false;
		if (crossfadeEnabled && !self._transitionFired && self._transitionStrategy.shouldTransition(context) && nextItem !== null) {
			self._transitionFired = true;
			const outgoing = self._queueList.current() ?? null;
			if (outgoing !== null) {
				_runTransition(self, outgoing, nextItem);
			}
		}
	};
	self.on('time', onTimeOrchestration);
	self._policyCleanup.push(() => {
		self.off('time', onTimeOrchestration);
	});
}

/**
 * Stash the player on `window.player` when `options.expose: true`. Useful
 * for browser-console debugging. Cleanup checks identity before deleting so a
 * second player instance won't clobber the wrong handle.
 */
function _wireWindowExpose(self: Internals): void {
	if (self.options.expose !== true || typeof window === 'undefined')
		return;

	Object.assign(window, { player: self });
	self._policyCleanup.push(() => {
		if (Object.is(Reflect.get(window, 'player'), self)) {
			Reflect.deleteProperty(window, 'player');
		}
	});
}

// ──────────────────────────────────────────────────────────────────────────
// Setup pipeline + transition helpers — async work fired by setup()
// ──────────────────────────────────────────────────────────────────────────

/** Lazily build the stream registry. Each call returns the same instance. */
function _ensureStreamRegistry(self: Internals): StreamRegistry {
	if (!self._streamRegistry) {
		self._streamRegistry = new StreamRegistry();
	}
	return self._streamRegistry;
}

/**
 * Drive the async setup pipeline, fire-and-forget. Each stage runs in order;
 * any failure short-circuits the rest and rejects the `ready()` promise.
 *
 * Plugin queue is drained during `pluginsRegistering`, with each plugin's
 * `use()` bounded by `options.pluginInitTimeoutMs` (default 30s). A plugin
 * that adds another plugin during its own `use()` is processed in the same
 * pass — the `shift()` loop catches new entries.
 *
 * Pipeline event order:
 *   setupStart → configResolved → pluginsRegistering → pluginsRegistered →
 *   streamsReady → authReady → playlistResolving? → playlistReady →
 *   mediaReady → ready
 *
 * The promise this fires is captured by `ready()` via `_readyResolve` /
 * `_readyReject` wiring set up before this runs.
 */
function _runSetupPipeline(self: Internals): void {
	const pipeline = async (): Promise<void> => {
		try {
			await _runStage(self, 'setupStart', 'setupStartError', () => {}, { container: self.container });
			await _runStage(self, 'configResolved', 'configResolvedError', () => {}, { config: self.options });
			await _runStage(self, 'pluginsRegistering', 'pluginsRegisteringError', async () => {
				const timeoutMs = self.options.pluginInitTimeoutMs ?? 30_000;
				while (self._pluginQueue.length > 0) {
					const entry = self._pluginQueue.shift()!;
					await self._registerPlugin(entry.ctor, entry.opts, timeoutMs);
				}
			});
			await _runStage(self, 'pluginsRegistered', 'pluginsRegisteredError', () => {});

			// Load the initial language through the full language() pipeline —
			// the translator only invokes `loadTranslations` on a language
			// SWITCH, so without this the configured loader (and every
			// plugin's lazy bundle) never fires for the startup language.
			// Resolution: config.language → browser language → 'en'.
			//
			// Skipped when a consumer already called `language(lang)` themselves
			// before this stage ran (`_languageExplicitlyRequested`, set
			// synchronously by the i18n mixin). Without this guard, a consumer
			// switching language before `ready()` races this internal step —
			// both mutate the same translator's active language, and this step,
			// reached several pipeline stages later, can win and silently
			// clobber the consumer's own switch.
			if (!self._languageExplicitlyRequested) {
				try {
					const initialLanguage = self.options.language
						?? (typeof navigator !== 'undefined' ? navigator.language : undefined)
						?? 'en';
					await self.language(initialLanguage);
				}
				catch {
					// Bundle load failure must not block setup — t() falls back
					// to the key / fallback-language chain.
				}
			}

			await _runStage(self, 'streamsReady', 'streamsReadyError', () => {
				// Native registered first so HLS (registered after) wins resolution
				// when a URL matches both — the registry walks newest-first.
				const reg = _ensureStreamRegistry(self);
				reg.register(nativeFactory);
				reg.register(hlsFactory);
			});
			await _runStage(self, 'authReady', 'authReadyError', () => {});

			// Playlist fires `playlistReady` with `length: 0` even when no
			// playlist is configured, so consumers can rely on the event.
			const playlist = self.options.playlist;
			if (typeof playlist === 'string') {
				await _resolvePlaylistUrl(self, playlist);
				applyPendingSelection(self);
			}
			else if (Array.isArray(playlist)) {
				// Only seed the queue from the config array when the consumer
				// has not already populated it (e.g. by calling queue() between
				// setup() and ready()). If the consumer pre-seeded the queue
				// with resolved URLs, clobbering their work here would replace
				// those with the raw config items — which may lack a resolved
				// `url` field — causing load() to throw 'missing-url'.
				const alreadySeeded = (self.queue() as ReadonlyArray<BasePlaylistItem>).length > 0;
				if (!alreadySeeded) {
					self.queue(playlist);
				}
				applyPendingSelection(self);
				self.emit('playlistReady', { length: playlist.length });
			}
			else {
				self.emit('playlistReady', { length: 0 });
			}

			await _runStage(self, 'mediaReady', 'mediaReadyError', () => {});

			self._transitionPhase('ready');
			self.emit('ready');
			self._readyResolve?.();
		}
		catch (err) {
			self._readyReject?.(err);
		}
	};

	void pipeline();
}

/**
 * Pre-fetch the next item's assets via HEAD requests so the browser cache
 * is warm by the time playback advances. The strategy decides what to fetch
 * (poster, manifest, first media segments, etc.).
 *
 * Race-guarded by `_preloadEpoch`: the orchestrator bumps the epoch on
 * `current` events, and every per-asset fetch checks that its captured epoch
 * still matches before emitting progress / complete. A stale fetch silently
 * exits — its result would describe yesterday's item.
 *
 * Emits `preloadStart`, then one `preloadProgress` per asset, then either
 * `preloadComplete` (all finished) or `preloadError` (any fetch threw).
 */
async function _runPreload(player: Internals, nextItem: BasePlaylistItem, strategy: IPreloadStrategy): Promise<void> {
	const capturedEpoch = player._preloadEpoch;
	const assets = strategy.assetsToPreload(nextItem);

	player.emit('preloadStart', {
		item: nextItem,
		assets: assets.map(asset => ({
			url: asset.url,
			category: asset.category,
		})),
	});

	let loaded = 0;
	const total = assets.length;

	if (total === 0) {
		player.emit('preloadComplete', { item: nextItem });
		return;
	}

	const fetchAsset = async (asset: PreloadAsset): Promise<void> => {
		if (player._preloadEpoch !== capturedEpoch)
			return;

		try {
			const request = new Request(asset.url, {
				method: 'HEAD',
				mode: 'no-cors',
			});
			await fetch(request).catch(() => {});

			loaded += 1;

			if (player._preloadEpoch !== capturedEpoch)
				return;

			player.emit('preloadProgress', {
				item: nextItem,
				loaded,
				total,
			});

			if (loaded === total) {
				player.emit('preloadComplete', { item: nextItem });
			}
		}
		catch (error: unknown) {
			if (player._preloadEpoch !== capturedEpoch)
				return;
			player.emit('preloadError', {
				item: nextItem,
				error,
			});
		}
	};

	await Promise.all(assets.map(fetchAsset));
}

/**
 * Drive a crossfade transition from `outgoing` to `incoming` using
 * `requestAnimationFrame`. The strategy.tick() runs on every frame with a
 * `fraction` from 0 to 1 covering the crossfade window
 * (`crossfadeLeadSeconds + crossfadeTailSeconds`, both default 3).
 *
 * Same epoch race-guard as `_runPreload`: a cursor change mid-fade bumps
 * `_preloadEpoch` and the RAF callback exits silently. Dispose checks too,
 * so a teardown during a fade doesn't tick forever.
 *
 * Emits `transitionStart`, then `transitionProgress` per frame, then
 * `transitionComplete` when fraction hits 1.
 */
function _runTransition(player: Internals, outgoing: BasePlaylistItem, incoming: BasePlaylistItem): void {
	const backend = _resolveTransitionBackend(player);

	player._transitionStrategy.start(outgoing, incoming, backend);
	player.emit('transitionStart', {
		outgoing,
		incoming,
	});

	const capturedEpoch = player._preloadEpoch;
	const crossfadeLeadSeconds = player.options.crossfadeLeadSeconds ?? 3;
	const crossfadeTailSeconds = player.options.crossfadeTailSeconds ?? 3;
	const totalWindowSeconds = crossfadeLeadSeconds + crossfadeTailSeconds;

	const tick = (): void => {
		if (player._preloadEpoch !== capturedEpoch)
			return;
		if (player._phase === 'disposed' || player._phase === 'disposing')
			return;

		const currentTime = player._internalCurrentTime;
		const duration = player._internalDuration;
		const elapsed = currentTime - (duration - crossfadeLeadSeconds);
		const fraction = totalWindowSeconds > 0 ? Math.max(0, Math.min(1, elapsed / totalWindowSeconds)) : 1;

		const context = {
			currentTime,
			duration,
			outgoingItem: outgoing,
			incomingItem: incoming,
			fraction,
		};

		player._transitionStrategy.tick(context, backend);
		player.emit('transitionProgress', {
			outgoing,
			incoming,
			fraction,
		});

		if (fraction >= 1) {
			player._transitionStrategy.complete(outgoing, incoming);
			player.emit('transitionComplete', {
				from: outgoing,
				to: incoming,
			});
			player._transitionRafHandle = undefined;
			return;
		}

		player._transitionRafHandle = requestAnimationFrame(tick);
	};

	player._transitionRafHandle = requestAnimationFrame(tick);
}

/**
 * Probe the active backend for crossfade capability. Returns the backend
 * narrowed to `ITransitionBackend` when it implements `supportsCrossfade`,
 * or `null` for backends without crossfade hooks (most video backends —
 * audio backends are where this matters).
 */
function _resolveTransitionBackend(player: Internals): ITransitionBackend | null {
	const backend = player.backend?.();
	if (!backend)
		return null;
	const candidate = backend as Partial<ITransitionBackend>;
	if (typeof candidate.supportsCrossfade === 'function') {
		return candidate as ITransitionBackend;
	}
	return null;
}

/**
 * The channel a failed setup stage reports on.
 *
 * The tier comes from the error rather than from the call site. A stage that
 * throws a `fatal` PlayerError reached a state the player cannot continue from,
 * and sending that to the `error` channel puts it in front of listeners handling
 * recoverable trouble while the `fatal` listener, which is the one that tears the
 * interface down, never hears about it.
 */
export function stageErrorTier(error: { severity?: string }): 'error' | 'fatal' {
	return error.severity === 'fatal' ? 'fatal' : 'error';
}

/**
 * Run a setup stage. Emits the success event on completion; on failure emits
 * the matching `<stage>Error` event AND `error`, always `error` and never
 * `fatal`, then re-throws so the pipeline driver can bail.
 */
async function _runStage(
	self: Internals,
	stage: string,
	errorEvent: string,
	work: () => void | Promise<void>,
	successPayload?: unknown,
): Promise<void> {
	try {
		await work();
		if (successPayload !== undefined) {
			self.emit(stage, successPayload);
		}
		else {
			self.emit(stage);
		}
	}
	catch (err) {
		const raw = err instanceof Error ? err : new Error(String(err));
		// Wrap non-PlayerError throws (e.g. plain Error from a stage callback)
		// so listeners always receive a PlayerErrorEvent.error of the right
		// shape (code, severity, scope, etc.).
		const error = raw instanceof StateError
			? raw
			: new StateError({
					code: `core:lifecycle/${stage}-failed`,
					severity: 'error',
					scope: { kind: 'core' },
					message: raw.message,
					cause: raw,
				});
		// The tier comes from the error rather than from this call site. A stage
		// that throws a `fatal` PlayerError reached a state the player cannot
		// continue from, and sending that to the `error` channel puts it in front
		// of listeners handling recoverable trouble while the `fatal` listener,
		// which is the one that tears the UI down, never hears about it.
		const tier = stageErrorTier(error);
		const payload = makePlayerErrorEvent(error, tier, { kind: 'core' });
		self.emit(errorEvent, payload);
		self.emit(tier, payload);
		throw err;
	}
}
