// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { ActionOptions, TimeState } from '../../types';

import type { Internals } from '../state';

/**
 * The time mixin's slice of player state — composed into `PlayerCoreState`.
 * Named `TimeInternalState` to avoid clashing with the public `TimeState` shape
 * exported from `../../types`. Declared here, beside the methods that write it.
 */
export interface TimeInternalState {
	/**
	 * Last-known current-time position in seconds. Written by `timeMethods`
	 * on each `time` event from the backend, and by seek operations before the
	 * backend confirms. Read by `time()`.
	 */
	_internalCurrentTime: number;

	/**
	 * Current playback rate multiplier (1 = normal). Written by
	 * `timeMethods.playbackRate()`; forwarded to the backend at write
	 * time. Read by `playbackRate()`.
	 */
	_playbackRate: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Private helpers — only used by timeMethods
// ──────────────────────────────────────────────────────────────────────────

function _emptyTimeRanges(): TimeRanges {
	// Stub implements the TimeRanges shape; the DOM interface has no constructor — opaque cast required.
	const stub: unknown = {
		length: 0,
		start: (): number => 0,
		end: (): number => 0,
	};
	return stub as unknown as TimeRanges; // opaque: DOM interface has no constructor
}

// ──────────────────────────────────────────────────────────────────────────
// Mixin: time / position
// ──────────────────────────────────────────────────────────────────────────

export const timeMethods = {
	/**
	 * Get or seek to a playback position in seconds.
	 *
	 * - Called with no argument: returns the current position as a number.
	 * - Called with a time: dispatches `beforeSeek`; a listener may
	 *   `preventDefault()` to cancel, in which case `seekPrevented` fires and
	 *   the position is unchanged. Otherwise runs a `seeking` phase round-trip,
	 *   updates `_internalCurrentTime`, emits `seek` then `seeked`, and
	 *   forwards the position to the backend. The setter returns a
	 *   `Promise<void>` so callers can `await` the full seek cycle.
	 *
	 * Negative values are clamped to 0. `opts.source` flows through to the
	 * `seek` / `seeked` payloads so listeners can attribute the seek origin.
	 */
	time(this: Internals, seconds?: number, opts: ActionOptions = {}): number | Promise<void> {
		if (seconds === undefined)
			return this._internalCurrentTime;
		this._assertReady();
		const target = Math.max(0, seconds);

		return (async () => {
			const result = await this._dispatchBefore<{ time: number; source?: string }>('beforeSeek', {
				time: target,
				source: opts.source,
			});
			if (result.prevented) {
				this.emit('seekPrevented', {
					reason: result.reason ?? 'listener-prevented',
					cause: result.cause,
				});
				return;
			}
			this._seekingTransition(() => {
				this._internalCurrentTime = Math.max(0, result.data.time);
				this.emit('seek', {
					time: this._internalCurrentTime,
					source: result.data.source,
				});
			});

			this._resolveBackend()?.currentTime?.(this._internalCurrentTime);

			this.emit('seeked', { time: this._internalCurrentTime });
		})();
	},

	/** Total track/clip duration in seconds. Returns 0 when metadata has not yet loaded. */
	duration(this: Internals): number {
		return this._internalDuration;
	},

	/**
	 * The absolute timeline position, in seconds, that buffered data reaches.
	 *
	 * Not a distance ahead of the playhead: it shares a frame of reference with
	 * `currentTime()` and `duration()`, which is why a scrubber draws its
	 * buffered bar as `buffered() / duration()`.
	 *
	 * Delegates to the backend; returns 0 when no backend is registered.
	 */
	buffered(this: Internals): number {
		return this._resolveBackend()?.buffered?.() ?? 0;
	},

	/**
	 * Full buffered `TimeRanges` from the backend, mirroring the
	 * `HTMLMediaElement.buffered` shape. Returns an empty range set when no
	 * backend is registered or the backend does not expose `bufferedRanges`.
	 */
	bufferedRanges(this: Internals): TimeRanges {
		return this._resolveBackend()?.bufferedRanges?.() ?? _emptyTimeRanges();
	},

	/**
	 * Seekable `TimeRanges` for the current source. Delegates to the backend's
	 * `seekable()` when the backend exposes it (e.g. an `HTMLVideoElement`
	 * backend). Returns an empty range set when no backend is mounted or the
	 * backend does not implement `seekable()`.
	 */
	seekable(this: Internals): TimeRanges {
		return this._resolveBackend()?.seekable?.() ?? _emptyTimeRanges();
	},

	/**
	 * Build a `TimeState` snapshot for an explicit position. The per-library
	 * `timeupdate` bridges construct the `time` event payload through this —
	 * the internal position slot is synced *from* that event, so the payload
	 * must come from the backend's fresh position, not the slot.
	 */
	_timeStateAt(this: Internals, position: number): TimeState {
		const duration = this.duration();
		const buffered = this.buffered();
		return {
			time: position,
			position,
			duration,
			buffered,
			remaining: Math.max(0, duration - position),
			percentage: duration > 0 ? (position / duration) * 100 : 0,
		};
	},

	/**
	 * Snapshot of all time-related state in one call. Useful for consumers
	 * that need to render a progress bar without individually calling
	 * `time()`, `duration()`, `buffered()`, and computing the rest.
	 * All derived values (remaining, percentage) are computed from live
	 * getters so the snapshot is consistent at the moment of the call.
	 * The `time` event carries this exact shape on every tick.
	 */
	timeData(this: Internals): TimeState {
		return this._timeStateAt(this._internalCurrentTime);
	},

	/**
	 * Seek to a position expressed as a percentage (0–100) of the total duration.
	 *
	 * `pct` is clamped to [0, 100]. No-op when duration is zero or
	 * non-finite (metadata not yet loaded). Delegates to
	 * `time(duration * pct / 100)`, so `beforeSeek` fires and
	 * the full seek cycle applies.
	 */
	seekByPercentage(this: Internals, pct: number, opts?: ActionOptions): void {
		const clamped = Math.max(0, Math.min(100, pct));
		const duration = this.duration();
		if (!Number.isFinite(duration) || duration <= 0)
			return;
		const ret = this.time(duration * clamped / 100, opts);
		if (ret instanceof Promise)
			void ret;
	},

	/**
	 * Get or set the playback rate multiplier.
	 *
	 * - Called with no argument: returns the current rate.
	 * - Called with a value: clamps to `[0.25, 2]` then dispatches
	 *   `beforePlaybackRate` with the clamped value. Fires unconditionally,
	 *   independent of `setup({ mutationGuards })` — see `HOT_MUTATIONS`. A
	 *   listener may `preventDefault()` to cancel, in which case
	 *   `playbackRatePrevented` fires and the rate is unchanged. Otherwise
	 *   stores the rate, emits `backend:ratechange`, and forwards to the
	 *   backend's `playbackRate()`. Returns a `Promise<void>` so callers can
	 *   await the full cancellable cycle.
	 */
	playbackRate(this: Internals, rate?: number): number | Promise<void> {
		if (rate === undefined)
			return this._playbackRate;

		const clamped = Math.max(0.25, Math.min(2, rate));

		return (async () => {
			const result = await this._dispatchBefore<{ rate: number }>('beforePlaybackRate', { rate: clamped });
			if (result.prevented) {
				this.emit('playbackRatePrevented', {
					reason: result.reason ?? 'listener-prevented',
					cause: result.cause,
				});
				return;
			}
			this._playbackRate = result.data.rate;
			this.emit('playbackRate', { rate: result.data.rate });
			this.emit('backend:ratechange', { rate: result.data.rate });

			this._resolveBackend()?.playbackRate?.(result.data.rate);
		})();
	},

	/**
	 * Supported playback rate values for UI speed-selector controls. The
	 * list is intentionally fixed — backends clamp out-of-range values on
	 * their own.
	 */
	playbackRates(this: Internals): number[] {
		return [0.5, 0.75, 1, 1.25, 1.5, 2];
	},

	/**
	 * Called by per-library timeupdate handlers on every backend tick to check
	 * whether the `itemEndingSoon` threshold has been crossed.
	 *
	 * Fires `itemEndingSoon` at most once per item — the latch
	 * `_itemEndingSoonEmitted` prevents re-firing. The latch is reset by
	 * `resetItemEndingSoonLatch()` whenever a new item begins loading.
	 *
	 * `currentTime` and `duration` are passed in (not re-read from internals)
	 * so callers that already have the values from the backend avoid a second
	 * read.
	 */
	_checkItemEndingSoon(this: Internals, currentTime: number, duration: number): void {
		if (this._itemEndingSoonEmitted)
			return;

		if (duration <= 0)
			return;

		const threshold = this.options?.itemEndingSoonThreshold ?? 10;
		const remaining = duration - currentTime;

		if (remaining > threshold)
			return;

		this._itemEndingSoonEmitted = true;

		const currentItem = this.item?.();
		if (!currentItem)
			return;

		this.emit('itemEndingSoon', {
			remaining,
			item: currentItem,
		});
	},

	/**
	 * Resets the `itemEndingSoon` one-shot latch. Call this whenever the active
	 * item changes (new load, next, previous) so the event fires exactly once
	 * per item.
	 */
	resetItemEndingSoonLatch(this: Internals): void {
		this._itemEndingSoonEmitted = false;
	},
} as const;
