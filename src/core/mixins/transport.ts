// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { ActionOptions, BasePlaylistItem, LoadOptions } from '../../types';

import type { Internals } from '../state';
import { PlayState, RepeatState } from '../state';

/**
 * The transport mixin's slice of player state — composed into `PlayerCoreState`.
 */
export interface TransportState {
	_playState: PlayState;
}

/**
 * Shared seek scaffolding for `rewind` / `forward` / `restart`. Each of them
 * does the same five-step dance — dispatch `beforeSeek`, bail on prevention,
 * round-trip through the `seeking` phase, mutate `_internalCurrentTime`,
 * forward to the backend, emit `seeked` — only the target time differs.
 *
 * `beforeSeekTime` is what the `beforeSeek` payload carries. Today
 * `rewind`/`forward` send the *delta* (e.g. `-5` / `+5`); `restart` sends the
 * absolute `0`. Defaults to `targetTime` so callers seeking to an absolute
 * position don't have to spell the same number twice.
 *
 * Returns whether the seek actually happened (a `beforeSeek` listener can
 * prevent it). Callers chasing with side effects (`restart` plays after)
 * gate on `proceeded`.
 */
async function _dispatchSeek(
	self: Internals,
	targetTime: number,
	opts: ActionOptions,
	beforeSeekTime: number = targetTime,
): Promise<{ proceeded: boolean }> {
	const result = await self._dispatchBefore<{ time: number; source?: string }>('beforeSeek', {
		time: beforeSeekTime,
		source: opts.source,
	});
	if (result.prevented) {
		self.emit('seekPrevented', {
			reason: result.reason ?? 'listener-prevented',
			cause: result.cause,
		});
		return { proceeded: false };
	}
	self._seekingTransition(() => {
		self._internalCurrentTime = targetTime;
		self.emit('seek', {
			time: targetTime,
			source: result.data.source,
		});
	});
	self._resolveBackend()?.currentTime?.(targetTime);
	self.emit('seeked', { time: targetTime });
	return { proceeded: true };
}

/**
 * Load `item` into the backend then begin playback. Used by `next()` and
 * `previous()` — the repeat-mode branches all do the same two steps; this
 * helper eliminates the triplication.
 *
 * `data` carries the (possibly mutated) `LoadOptions` from the `beforeNext` /
 * `beforePrevious` dispatch outcome so `source` and `startAt` are forwarded
 * consistently.
 */
async function _loadAndPlay(
	self: Internals,
	item: BasePlaylistItem,
	data: LoadOptions,
): Promise<void> {
	await self.load(item, {
		source: data.source,
		startAt: data.startAt,
	});
	// Same reason as the autoplay continuation in queue.ts item(): a browser
	// that refuses playback without a gesture rejects here, nobody awaits it,
	// and a bare call leaves an unhandled rejection in the console.
	void self.play({ source: data.source }).catch(() => { /* surfaces via playPrevented */ });
}

// ──────────────────────────────────────────────────────────────────────────
// Mixin: transport — play / pause / stop / seek / next / previous, the
// cancellable `before*` dispatch surface, and seek-phase round-trips. Every
// action runs `_assertReady` first and routes through a `beforeXxx` event so
// plugins can preventDefault on intent before any state mutation lands.
// ──────────────────────────────────────────────────────────────────────────

