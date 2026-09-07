// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { PlayerPhase } from '../../types';
import type { BeforeDispatchOutcome } from '../dispatch';
import type { Internals } from '../state';
import { stateError } from '../../errors';
import {
	AudioTrackState,
	BufferState,
	NetworkState,
	QualityState,
	VisibilityState,
} from '../../types';

import { runDispatchBefore } from '../dispatch';

/**
 * The player-state mixin's slice of player state — composed into
 * `PlayerCoreState`. Declared here, beside `_transitionPhase()` which is the
 * sole writer of `_phase`.
 */
export interface PlayerPhaseState {
	/**
	 * Current lifecycle phase. Written only by `_transitionPhase()` inside
	 * `playerStateMethods`. Consumers read via `player.phase()`. Drives
	 * guard checks (e.g. `_assertReady`) and container-class updates.
	 */
	_phase: PlayerPhase;
}

// ──────────────────────────────────────────────────────────────────────────
// Narrow backend interfaces — local to this mixin
// ──────────────────────────────────────────────────────────────────────────

interface _BackendWithState { state?: () => string }
interface _BackendWithSetQuality { setQuality?: (idx: number | 'auto') => void }
interface _BackendWithSetAudioTrack { setAudioTrack?: (idx: number) => void }

// ──────────────────────────────────────────────────────────────────────────
// Backend shape — structural contract for the resolved backend handle.
// Declared here so callers can narrow via `_resolveBackend` / `_peekBackend`.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Hints forwarded to `backend.load()`. `startTime` lets the backend begin
 * playback at an offset natively (hls.js `startPosition`, element
 * `currentTime` at metadata) instead of the kit seeking after the fact —
 * which downloads and decodes the start of the stream just to discard it.
 */
export interface BackendLoadHints {
	startTime?: number;
}

export interface BackendShape {
	play?: () => Promise<void> | void;
	pause?: () => void;
	stop?: () => void;
	load?: (url: string, hints?: BackendLoadHints) => Promise<void>;
	/** `true` when the backend consumes `BackendLoadHints.startTime` natively — the kit then skips its post-load seek fallback. */
	canStartAt?: boolean;
	currentTime?: (seconds: number) => void;
	buffered?: () => number;
	bufferedRanges?: () => TimeRanges;
	seekable?: () => TimeRanges;
	volume?: (level: number) => void;
	mute?: () => void;
	unmute?: () => void;
	playbackRate?: (rate: number) => void;
}

function _isBackendShape(value: unknown): value is BackendShape {
	return typeof value === 'object' && value !== null;
}

// ──────────────────────────────────────────────────────────────────────────
// Mixin: shared buffer / network / stream / visibility / quality / audioTrack
// state reads. Both NMMusicPlayer and NMVideoPlayer exhibit these identically.
// The per-library `_backend` is accessed via `_peekBackend` so this mixin is
// backend-agnostic and does not need to know whether it runs in a music or
// video context.
// ──────────────────────────────────────────────────────────────────────────

