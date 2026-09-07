// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { AddClasses, CreateElement } from '../../adapters/element-factory';
import type { LifecycleRegistry } from '../../adapters/lifecycle-registry/default';
import type { ILogger } from '../../adapters/logger/ILogger';
import type { IRealtimeChannel, RealtimeFactoryOptions } from '../../adapters/realtime/IRealtimeChannel';
import type { IStorage } from '../../adapters/storage/IStorage';
import type {
	BaseEventMap,
	BasePlayerConfig,
	BasePlaylistItem,
	IPlayer,
	PluginAdvisory,
	RequireSpec,
	ResolvedUrl,
	Translations,
	UrlCategory,
} from '../../types';
import type { DispatchTarget } from '../dispatch';
import type { BeforeDispatchResult, DispatchBeforeOptions } from './dispatch';
import type { FetchOptions } from './fetch';
import type { PluginState } from './lifecycle';
import type { PluginRecoveryAction, ThrowPayload } from './throw';
import {
	addClasses,
	createButton,
	createElement,
	createSVG,
	removeClasses,
} from '../../adapters/element-factory';
import { Logger } from '../../adapters/logger/default';

import { nativeWebSocketAdapter } from '../../adapters/realtime/websocket';
import { LocalStorageBackend } from '../../adapters/storage/local-storage';
import { PlayerError } from '../../errors';
import { mergeConfig } from '../config-merge';
import { runDispatchBefore } from '../dispatch';
import { buildResolvedUrl } from '../resolved-url';
import { pluginFetch } from './fetch';
import { PluginThrow } from './throw';

/**
 * Extract the event-map generic from an `IPlayer<E>` or `EventEmitter<E>` type.
 * Plugins typed against a specific player (`Plugin<NMMusicPlayer, ...>`) get
 * autocomplete for the player's full event map (e.g. `MusicEventMap`, not just
 * `BaseEventMap`).
 *
 * Two-pass inference: first tries `IPlayer<infer E>` (works for simple player
 * types); falls back to `EventEmitter<infer E>` for players whose class
 * complexity blocks TypeScript's conditional-type inference through `IPlayer`.
 */
export type PlayerEventMap<P>
	= P extends { readonly __eventMap__: infer E }
		? (E extends BaseEventMap<BasePlaylistItem> ? E : BaseEventMap)
		: P extends IPlayer<infer E>
			? E
			: BaseEventMap;

/**
 * Resolve listener args from either form:
 *  - on('event', fn)       — string + fn
 *  - on(Class, 'event', fn) — class + string + fn (event is namespaced under `plugin:<Class.id>:`)
 */
function resolveListenerArgs(arg1: any, arg2: any, arg3?: any): { event: string; fn: (data: any) => void } {
	if (typeof arg1 === 'function') {
		// Class form
		const id = (arg1 as { id: string }).id;
		return {
			event: `plugin:${id}:${arg2}`,
			fn: arg3,
		};
	}
	// String form
	return {
		event: arg1,
		fn: arg2,
	};
}

/**
 * Wraps a shared storage backend with a fixed key prefix so each plugin's
 * keys never collide with another plugin's or with player-level keys.
 *
 * Keys stored by `DesktopUiPlugin` with id `'desktop-ui'` become
 * `nmplayer-desktop-ui-<key>` in the underlying backend.
 */
function _namespacedStorage(backend: IStorage, prefix: string): IStorage {
	return {
		get: (key: string) => backend.get(prefix + key),
		set: (key: string, value: string) => backend.set(prefix + key, value),
		remove: (key: string) => backend.remove(prefix + key),
		getJSON: <T>(key: string) => backend.getJSON<T>(prefix + key),
		setJSON: <T>(key: string, value: T) => backend.setJSON<T>(prefix + key, value),
	};
}

/**
 * Constructor signature matching any Plugin subclass. `never[]` is the
 * variance-correct "accepts every constructor" form (every concrete arg type
 * extends `never`). `Record<string, any>` for the `E` position matches concrete
 * event-map interfaces (e.g. `FooEvents`) which lack an index signature and
 * therefore don't satisfy the stricter `Record<string, unknown>`.
 */
export type AnyPluginCtor = abstract new (...args: never[]) => Plugin<IPlayer<BaseEventMap>, unknown, Record<string, any>>;

/**
 * Extract the event-map generic from a Plugin class type. Used by `on(Class, ...)`
 * to type the listener payload from the target plugin's `E` generic.
 *
 * Uses the instance-accessor pattern (same as `PlayerEventMap` / `__eventMap__`):
 * `InstanceType<C>` resolves the concrete subclass instance, then `['__events__']`
 * reads its phantom-typed property — TS evaluates this against the concrete `E`
 * the subclass supplies, bypassing the conditional-`infer` widening problem.
 */
export type PluginEventMap<C extends AnyPluginCtor> = InstanceType<C>['__events__'];