export const transportMethods = {
	/**
	 * Wrap a synchronous seek with a `seeking` phase round-trip: enter
	 * `seeking` while the seek is in flight, return to the prior phase once
	 * done. The round-trip is skipped when the prior phase isn't `playing` /
	 * `paused` / `starting` — pre-play seeks during setup don't want to flash
	 * `seeking` blips through the UI.
	 *
	 * With no real backend the seek "resolves" immediately. When a backend
	 * lands that emits its own `seeked` callback, this helper can grow to
	 * await it before transitioning back.
	 */
	_seekingTransition(this: Internals, doSeek: () => void): void {
		const prior = this._phase;
		const shouldTransition = prior === 'playing' || prior === 'paused' || prior === 'starting';

		if (shouldTransition) {
			this._transitionPhase('seeking');
		}

		doSeek();

		if (shouldTransition) {
			this._transitionPhase(prior);
		}
	},

	/**
	 * Start (or resume) playback. Dispatches `beforePlay` first — a listener
	 * may `preventDefault()` to cancel, in which case `playPrevented` fires
	 * with the reason and no state changes. Otherwise transitions to
	 * `starting` (when prior phase was `ready` / `paused`), emits `play`, and
	 * calls the backend's `play()`.
	 */
	async play(this: Internals, opts: ActionOptions = {}): Promise<void> {
		this._assertReady();
		const result = await this._dispatchBefore<ActionOptions>('beforePlay', { ...opts });
		if (result.prevented) {
			this.emit('playPrevented', {
				reason: result.reason ?? 'listener-prevented',
				cause: result.cause,
			});
			return;
		}
		const priorPhase = this._phase;
		this._playState = PlayState.PLAYING;
		if (this._phase === 'ready' || this._phase === 'paused') {
			this._transitionPhase('starting');
		}
		if (!result.data.silent)
			this.emit('play', result.data);

		try {
			await this._resolveBackend()?.play?.();
		}
		catch (cause) {
			// The optimistic state above assumed the backend would accept. When it
			// refuses — a browser declining autoplay without a gesture is the
			// common case — leaving `_playState` on PLAYING makes every UI that
			// renders from state show a Pause button over a silent element, and
			// the viewer's first click pauses what was never playing.
			this._playState = PlayState.PAUSED;
			if (this._phase === 'starting') {
				this._transitionPhase(priorPhase === 'ready' ? 'ready' : 'paused');
			}
			this.emit('playPrevented', {
				reason: 'backend-refused',
				cause,
			});
			throw cause;
		}
	},

	/**
	 * Pause playback. Dispatches `beforePause`; a listener may
	 * `preventDefault()` and the call emits `pausePrevented` instead.
	 * Otherwise transitions to `paused` (when prior phase was `playing` /
	 * `starting`), emits `pause`, and calls the backend's `pause()`.
	 */
	async pause(this: Internals, opts: ActionOptions = {}): Promise<void> {
		this._assertReady();
		const result = await this._dispatchBefore<ActionOptions>('beforePause', { ...opts });
		if (result.prevented) {
			this.emit('pausePrevented', {
				reason: result.reason ?? 'listener-prevented',
				cause: result.cause,
			});
			return;
		}
		this._playState = PlayState.PAUSED;
		if (this._phase === 'playing' || this._phase === 'starting') {
			this._transitionPhase('paused');
		}
		if (!result.data.silent)
			this.emit('pause', result.data);

		this._resolveBackend()?.pause?.();
	},

	/**
	 * Stop playback and release the source. Dispatches `beforeStop`; a
	 * listener may `preventDefault()` and the call emits `stopPrevented`
	 * instead. Otherwise transitions to `stopped`, emits `stop`, and calls
	 * the backend's `stop()`.
	 */
	async stop(this: Internals, opts: ActionOptions = {}): Promise<void> {
		this._assertReady();
		const result = await this._dispatchBefore<ActionOptions>('beforeStop', { ...opts });
		if (result.prevented) {
			this.emit('stopPrevented', {
				reason: result.reason ?? 'listener-prevented',
				cause: result.cause,
			});
			return;
		}
		this._playState = PlayState.STOPPED;
		this._transitionPhase('stopped');
		if (!result.data.silent)
			this.emit('stop', result.data);

		this._resolveBackend()?.stop?.();
	},

	/**
	 * Flip between play and pause depending on current `_playState`. Routes
	 * through the underlying `play()` / `pause()` so the `beforePlay` /
	 * `beforePause` dispatch chains still fire.
	 */
	async togglePlayback(this: Internals, opts?: ActionOptions): Promise<void> {
		this._assertReady();
		if (this._playState === PlayState.PLAYING)
			await this.pause(opts);
		else await this.play(opts);
	},

	/**
	 * Advance to the next queue item and start playback. Dispatches
	 * `beforeNext`; preventable via `preventDefault()` (emits `nextPrevented`).
	 *
	 * Repeat mode (set via `repeatState()`) is honoured here:
	 *  - `'one'`  — reload the current item instead of advancing. The queue
	 *               cursor does not move.
	 *  - `'all'`  — when already at the last item, wrap to the first item
	 *               instead of emitting `queue:exhausted`.
	 *  - `'off'`  — emit `queue:exhausted` when there is no next item (default).
	 */
	async next(this: Internals, opts: LoadOptions = {}): Promise<void> {
		this._assertReady();
		const result = await this._dispatchBefore<LoadOptions>('beforeNext', { ...opts });
		if (result.prevented) {
			this.emit('nextPrevented', {
				reason: result.reason ?? 'listener-prevented',
				cause: result.cause,
			});
			return;
		}

		const repeatMode = this._repeatState;

		if (repeatMode === RepeatState.ONE) {
			const currentItem = this._queueList.current();
			if (!currentItem) {
				this.emit('queue:exhausted');
				return;
			}
			if (!result.data.silent)
				this.emit('next', result.data);
			await _loadAndPlay(this, currentItem, result.data ?? {});
			return;
		}

		const nextItem = this._queueList.peekNext();

		if (!nextItem) {
			if (repeatMode === RepeatState.ALL) {
				const allItems = this._queueList.get();
				const firstItem = allItems[0];
				if (!firstItem) {
					this.emit('queue:exhausted');
					return;
				}
				if (!result.data.silent)
					this.emit('next', result.data);
				this._queueList.setCurrent(0);
				await _loadAndPlay(this, firstItem, result.data ?? {});
				return;
			}

			this.emit('queue:exhausted');
			return;
		}

		if (!result.data.silent)
			this.emit('next', result.data);

		// Cursor moves BEFORE the media switch — same order as item() — so
		// `current` fires immediately and the UI (title, poster, playlist
		// highlight) reflects the incoming item while its media still loads.
		this._queueList.setCurrent(nextItem);
		await _loadAndPlay(this, nextItem, result.data ?? {});
	},

	/**
	 * Go back to the previous queue item and start playback. Dispatches
	 * `beforePrevious`; preventable via `preventDefault()` (emits
	 * `previousPrevented`). Silently no-ops when no previous item exists
	 * (no `queue:exhausted` symmetric event — going past the start is a
	 * common gesture, not an error worth announcing).
	 */
	async previous(this: Internals, opts: LoadOptions = {}): Promise<void> {
		this._assertReady();
		const result = await this._dispatchBefore<LoadOptions>('beforePrevious', { ...opts });
		if (result.prevented) {
			this.emit('previousPrevented', {
				reason: result.reason ?? 'listener-prevented',
				cause: result.cause,
			});
			return;
		}

		const prevItem = this._queueList.peekPrevious();
		if (!prevItem) {
			return;
		}

		if (!result.data.silent)
			this.emit('previous', result.data);

		// Cursor moves before the media switch — see next().
		this._queueList.setCurrent(prevItem);
		await _loadAndPlay(this, prevItem, result.data ?? {});
	},

	/**
	 * Seek backwards by `seconds` (default 5). Dispatches `beforeSeek` with
	 * the negative delta in `time`; preventable via `preventDefault()` (emits
	 * `seekPrevented`). Clamps the result to 0 — rewinding past the start
	 * lands at the start, not at a negative time.
	 */
	async rewind(this: Internals, seconds = 5, opts: ActionOptions = {}): Promise<void> {
		this._assertReady();
		const target = Math.max(0, this._internalCurrentTime - seconds);
		await _dispatchSeek(this, target, opts, -seconds);
	},

	/**
	 * Seek forwards by `seconds` (default 5). Dispatches `beforeSeek` with
	 * the positive delta in `time`; preventable via `preventDefault()` (emits
	 * `seekPrevented`). No upper clamp — backends that don't support seeking
	 * past `duration` will snap to the end on their own.
	 */
	async forward(this: Internals, seconds = 5, opts: ActionOptions = {}): Promise<void> {
		this._assertReady();
		const target = this._internalCurrentTime + seconds;
		await _dispatchSeek(this, target, opts, seconds);
	},

	/**
	 * Seek to time 0 and play. Dispatches `beforeSeek` with `time: 0`;
	 * preventable via `preventDefault()` (emits `seekPrevented`). When the
	 * seek is cancelled the subsequent `play()` is also skipped — restart
	 * is an atomic intent, not a seek-then-play sequence.
	 */
	async restart(this: Internals, opts: ActionOptions = {}): Promise<void> {
		this._assertReady();
		const { proceeded } = await _dispatchSeek(this, 0, opts);
		if (proceeded)
			await this.play(opts);
	},
} as const;