export const playerStateMethods = {
	/**
	 * Move the player to a new lifecycle phase and emit `phase` with
	 * `{ from, to }`. No-ops when `next` matches the current phase so
	 * repeated transitions don't produce duplicate events.
	 */
	_transitionPhase(this: Internals, next: PlayerPhase): void {
		const from = this._phase;
		if (from === next)
			return;
		this._phase = next;

		this.emit('phase', {
			from,
			to: next,
		});
	},

	/**
	 * Retrieve the active backend and narrow it to `BackendShape` via a
	 * runtime type guard. Returns `undefined` when no backend has been
	 * registered or the registered value is not an object — callers use
	 * optional chaining (`_resolveBackend()?.play?.()`) rather than
	 * guarding themselves.
	 */
	_resolveBackend(this: Internals): BackendShape | undefined {
		if (typeof this.backend !== 'function')
			return undefined;
		const result = this.backend();
		return _isBackendShape(result) ? result : undefined;
	},

	/**
	 * Retrieve the active backend without narrowing, swallowing any
	 * exception the `backend()` accessor might throw. Use this when you
	 * need to probe optional capabilities not in `BackendShape` — pair with
	 * `_peekBackendTyped<S>()` to apply a local structural type.
	 */
	_peekBackend(this: Internals): unknown {
		if (typeof this.backend !== 'function')
			return undefined;
		try {
			return this.backend();
		}
		catch { return undefined; }
	},

	/**
	 * Retrieve the active backend and cast it to a caller-supplied
	 * structural type `S`. The caller is responsible for ensuring `S` only
	 * probes optional fields (via `?.`) — no runtime validation is
	 * performed beyond the null-object check inside `_peekBackend`.
	 */
	_peekBackendTyped<S extends object>(this: Internals): S | undefined {
		return this._peekBackend() as S | undefined;
	},

	/**
	 * Assert that the player is in a usable state before any transport or
	 * media operation. Throws `PlayerError('core:player/not-ready')` when
	 * `setup()` has not been called, and `PlayerError('core:player/disposed')`
	 * when `dispose()` has already been called or is in progress.
	 *
	 * @throws {PlayerError} `core:player/not-ready` — setup not called yet.
	 * @throws {PlayerError} `core:player/disposed` — player is disposed or disposing.
	 */
	_assertReady(this: Internals): void {
		if (this._phase === 'idle') {
			throw stateError('core:player/not-ready', 'Player has not been setup() yet.');
		}
		if (this._phase === 'disposed' || this._phase === 'disposing') {
			throw stateError('core:player/disposed', 'Player has been disposed.');
		}
	},

	/**
	 * Run a cancellable `before*` dispatch for `beforeEvent` and return the
	 * outcome. Listeners receive `data` and may call `event.preventDefault()`
	 * to cancel the action. The optional `beforeEventTimeoutMs` player option
	 * caps how long async listeners are awaited before the dispatch resolves
	 * as not-prevented.
	 */
	async _dispatchBefore<TData>(this: Internals, beforeEvent: string, data: TData): Promise<BeforeDispatchOutcome<TData>> {
		// A silent action is a programmatic state restore, not user intent. It
		// skips the guard as well as the event, because a listener that cancels
		// `beforePlay` is answering a user, and this is not one.
		if ((data as { silent?: boolean } | null)?.silent === true) {
			return { prevented: false, data } as BeforeDispatchOutcome<TData>;
		}

		const timeoutMs = this.options?.beforeEventTimeoutMs;
		return runDispatchBefore<TData>(this, beforeEvent, data, timeoutMs !== undefined ? { timeoutMs } : undefined);
	},

	/**
	 * Coarse buffer health from the backend. Maps the backend's raw state
	 * string to the `BufferState` enum: `loading` → LOADING, `seeking` →
	 * SEEKING, `stalled` → STALLED, anything else → IDLE. Returns IDLE when
	 * no backend is registered.
	 */
	bufferState(this: Internals): BufferState {
		const backend = this._peekBackendTyped<_BackendWithState>();
		switch (backend?.state?.()) {
			case 'loading': return BufferState.LOADING;
			case 'seeking': return BufferState.SEEKING;
			case 'stalled': return BufferState.STALLED;
			default: return BufferState.IDLE;
		}
	},

	/**
	 * Current network reachability via the platform's network monitor.
	 * Returns ONLINE when no monitor is registered (safe default for
	 * environments where network detection is unavailable). Returns SLOW
	 * when the monitor reports a downlink below 1.5 Mbps.
	 */
	networkState(this: Internals): NetworkState {
		const monitor = this._platform?.network;
		if (!monitor)
			return NetworkState.ONLINE;
		if (!monitor.isOnline())
			return NetworkState.OFFLINE;
		const downlink = monitor.downlinkMbps?.();
		if (typeof downlink === 'number' && downlink > 0 && downlink < 1.5)
			return NetworkState.SLOW;
		return NetworkState.ONLINE;
	},

	/**
	 * Raw state string from the backend (e.g. `'idle'`, `'loading'`,
	 * `'playing'`). Returns `'idle'` when no backend is registered or the
	 * backend does not expose a `state()` method. Prefer `bufferState()` for
	 * typed enum access.
	 */
	streamState(this: Internals): string {
		const backend = this._peekBackendTyped<_BackendWithState>();
		if (!backend)
			return 'idle';
		return backend.state?.() ?? 'idle';
	},

	/**
	 * Whether the player container is visible in the viewport. Delegates to
	 * the platform's visibility monitor when registered; assumes visible when
	 * no monitor is present (safe default for SSR / headless environments).
	 */
	visibilityState(this: Internals): VisibilityState {
		const visible = this._platform?.visibility?.isVisible() ?? true;
		return visible ? VisibilityState.VISIBLE : VisibilityState.HIDDEN;
	},

	/**
	 * Get or set the ABR quality selection mode.
	 *
	 * - Called with no argument: returns the current `QualityState`.
	 * - Called with a level index: switches to MANUAL mode, forwards the
	 *   index to the backend's `setQuality()`, and emits `qualityState`.
	 * - Called with `'auto'`: switches back to AUTO mode, forwards to
	 *   `setQuality('auto')`, and emits `qualityState`.
	 */
	qualityMode(this: Internals, target?: number | 'auto'): QualityState | void {
		if (target === undefined)
			return this._qualityState;
		this._qualityState = target === 'auto' ? QualityState.AUTO : QualityState.MANUAL;
		const backend = this._peekBackendTyped<_BackendWithSetQuality>();
		backend?.setQuality?.(target);
		this.emit('qualityState', { state: this._qualityState });
	},

	/**
	 * Get or set the active audio track index.
	 *
	 * - Called with no argument: returns the current `AudioTrackState`.
	 * - Called with an index: switches to MANUAL mode, forwards the index
	 *   to the backend's `setAudioTrack()`, and emits `audioTrackState`.
	 */
	audioTrackMode(this: Internals, idx?: number): AudioTrackState | void {
		if (idx === undefined)
			return this._audioTrackState;
		this._audioTrackState = AudioTrackState.MANUAL;
		const backend = this._peekBackendTyped<_BackendWithSetAudioTrack>();
		backend?.setAudioTrack?.(idx);
		this.emit('audioTrackState', { state: this._audioTrackState });
	},
} as const;