/**
 * Base plugin class. Subclass to write a plugin.
 *
 * Required statics: `id`, `description`. Recommended: `version`. Optional:
 * `minCoreVersion`, `requires`, `replaces`, `onError`, `advisories`.
 *
 * Override `use()` to wire up (sync or async — the player awaits it). Override
 * `dispose()` only if you need to release something the lifecycle helpers
 * don't already track. Override `getRuntimeState()` to populate `state().runtime`.
 *
 * Inside `use()` use the protected helpers — never go around them:
 *
 *  - `on / once / off / hasListeners` — two forms:
 *    `on('event', fn)` for player events, `on(PluginClass, 'event', fn)` for
 *    another plugin's events. Both auto-dispose on teardown.
 *  - `emit(event, data)` — fire-and-forget, scoped under `plugin:<id>:`
 *  - `dispatchBefore(name, data, opts?)` — cancellable / mutable / async-aware
 *  - `throw({...})` / `report({...})` — surface error vs warning
 *  - `fetch(url, options?)` — auth-aware fetch with retry; `options.parser` transforms the response body
 *  - `websocket(url, opts?)` — realtime channel closed on dispose
 *  - `mount(name)` — claim a `<div>` on the player container
 *  - `t(key, vars?)` — translate plugin-namespaced i18n keys
 *  - `listen / timeout / interval / abortable / frame` — auto-cleaned
 *  - `logger`, `storage` — scoped instances
 *
 * Never call `this.player.on/emit` directly (bypasses scoping + auto-dispose),
 * never use raw `setTimeout / addEventListener` (no auto-cleanup), never throw
 * raw `Error` (use `this.throw`). The lint pack enforces all of these.
 */
export class Plugin<
	P extends IPlayer<BaseEventMap> & DispatchTarget = IPlayer & DispatchTarget,
	O = unknown,
	E extends Record<string, any> = Record<string, never>,
