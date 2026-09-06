// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * ARIA live-region politeness level passed to `player.announce()`.
 * Maps directly to the `aria-live` attribute values defined in ARIA 1.2.
 *
 * - `'polite'`    — screen reader waits for the current utterance to finish.
 * - `'assertive'` — screen reader interrupts immediately (use sparingly).
 */
export type AriaLiveLevel = 'polite' | 'assertive';

/**
 * Aggregated time state snapshot returned by `player.timeData()` and carried
 * by every `time` event. All values are in seconds; `percentage` is in the
 * range [0, 100].
 */
export interface TimeState {
	/** Current playback position (seconds) — alias of `position`, the classic field `time` listeners destructure. */
	time: number;
	/** Current playback position (seconds). */
	position: number;
	/** Total duration of the active item (seconds). `0` when unknown. */
	duration: number;
	/** The absolute timeline position buffered data reaches (seconds), on the same scale as `currentTime` and `duration`. */
	buffered: number;
	/** Seconds remaining until the end of the item. */
	remaining: number;
	/** Playback progress as a percentage of total duration (0–100). */
	percentage: number;
}