> {
	/** Plugin id. Vendored unless inside our packages (`'fillz:viz'`). Lint-enforced. */
	static readonly id: string = 'plugin';

	/** Semver string. Recommended; defaults to `'0.0.0'` if unspecified. */
	static readonly version: string = '0.0.0';

	/** Optional minimum core/kit version required (semver). Checked at registration. */
	static readonly minCoreVersion?: string;

	/** One-line human-readable. Shown in plugin listings, used in error messages. */
	static readonly description: string = '';

	/**
	 * Module URL of the plugin file. Retained for identity and diagnostic use.
	 * Set with `static override readonly moduleUrl = import.meta.url` when
	 * needed; bundlers rewrite `import.meta.url` to the final asset URL.
	 *
	 * Note: passing this to `appendStyles` does NOT trigger Vite asset emission
	 * for sibling CSS files. Use `new URL('./styles.css', import.meta.url).href`
	 * literally at the `appendStyles` call site instead.
	 */
	static readonly moduleUrl?: string;

	/**
	 * Plugin dependencies — class refs only. Type-safe, refactor-safe, and
	 * uniform with the typed `on(PluginClass, ...)` event API.
	 *
	 * ```ts
	 * static readonly requires = [AudioGraphPlugin, CanvasPlugin];
	 * ```
	 *
	 * Object form for optional or version-pinned deps:
	 *
	 * ```ts
	 * static readonly requires = [
	 *   AudioGraphPlugin,
	 *   { plugin: MediaSessionPlugin, optional: true },
	 *   { plugin: SpectrumPlugin, minVersion: '2.1.0' },
	 * ];
	 * ```
	 *
	 * Required-missing throws `core:plugin/missing-dep` at registration.
	 * Optional-missing logs debug warning; plugin runs anyway.
	 * Version mismatch throws `core:plugin/version-mismatch`.
	 */
	static readonly requires?: ReadonlyArray<RequireSpec>;

	/**
	 * Opt-in same-id replacement. Without this, registering a plugin whose id
	 * matches an already-registered plugin throws `core:plugin/duplicate-id`.
	 */
	static readonly replaces?: string;

	/**
	 * Plugin ordering priority. Default `0`. Higher values sort BEFORE lower
	 * values; ties resolve in registration order.
	 *
	 * Consumed only by `enabledPlugins()`, which exposes plugins in priority
	 * order so consumers iterating the list (e.g. for capability negotiation)
	 * see deterministic results. It does not reorder event handlers: the
	 * emitter always fires listeners in insertion order.
	 */
	static readonly priority: number = 0;


	/**
	 * Per-error recovery action map. Missing entries fall back to the kit's
	 * default retry policy (see `DEFAULT_RETRY_POLICY` in `errors.ts`).
	 */
	static readonly onError?: Readonly<Record<string, PluginRecoveryAction>>;

	/**
	 * Declarative phase-aware advisories. Each entry is "this method during
	 * this phase is risky" — at registration the player merges every plugin's
	 * advisories into a phase-keyed lookup. When the matching mutation fires
	 * `beforeMutation`, the player auto-emits the advisory as `info`/`warning`/`error`
	 * with code `plugin:<this.id>/<reason>`.
	 *
	 * Pure data — no handler code needed. For more complex contracts (mutating
	 * args, calling preventDefault), subscribe to `beforeMutation` directly.
	 */
	static readonly advisories?: ReadonlyArray<PluginAdvisory>;

	/**
	 * Static translation bundles shipped with the plugin. Auto-merged into the
	 * player's translation table on `use()` and auto-removed on `dispose()`.
	 * Keys must be namespaced under `plugin.<this.id>.*` to avoid collisions.
	 *
	 * ```ts
	 * static readonly translations: Translations = {
	 *   en: { 'plugin.lyrics.empty': 'No lyrics available' },
	 *   nl: { 'plugin.lyrics.empty': 'Geen songtekst beschikbaar' },
	 * };
	 * ```
	 *
	 * For async / on-demand loading, override the instance method
	 * `loadTranslations(lang)` — it runs after `use()` resolves and on every
	 * `setLanguage(lang)` call.
	 */
	static readonly translations?: Translations;

	declare player: P;
	declare opts: O;
	/** Phantom — type-only carrier for plugin event inference via `PluginEventMap<C>`. */
	declare readonly __events__: E;
	protected lifecycle!: LifecycleRegistry;

	/**
	 * Instance-level accessor for the plugin's id. Returns the same value as
	 * `(this.constructor as typeof Plugin).id`. Exposed on the instance so
	 * consumers that hold a `Plugin` reference (e.g. `player.plugins()`) can read
	 * `plugin.id` without reaching into `plugin.constructor`.
	 */
	get id(): string {
		return (this.constructor as typeof Plugin).id;
	}

	/** Auto-provided scoped logger. Output is prefixed `[nmplayer][<id>]`. */
	protected logger!: ILogger;

	/** Auto-provided scoped storage. Keys are auto-prefixed `nmplayer-<id>-`. */
	protected storage!: IStorage;

	private _enabled: boolean = true;
	private _mountCache?: Map<string, HTMLDivElement>;

	/**
	 * Called by the player immediately after instantiating the plugin class.
	 * Wires the player reference, merged options, and lifecycle registry into the
	 * instance. Sets up the scoped logger and storage before `use()` runs.
	 *
	 * Plugin authors never call this method directly — the player calls it during
	 * `registerPlugin()` / `use()`. Override `use()` for setup logic.
	 */
	initialize(player: P, opts: O, lifecycle: LifecycleRegistry): void {
		this.player = player;
		this.opts = opts;
		this.lifecycle = lifecycle;

		const config = (player as IPlayer & { options?: BasePlayerConfig }).options ?? {};

		const rootLogger: ILogger = config.logger ?? new Logger({
			prefix: 'nmplayer',
			level: config.logLevel,
		});
		this.logger = rootLogger.child(this.id);

		const rootStorage: IStorage = config.storage ?? new LocalStorageBackend();
		this.storage = _namespacedStorage(rootStorage, `nmplayer-${this.id}-`);
	}

	/**
	 * Wire up listeners / DOM / fetches. May return `Promise<void>` for async
	 * setup — player awaits all `use()` promises (capped by `pluginInitTimeoutMs`)
	 * before emitting `ready`.
	 */
	use(): void | Promise<void> {}

	/**
	 * Tear down any resources the plugin allocated that the lifecycle registry
	 * cannot track automatically — e.g. third-party library instances, custom
	 * WebGL contexts, non-standard observers.
	 *
	 * The kit calls `dispose()` when the player itself is disposed, or when the
	 * plugin is explicitly removed via `player.removePlugin(PluginClass)`. Standard
	 * listeners, timers, RAF loops, and abort controllers registered through the
	 * lifecycle helpers are released after `dispose()` returns, so they are all
	 * still live inside it and there is nothing to re-clean here. Reach for this
	 * only for something the helpers never saw.
	 */
	dispose(): void {}

	// ── Plugin Standard required surface ──

	/** Return current enabled state. Default `true` after `use()` resolves. */
	enabled(): boolean {
		return this._enabled;
	}

	/**
	 * Activate plugin behaviour. Idempotent. Listeners stay subscribed in either
	 * state — handlers short-circuit on `enabled() === false`.
	 */
	enable(): void {
		if (this._enabled)
			return;
		this._enabled = true;
		const pluginId = this.id;
		this.player.emit('plugin:enabled', { id: pluginId });
		this.player.emit(`plugin:${pluginId}:enabled`, { id: pluginId });
	}

	/** Deactivate plugin behavior without unloading. Idempotent. */
	disable(reason?: string): void {
		if (!this._enabled)
			return;
		this._enabled = false;
		const pluginId = this.id;
		this.player.emit('plugin:disabled', {
			id: pluginId,
			reason,
		});
		this.player.emit(`plugin:${pluginId}:disabled`, {
			id: pluginId,
			reason,
		});
	}

	/** Snapshot for debug overlays / save+restore tooling. */
	state(): PluginState<O> {
		const ctor = this.constructor as typeof Plugin;
		return {
			id: ctor.id,
			version: ctor.version,
			enabled: this._enabled,
			opts: this.opts as Readonly<O>,
			runtime: this.getRuntimeState(),
		};
	}

	/** Override to populate `state().runtime` with plugin-defined fields. */
	protected getRuntimeState(): Record<string, unknown> {
		return {};
	}

	/**
	 * Read or write runtime options.
	 *
	 * `options()` — returns a frozen shallow copy of the current options.
	 * `options(partial)` — shallow-merges `partial` into the current options
	 * and emits `opts:changed` on the plugin and player channels.
	 *
	 * Subclasses override when they need to react to specific option changes
	 * (re-render, re-subscribe, etc.).
	 */
	options(): Readonly<O>;
	options(partial: Partial<O>): void;
	options(partial?: Partial<O>): Readonly<O> | void {
		if (partial === undefined) {
			return Object.freeze({ ...(this.opts as object) }) as Readonly<O>;
		}
		this.opts = mergeConfig(this.opts, partial);
		const pluginId = this.id;
		this.player.emit('plugin:opts:changed', {
			id: pluginId,
			opts: this.opts,
		});
		this.player.emit(`plugin:${pluginId}:opts:changed`, {
			id: pluginId,
			opts: this.opts,
		});
		this.emit('opts:changed', this.opts);
	}

	// ── Scoped event surface (typed-only, two overloads — string for player events, Class for plugin events) ──

	/**
	 * Listen to events with auto-dispose on plugin teardown. Two forms:
	 *
	 *  - `on(eventName, fn)` — listen to player / core events (`'play'`, `'time'`,
	 *    `'beforePlay'`, etc.). Type inferred from the player's event map.
	 *  - `on(PluginClass, eventName, fn)` — listen to another plugin's events.
	 *    Type inferred from the target plugin's `E` generic.
	 *
	 * No untyped string fallback. If you need to listen to a plugin's events,
	 * import the class — `static requires = ['<id>']` already guarantees
	 * that class is loaded before yours, so the import is free.
	 *
	 * Both forms register cleanup with the lifecycle registry; consumers never
	 * call `off()` manually unless they want to detach early.
	 */
	protected on<K extends keyof PlayerEventMap<P>>(event: K, fn: (data: PlayerEventMap<P>[K]) => void): void;
	protected on<C extends AnyPluginCtor, K extends keyof PluginEventMap<C> & string>(
		plugin: C,
		event: K,
		fn: (data: PluginEventMap<C>[K]) => void,
	): void;
	protected on(arg1: any, arg2: any, arg3?: any): void {
		const { event, fn } = resolveListenerArgs(arg1, arg2, arg3);
		this.player.on(event, fn);
		this.lifecycle.addCleanup(() => this.player.off(event, fn));
	}

	/**
	 * Listen for a single occurrence. Same two-form contract as `on(...)`.
	 * Auto-removes after first dispatch; auto-disposes on plugin teardown if
	 * not yet fired.
	 */
	protected once<K extends keyof PlayerEventMap<P>>(event: K, fn: (data: PlayerEventMap<P>[K]) => void): void;
	protected once<C extends AnyPluginCtor, K extends keyof PluginEventMap<C> & string>(
		plugin: C,
		event: K,
		fn: (data: PluginEventMap<C>[K]) => void,
	): void;
	protected once(arg1: any, arg2: any, arg3?: any): void {
		const { event, fn } = resolveListenerArgs(arg1, arg2, arg3);
		this.player.once(event, fn);
		this.lifecycle.addCleanup(() => this.player.off(event, fn));
	}

	/**
	 * Detach a listener early (before plugin dispose). Same two-form contract
	 * as `on(...)`. Most code never calls this — lifecycle handles it.
	 */
	protected off<K extends keyof PlayerEventMap<P>>(event: K, fn: (data: PlayerEventMap<P>[K]) => void): void;
	protected off<C extends AnyPluginCtor, K extends keyof PluginEventMap<C> & string>(
		plugin: C,
		event: K,
		fn: (data: PluginEventMap<C>[K]) => void,
	): void;
	protected off(arg1: any, arg2: any, arg3?: any): void {
		const { event, fn } = resolveListenerArgs(arg1, arg2, arg3);
		this.player.off(event, fn);
	}

	/**
	 * Check whether any listener is registered. Same two-form contract as `on(...)`.
	 */
	protected hasListeners<K extends keyof PlayerEventMap<P>>(event: K): boolean;
	protected hasListeners<C extends AnyPluginCtor, K extends keyof PluginEventMap<C> & string>(
		plugin: C,
		event: K,
	): boolean;
	protected hasListeners(arg1: any, arg2?: any): boolean {
		const event = typeof arg1 === 'function'
			? `plugin:${(arg1 as AnyPluginCtor & { id: string }).id}:${arg2}`
			: arg1;
		return this.player.hasListeners(event);
	}

	/**
	 * Emit a plugin-scoped event. Kit auto-namespaces with `plugin:<this.id>:`
	 * so listeners outside the plugin see e.g. `'plugin:lyrics:line'`.
	 *
	 * Fire-and-forget. Listeners that throw are caught + routed via standard
	 * error path; the emit returns synchronously.
	 *
	 * For cancellable / mutable / async-aware events with the same power as
	 * core's `before*` events, use `dispatchBefore(...)` instead.
	 */
	protected emit<K extends keyof E>(event: K, data?: E[K]): void;
	protected emit(event: string, data?: any): void;
	protected emit(event: any, data?: any): void {
		const namespaced = `plugin:${this.id}:${String(event)}`;
		this.player.emit(namespaced, data);
	}

	/**
	 * Cancellable, mutable, async-aware plugin-scoped event — same power as core's
	 * `before*` events. Returns a Promise that resolves with the dispatch outcome
	 * after all listeners run AND every `delay()` promise resolves.
	 *
	 * Auto-namespaced under `plugin:<this.id>:`. Listeners (other plugins, the
	 * consumer app) get a `BeforeEvent<TData>` payload — they can mutate
	 * `e.data`, call `preventDefault()`, `stopImmediatePropagation()`, or
	 * `delay(promise)` exactly like core's `beforePlay` etc.
	 *
	 * Plugin authors writing public mutating methods should wrap them in
	 * `dispatchBefore` so other plugins / consumers can intercept:
	 *
	 * ```ts
	 * class EqualizerPlugin extends Plugin {
	 *   static readonly id = 'equalizer';
	 *
	 *   async setBand(index: number, gain: number) {
	 *     const result = await this.dispatchBefore('beforeSetBand', { index, gain });
	 *     if (result.prevented) {
	 *       this.emit('setBandPrevented', { index, reason: result.reason });
	 *       return;
	 *     }
	 *     // run actual mutation with possibly-mutated data
	 *     this.applyBand(result.data.index, result.data.gain);
	 *     this.emit('bandChanged', { index: result.data.index, gain: result.data.gain });
	 *   }
	 * }
	 * ```
	 *
	 * Other plugins listen and orchestrate:
	 *
	 * ```ts
	 * class MyAdvisorPlugin extends Plugin {
	 *   static readonly requires = ['equalizer'];     // guarantees EqualizerPlugin is loaded
	 *
	 *   use() {
	 *     this.on(EqualizerPlugin, 'beforeSetBand', e => {
	 *       if (e.data.gain > 12) {
	 *         e.data.gain = 12;          // mutate — clamp to safe range
	 *       }
	 *       if (this.player.phase() === 'playing' && Math.abs(e.data.gain) > 6) {
	 *         e.delay(this.smoothlyApply(e.data));   // async-gate the apply
	 *       }
	 *     });
	 *   }
	 * }
	 * ```
	 *
	 * The dispatch is automatically pushed onto `player.dispatching()` so other
	 * plugins can advise on `duringEvent: 'plugin:equalizer:beforeSetBand'`.
	 */
	protected async dispatchBefore<TData>(event: string, data: TData, opts?: DispatchBeforeOptions): Promise<BeforeDispatchResult<TData>> {
		const namespaced = `plugin:${this.id}:${event}`;
		const config = (this.player as IPlayer & { options?: BasePlayerConfig }).options ?? {};
		const timeoutMs = opts?.timeoutMs ?? config.beforeEventTimeoutMs ?? 10_000;

		return runDispatchBefore<TData>(this.player, namespaced, data, { timeoutMs });
	}

	// ── Structured error escalation ──

	/**
	 * Surface an error AND abort the current flow. Use for `error` / `fatal`
	 * severities. Returns `never`.
	 */
	protected throw(payload: ThrowPayload): never {
		const error = this.buildError(payload);
		this.surfaceError(error);
		throw error;
	}

	/**
	 * Surface a `warning` / `info` event WITHOUT aborting flow. Returns void.
	 * Use when a plugin wants the consumer to know something glitched but
	 * playback should continue.
	 */
	protected report(payload: ThrowPayload): void {
		const error = this.buildError({
			...payload,
			severity: payload.severity ?? 'warning',
		});
		this.surfaceError(error);
	}

	private buildError(payload: ThrowPayload): PlayerError {
		return new PlayerError({
			code: payload.code,
			id: payload.id,
			severity: payload.severity ?? 'error',
			scope: {
				kind: 'plugin',
				id: this.id,
			},
			message: payload.message,
			cause: payload.cause,
			context: payload.context,
			suggestion: payload.suggestion,
		});
	}

	private surfaceError(error: PlayerError): void {
		const payload = {
			error,
			severity: error.severity,
			scope: error.scope,
			timestamp: Date.now(),
		};

		// Emit on the matching severity channel so generic error pipelines catch it.
		this.player.emit(error.severity, payload);

		// Also emit on the plugin-scoped channel for consumers wiring to plugin lifecycle.
		if (error.severity === 'warning' || error.severity === 'error') {
			this.player.emit(`plugin:${error.severity}`, payload);
		}

		const action: PluginRecoveryAction | undefined = (this.constructor as typeof Plugin).onError?.[error.code];
		if (action) {
			this._applyRecoveryAction(action, error);
		}
	}

	/**
	 * Execute a recovery action declared in `static onError`. Called immediately
	 * after `surfaceError` when the error code has a mapped entry.
	 *
	 *  - `'ignore'`     — no-op; the error is already surfaced above.
	 *  - `'disable'`    — calls `this.disable(reason)` so the plugin stops reacting.
	 *  - `'retry-once'` — calls `this.retryLastOperation()` when present, otherwise
	 *                     logs that no retry hook is wired.
	 *  - `'fallback'`   — calls `this.activateFallback()` when present, otherwise
	 *                     logs that no fallback hook is wired.
	 *
	 * Plugin authors override `retryLastOperation()` / `activateFallback()` to
	 * implement the actual recovery logic. The kit wires the `onError` map;
	 * plugins wire the bodies.
	 */
	private _applyRecoveryAction(action: PluginRecoveryAction, error: PlayerError): void {
		const pluginId = this.id;

		switch (action) {
			case 'ignore':
				break;

			case 'disable':
				this.disable(`onError:${error.code}`);
				break;

			case 'retry-once': {
				// Optional extension method; checked before calling — structural narrowing required because it's not on Plugin.
				const selfWithRetry = this as unknown as { retryLastOperation?: () => void };
				if (typeof selfWithRetry.retryLastOperation === 'function') {
					try {
						selfWithRetry.retryLastOperation();
					}
					catch (retryErr) { this.logger.warn(`[${pluginId}] retryLastOperation threw:`, retryErr); }
				}
				else {
					this.logger.warn(`[${pluginId}] onError 'retry-once' declared but retryLastOperation() not implemented`);
				}
				break;
			}

			case 'fallback': {
				// Optional extension method; checked before calling — structural narrowing required because it's not on Plugin.
				const selfWithFallback = this as unknown as { activateFallback?: () => void };
				if (typeof selfWithFallback.activateFallback === 'function') {
					try {
						selfWithFallback.activateFallback();
					}
					catch (fallbackErr) { this.logger.warn(`[${pluginId}] activateFallback threw:`, fallbackErr); }
				}
				else {
					this.logger.warn(`[${pluginId}] onError 'fallback' declared but activateFallback() not implemented`);
				}
				break;
			}
		}
	}

	// ── Auth-aware fetch ──

	/**
	 * HTTP fetch using the player's configured `AuthConfig`. Auto-aborts on
	 * `dispose()`.
	 *
	 * `responseType` controls decoding:
	 *  - `'text'` (default) — raw string; `parser` callback is applied when supplied.
	 *  - `'json'`           — `response.json()`, typed via generic `T`.
	 *  - `'arrayBuffer'`    — `response.arrayBuffer()`.
	 *
	 * Errors propagate as `AuthError` (401/403) or `NetworkError` (everything
	 * else); both extend `PlayerError` so the standard error-event surface
	 * still applies.
	 *
	 * Event scoping (`opts.scope`):
	 *  - `'plugin'` (default) — emits `plugin:<this.id>:fetch:start|retry|complete`.
	 *  - `'player'` — also emits player-global `fetch:*` for telemetry pipes.
	 *  - `'silent'` — emits nothing.
	 *
	 * Auth pipeline (single source of truth shared with the player core):
	 *  - `auth.transformUrl(url)` runs first
	 *  - `Authorization: Bearer <token>` set if `auth.bearerToken` resolves to one
	 *  - `auth.headers` merged in
	 *  - `auth.signRequest(request)` is the escape hatch for HMAC / sigv4 / etc.
	 *  - On 401: `auth.refreshOnUnauthenticated()` runs once, then retry
	 *  - On 403: propagates immediately, never refreshed, never retried
	 *  - On 5xx / timeout / network: retry per RetryConfig
	 */
	protected fetch<T = string>(url: string, options?: FetchOptions<T>): Promise<T> {
		return pluginFetch<T>({
			id: this.id,
			lifecycle: this.lifecycle,
			player: this.player,
		}, url, options);
	}

	// ── Auth-URL resolution ──

	/**
	 * Resolve a URL through the player's configured `urlResolver` (or the
	 * built-in `auth.transformUrl` + structured-parse default). Use whenever
	 * a URL is handed to a non-`fetch()` consumer — Worker, `<video>.src`,
	 * Cast receiver, MediaSource, CSS — i.e. anywhere custom Authorization
	 * headers cannot be attached and auth must travel via query string /
	 * signed URL.
	 *
	 * `category` is forwarded to the resolver so custom implementations can
	 * branch on the consumer ('media', 'subtitle', 'cast', 'license', ...).
	 *
	 * Returns a `ResolvedUrl` with parsed parts. Falls back to a minimal
	 * passthrough when running against an older kit version that lacks
	 * `player.resolveUrl`.
	 *
	 * `Plugin.fetch` already applies `transformUrl` internally; this helper
	 * is for the URLs you can't route through `fetch`.
	 */
	protected async resolveUrl(url: string, category?: UrlCategory): Promise<ResolvedUrl> {
		if (typeof this.player.resolveUrl === 'function') {
			try {
				return await this.player.resolveUrl(url, category);
			}
			catch {
				// Fall through to passthrough below.
			}
		}
		// Older kit / detached player — return a minimal `ResolvedUrl` so
		// callers can still read `.href` / `.toString()` without branching.
		return buildResolvedUrl(url, url);
	}

	// ── Realtime channel helper (WebSocket / SignalR / Socket.IO via factory) ──

	/**
	 * Realtime channel bound to the plugin's lifecycle. Closes on `dispose()`.
	 * Returns an `IRealtimeChannel` regardless of the underlying transport so
	 * plugins write against one interface. Reconnect options are forwarded to
	 * the factory verbatim; the built-in native adapter does not reconnect, so
	 * reconnection exists only when the resolved factory implements it.
	 *
	 * Factory resolution (highest priority first):
	 *  1. `opts.factory` — per-call override
	 *  2. `setup({ websocketFactory })` — consumer-supplied default
	 *  3. Built-in `nativeWebSocketAdapter` — wraps `WebSocket`
	 *
	 * Plugin authors needing a transport-specific override should subclass and
	 * override this method directly.
	 */
	protected websocket(url: string, opts?: RealtimeFactoryOptions): IRealtimeChannel {
		const config = (this.player as IPlayer & { options?: BasePlayerConfig }).options ?? {};
		const factory = opts?.factory ?? config.websocketFactory ?? nativeWebSocketAdapter;
		const channel = factory(url, opts);
		// Auto-close on lifecycle dispose so plugin authors don't have to track
		// the channel reference manually.
		this.lifecycle.addCleanup(() => {
			try {
				if (channel.readyState !== 'closed' && channel.readyState !== 'closing') {
					channel.close();
				}
			}
			catch (err) {
				void err;
			}
		});
		return channel;
	}

	// ── DOM construction + mount points ──

	/**
	 * Create a DOM element of `type`, assign it `id`, and return a fluent
	 * builder that can add classes, append/prepend to a parent, and retrieve
	 * the element via `.get()`. When `unique` is true, an existing element with
	 * the same id is returned instead of creating a duplicate.
	 *
	 * ```ts
	 * const headerEl = this.createElement('fieldset', 'extra-controls')
	 *   .addClasses(['noMercyConnectPlugin'])
	 *   .setAttribute('data-tooltip', 'NoMercy Connect: Syncs video progress with the server for watch tracking.')
	 *   .get();
	 * ```
	 */
	protected createElement<K extends keyof HTMLElementTagNameMap>(
		type: K,
		id: string,
		unique?: boolean,
	): CreateElement<HTMLElementTagNameMap[K]> {
		return createElement(type, id, unique);
	}

	/**
	 * Create an accessible `<button>` element pre-wired with `type="button"`,
	 * an `aria-label`, a `title`, and a click handler. Ready to insert — no
	 * additional attribute setup needed.
	 */
	protected createButton(id: string, label: string, onClick: (event: Event) => void): HTMLButtonElement {
		return createButton(id, label, onClick);
	}

	/**
	 * Create an `<svg>` element in the SVG namespace, setting `id`, `viewBox`,
	 * and `xmlns`. Caller appends path/use children after `.get()`.
	 */
	protected createSVG(id: string, viewBox: string): SVGSVGElement {
		return createSVG(id, viewBox);
	}

	/**
	 * Add CSS class names to `el` (skips empty strings) and return a fluent
	 * builder for further chaining. Safe to call with an empty array.
	 */
	protected addClasses<T extends Element>(el: T, names: string[]): AddClasses<T> {
		return addClasses(el, names);
	}

	/**
	 * Remove CSS class names from `el` (skips empty strings) and return the
	 * element itself. No fluent builder — removal is terminal.
	 */
	protected removeClasses<T extends Element>(el: T, names: string[]): T {
		return removeClasses(el, names);
	}

	/**
	 * Append a stylesheet to `document.head` exactly once per `id`. Re-entrant:
	 * a second call with the same `id` is a no-op.
	 *
	 * Pass a pre-resolved URL so Vite's static analyser emits and hashes the
	 * CSS file. The literal `new URL('./styles.css', import.meta.url)` expression
	 * must appear in the plugin source file — the analyser does not follow
	 * runtime variables.
	 *
	 * ```ts
	 * export class MyPlugin extends Plugin {
	 *   static override readonly id = 'myplugin';
	 *
	 *   override use(): void {
	 *     this.appendStyles(new URL('./styles.css', import.meta.url).href, 'plugin-myplugin-styles');
	 *   }
	 * }
	 * ```
	 */
	protected appendStyles(href: string, styleId: string): void {
		if (typeof document === 'undefined')
			return;
		if (document.getElementById(styleId))
			return;
		const baseUrl = (this.constructor as typeof Plugin).moduleUrl;
		const url = baseUrl ? new URL(href, baseUrl) : new URL(href, document.baseURI);
		const link = document.createElement('link');
		link.id = styleId;
		link.rel = 'stylesheet';
		link.href = url.href;
		document.head.appendChild(link);
	}

	/**
	 * Inject CSS text into `document.head` as a `<style>` element, exactly once
	 * per `id`. Same dedupe contract as `appendStyles`, but synchronous — the
	 * rules apply before the next paint instead of after a network round-trip,
	 * so plugin UIs never render an unstyled frame.
	 *
	 * Published dist builds are rewritten to this form by
	 * `scripts/inline-css-assets.mjs`: the `appendStyles(new URL(...))` call in
	 * source becomes `appendInlineStyles('<embedded css>', id)` in dist. Source
	 * builds (dev server, testbed, vitest) keep the URL form, which Vite serves
	 * directly.
	 */
	protected appendInlineStyles(cssText: string, styleId: string): void {
		if (typeof document === 'undefined')
			return;
		if (document.getElementById(styleId))
			return;
		const style = document.createElement('style');
		style.id = styleId;
		style.textContent = cssText;
		document.head.appendChild(style);
	}

	/**
	 * Claim a `<div>` mount point on the player container. Idempotent per
	 * plugin instance — same `name` returns the same node. Auto-removed on
	 * `dispose()`.
	 *
	 * Mount nodes are namespaced per plugin: a plugin with `id = 'message'`
	 * claiming `'toast'` gets a node with class `nmplayer-message-toast`.
	 * Conflict-free across plugins.
	 *
	 * Plugins needing non-`<div>` elements should construct their own DOM and
	 * append it under the player container directly.
	 */
	protected mount(name: string): HTMLDivElement {
		const className = `nmplayer-${this.id}-${name}`;

		if (!this._mountCache)
			this._mountCache = new Map<string, HTMLDivElement>();
		const cache = this._mountCache;
		const cached = cache.get(name);
		if (cached)
			return cached;

		const container = this.player.container;
		const div = document.createElement('div');
		div.className = className;
		container.appendChild(div);
		cache.set(name, div);

		this.lifecycle.addCleanup(() => {
			div.remove();
			cache.delete(name);
		});

		return div;
	}

	// ── i18n ──

	/**
	 * Translate a plugin-scoped key. Auto-namespaces under the plugin's id —
	 * `this.t('line.empty')` looks up `plugin.<id>.line.empty` in the player's
	 * translations table. Missing keys fall through to
	 * `setup({ onMissingTranslation })`, defaulting to the key itself.
	 */
	protected t(key: string, vars?: Record<string, string>): string {
		const namespaced = `plugin.${this.id}.${key}`;
		const player = this.player as IPlayer & { t?: (key: string, vars?: Record<string, string>) => string };
		if (typeof player.t === 'function')
			return player.t(namespaced, vars);
		return namespaced;
	}

	/**
	 * Async loader for this plugin's translations. Override when bundles live
	 * outside the source tree — fetched from an API, dynamic-imported, etc.
	 *
	 * Called by the player after `use()` resolves and on every `setLanguage`
	 * change for which the plugin hasn't already loaded a bundle. Resolved
	 * key→value map is merged under `plugin.<this.id>.*`. Teardown removes the
	 * `plugin.<id>.*` namespace only when the class also declares a static
	 * `translations` field; keys merged by this hook alone survive `dispose()`.
	 *
	 * Default: no-op (returns `undefined`). The static `translations` field
	 * still applies; this hook is purely additive for runtime sources.
	 *
	 * ```ts
	 * async loadTranslations(lang: string) {
	 *   try {
	 *     return await this.fetch<Record<string, string>>(`/i18n/lyrics/${lang}.json`, { responseType: 'json', scope: 'silent' });
	 *   }
	 *   catch {
	 *     return undefined;
	 *   }
	 * }
	 * ```
	 */
	protected loadTranslations?(_lang: string): Promise<Record<string, string> | undefined>;

	// ── Lifecycle helpers (all auto-cleaned on dispose) ──

	/**
	 * Register a DOM event listener that is automatically removed on plugin
	 * dispose. Prefer this over `target.addEventListener` directly so the
	 * lifecycle registry tracks the cleanup.
	 */
	protected listen(target: EventTarget, event: string, handler: EventListener, options?: AddEventListenerOptions): void {
		this.lifecycle.listen(target, event, handler, options);
	}

	/**
	 * Schedule a one-shot callback. Cancelled automatically on `dispose()`.
	 * Returns the numeric handle in case early cancellation is needed, but most
	 * callers can discard the return value.
	 */
	protected timeout(fn: () => void, ms: number): number {
		return this.lifecycle.timeout(fn, ms);
	}

	/**
	 * Schedule a repeating callback. Cancelled automatically on `dispose()`.
	 * Returns the numeric handle in case early cancellation is needed.
	 */
	protected interval(fn: () => void, ms: number): number {
		return this.lifecycle.interval(fn, ms);
	}

	/**
	 * Auto-cancelled requestAnimationFrame loop. Pass a render callback;
	 * the kit handles the RAF loop, deltaMs accounting, and cancellation
	 * on `dispose()`. Visualization plugins use this exclusively.
	 *
	 * Returns a cancel disposer `() => void` that stops this specific loop
	 * without tearing down the whole plugin. The loop is also cancelled
	 * automatically on `dispose()` — the disposer is only needed for early
	 * cancellation of one loop while keeping others running.
	 */
	protected frame(fn: (deltaMs: number, time: number) => void): () => void {
		return this.lifecycle.frame(fn);
	}

	/**
	 * Create an `AbortController` that is automatically aborted on plugin
	 * dispose. Pass `controller.signal` to `fetch()` calls or any Web API that
	 * accepts a signal. The `fetch()` helper does this automatically; use
	 * `abortable()` directly only when integrating third-party APIs.
	 */
	protected abortable(): AbortController {
		return this.lifecycle.abortable();
	}

	// ── Sharing / persistence (deferred) ──

	/**
	 * Class-level: produce a derived plugin class with options pre-baked.
	 * Same `static id` unless `newId` is provided. Consumer-supplied opts at
	 * registration time win over the baked-in defaults (shallow merge).
	 */
	static derive<C extends typeof Plugin<any, any, any>>(
		this: C,
		opts: Partial<InstanceType<C>['opts']>,
		newId?: string,
	): C {
		// `this` is the Plugin subclass constructor; TS can't extend a generic class-typed `this` directly — opaque cast to concrete base type required.
		class Derived extends (this as unknown as new () => Plugin) {
			override initialize(player: any, consumerOpts: any, lifecycle: any): void {
				const merged = {
					...(opts as object),
					...((consumerOpts ?? {}) as object),
				};
				super.initialize(player, merged, lifecycle);
			}
		}
		if (newId !== undefined) {
			Object.defineProperty(Derived, 'id', {
				value: newId,
				writable: false,
				configurable: false,
			});
		}
		return Derived as unknown as C; // Derived extends the ctor generically; C is the return constraint imposed by the caller.
	}

	/**
	 * Produce a derived plugin class with this instance's CURRENT state baked in
	 * as the default opts. Uses `export()` to capture the snapshot, so subclasses
	 * that override `export` automatically benefit from richer state in the clone.
	 */
	clone(): typeof Plugin {
		const exported = this.export();
		const Ctor = this.constructor as typeof Plugin;
		// `derive` is defined on the Plugin class but TS doesn't see it on `typeof Plugin` after constructor-typing — accessed via structural cast.
		return (Ctor as unknown as { derive: (opts: unknown) => typeof Plugin }).derive(exported);
	}

	/**
	 * Serializable JSON snapshot of the plugin's current state. Default returns
	 * a deep-cloned `opts` snapshot — most plugins don't need to override.
	 * Subclasses with non-opts runtime state should override and return a
	 * superset that round-trips through `derive()`.
	 */
	export(): O {
		return JSON.parse(JSON.stringify(this.opts ?? {})) as O;
	}
}

export { PluginThrow };
