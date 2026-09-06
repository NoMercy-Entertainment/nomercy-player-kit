// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { BasePlaylistItem, LoadOptions } from '../../types';
import type { Internals } from '../state';
import type { ItemWithTracks } from './sidecar-util';
import {
	makePlayerErrorEvent,
	mediaFormatError,
	PlayerError,
	resourceError,
	stateError,
} from '../../errors';

import { authFetch } from '../auth-fetch';
import { PlayState } from '../state';
import { hasTracksField } from './sidecar-util';

// ──────────────────────────────────────────────────────────────────────────
// Mixin: loading — `load(item, opts)` / `loadQueue(url, parser?)`.
//
// `load(item)` fires `beforeLoad` (cancellable), resolves the URL through
// the active auth transformer, then delegates to the backend's `load(url)`.
// A monotonic epoch guards against load-races when the consumer fires
// multiple load() calls in quick succession.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Phases from which a `load()` call should transition through `loading`.
 * Includes `'starting'` because a double-tap load (load while loading) needs
 * the same visual transition path.
 */
const RESUMABLE_PHASES_FOR_LOAD = ['ready', 'playing', 'paused', 'starting', 'ended'] as const;

/**
 * Phases from which we should restore to `priorPhase` on a `load()` error.
 * Excludes `'starting'` — an error during a start-from-cold should not restore
 * to `starting`; the player is already moving toward `ready` or failed.
 */
const RESUMABLE_PHASES_FOR_ERROR = ['ready', 'playing', 'paused', 'ended'] as const;

export const loadingMethods = {
	/**
	 * Load a single playlist item into the player. Dispatches `beforeLoad`
	 * first — a listener may `preventDefault()`, in which case `loadPrevented`
	 * fires and the method returns without touching the backend.
	 *
	 * URL resolution order: `item.url` → `auth.transformUrl` (if present) →
	 * backend `load(url)`. The item's track URLs (subtitles, chapters, …) are
	 * resolved via `resolveItemTrackUrls` before the backend receives the item,
	 * and the queue is updated in-place when the resolved item differs from the
	 * original.
	 *
	 * Phase transitions: the player enters `loading` while the backend is
	 * mounting, then returns to `ready` on success (or restores the prior
	 * phase on failure). The transition is skipped when `load()` is called
	 * before the setup pipeline has completed, to avoid a `loading→paused`
	 * flash during initial auto-load.
	 *
	 * Play state: `playState()` reports `LOADING` from the moment the load is
	 * committed (after `beforeLoad` passes and the URL resolves) until the
	 * backend is mounted — on EVERY load, including the initial auto-load that
	 * skips the phase flash, and including re-loads out of `ERROR`. On success
	 * an undisturbed `LOADING` settles to `PAUSED` (media ready, position
	 * held); a `play()` / `pause()` / `stop()` that landed mid-load owns the
	 * state instead. On failure the state this load displaced is restored.
	 *
	 * `opts.startAt` — begin playback at this timestamp (seconds). Forwarded
	 * to the backend as a load hint so engines that support it (hls.js
	 * `startPosition`) fetch the first fragment AT the offset instead of
	 * downloading the start of the stream and seeking away from it. Backends
	 * that declare `canStartAt: true` consume the hint natively; for all
	 * others the kit falls back to a post-load seek. `opts.fadeIn` — ramp
	 * volume from 0 to the current level over this many seconds.
	 *
	 * Emits `mediaReady` after a successful load. On failure it re-throws.
	 * Nothing is emitted: an undecodable source reaches no severity channel,
	 * and `playState()` stays where it was.
	 *
	 * @throws when `item.url` is missing or the backend is not wired.
	 */
	async load<T extends BasePlaylistItem>(
		this: Internals,
		item: T,
		opts?: LoadOptions,
	): Promise<void> {
		this._assertReady();

		// Capture phase before any async work so the loading transition
		// reflects the actual state at call time — not the state after
		// awaited setup-pipeline steps have already moved to 'ready'.
		const priorPhase = this._phase;

		const beforeResult = await this._dispatchBefore<{ item: T; source?: string }>(
			'beforeLoad',
			{
				item,
				source: opts?.source,
			},
		);
		if (beforeResult.prevented) {
			this.emit('loadPrevented', {
				reason: beforeResult.reason ?? 'listener-prevented',
				cause: beforeResult.cause,
			});
			return;
		}

		// `item.url` is the canonical field. The full resolution pipeline
		// (`auth.transformUrl`, custom `urlResolver`, `baseUrl` for relative
		// paths) applies to the MAIN media URL exactly like it does to track
		// URLs — a bare transformUrl here left relative item URLs anchored to
		// the page origin, where an SPA fallback answers 200 with HTML.
		const item2 = beforeResult.data.item;
		const rawUrl = item2.url;
		if (!rawUrl) {
			throw mediaFormatError('core:media/missing-url', 'load(item) requires `item.url` to be present.', { id: item2.id });
		}
		const url = (await this.resolveUrl(rawUrl, 'media')).href;

		const resolvedItem = await this.resolveItemTrackUrls(item2);
		if (resolvedItem !== item2 && hasTracksField(resolvedItem)) {
			// Re-read the queue entry fresh rather than writing back this
			// pre-fetch snapshot — another writer (e.g. `addSubtitleTrack`)
			// may have mutated it while the URL resolution was in flight.
			// Merge only the fields this resolver owns (`tracks`, `chapters`)
			// onto the CURRENT entry instead of clobbering that change.
			const latestItem = this._queueList.get().find(queued => queued.id === item2.id);
			if (latestItem) {
				const merged: BasePlaylistItem & ItemWithTracks = {
					...latestItem,
					tracks: resolvedItem.tracks,
				};
				if (Array.isArray(resolvedItem.chapters))
					merged.chapters = resolvedItem.chapters;
				this._queueList.replaceItem(merged);
			}
		}

		// The play state tracks the fetch/initialise work itself, not the phase
		// presentation: LOADING lands on every committed load — including the
		// ones that skip the phase flash below — so `playState()` always
		// reports an in-flight load. Assigned before the phase transition so
		// `phase` listeners (and the container-class rule) observe the settled
		// state. The displaced state is captured so a failed load can put it
		// back, mirroring the `priorPhase` restore in the catch block.
		const priorPlayState = this._playState;
		this._playState = PlayState.LOADING;

		// Skip the loading phase flash when the player has never shown content
		// (idle/setup). setup() ends with _transitionPhase('ready'), giving a
		// clean settled state once backend.load() completes. `'ended'` is
		// included so auto-advance loads (which fire while the player is in
		// `ended` phase) properly transition through `loading` → `ready`.
		if ((RESUMABLE_PHASES_FOR_LOAD as ReadonlyArray<string>).includes(priorPhase)) {
			this._transitionPhase('loading');
		}

		// Race-guard: bump a monotonic load epoch and capture it. When the
		// consumer fires load(A) then load(B) in quick succession, the older
		// continuation would otherwise overwrite cursor / phase / opts back to
		// A once it resolves. Anything side-effectful after the awaited
		// backend.load only runs when our epoch is still the latest.
		const epoch = (this._loadEpoch ?? 0) + 1;
		this._loadEpoch = epoch;
		const isLatest = (): boolean => this._loadEpoch === epoch;

		// Reset the itemEndingSoon one-shot latch so the event fires exactly once
		// for each new item that starts loading.
		this._itemEndingSoonEmitted = false;

		const startAt = typeof opts?.startAt === 'number' && opts.startAt > 0 ? opts.startAt : undefined;

		try {
			const backend = this._resolveBackend();
			if (!backend || typeof backend.load !== 'function') {
				throw stateError('core:player/backend-missing', 'No backend wired — backend() returned null/undefined.');
			}
			performance.mark('nm:kit:backend.load:start');
			await backend.load(url, startAt !== undefined ? { startTime: startAt } : undefined);
			performance.mark('nm:kit:backend.load:end');
			if (!isLatest())
				return;

			// Move cursor to the loaded item so consumer-facing `item()` reflects it.
			// Use setCurrent directly — calling this.item() here would re-trigger load().
			// Guard: skip when the cursor is already at this item to prevent a duplicate `current` event.
			// Pass the ITEM, never its id: setCurrent treats an integer as an
			// INDEX, so a numeric id resolved as a wildly out-of-range index
			// and silently left the cursor behind on every load.
			const alreadyCurrent = this._queueList.current()?.id === item2.id;
			if (!alreadyCurrent) {
				this._queueList.setCurrent(item2);
			}

			// The backend is now holding THIS item's media. Recorded after the
			// mount, never before: everything between the cursor move and this
			// line is time the outgoing item's element is still attached and
			// still reporting its own position.
			this._mountedItemId = item2.id;

			// Seek fallback for backends that can't start at an offset natively.
			if (startAt !== undefined && backend.canStartAt !== true) {
				const ret = this.time(startAt);
				if (ret instanceof Promise)
					await ret;
				if (!isLatest())
					return;
			}

			// Trivial linear fade — no easing curve. Plugins that need fancier
			// transitions should hook `mediaReady` and drive volume themselves.
			//
			// Uses `_applyVolume` (bypasses the public `volume()` setter) so this
			// internal ramp does not dispatch `beforeVolume` on every one of the
			// ~20 steps. The fade is an implementation detail of the `fadeIn`
			// option the caller already opted into — not a fresh user-facing
			// volume command a Connect plugin should see (or be able to cancel
			// mid-ramp) 20 times per load.
			if (typeof opts?.fadeIn === 'number' && opts.fadeIn > 0) {
				const rawVolume = this.volume();
				const target = typeof rawVolume === 'number' ? rawVolume : 1;
				this._applyVolume(0);
				const steps = 20;
				const stepMs = (opts.fadeIn * 1000) / steps;
				for (let stepIndex = 1; stepIndex <= steps; stepIndex++) {
					await new Promise(resolve => setTimeout(resolve, stepMs));
					if (!isLatest())
						return;
					this._applyVolume((target * stepIndex) / steps);
				}
			}

			if (!isLatest())
				return;
			// Media is mounted; when nothing started playback during the load
			// the position is held — PAUSED per the PlayState contract. A
			// transport call that raced the load (play/pause/stop) or a fatal
			// already owns the state, so only an undisturbed LOADING settles.
			// Set before the phase transition so `phase: ready` listeners and
			// the container-class rule observe the settled state.
			if (this._playState === PlayState.LOADING) {
				this._playState = PlayState.PAUSED;
			}
			if (this._phase === 'loading') {
				this._transitionPhase('ready');
			}
			this.emit('mediaReady');
		}
		catch (err) {
			if (this._phase === 'loading' && (RESUMABLE_PHASES_FOR_ERROR as ReadonlyArray<string>).includes(priorPhase)) {
				this._transitionPhase(priorPhase);
			}
			// Put back the play state this load displaced — but only while the
			// failed load still owns it: a newer load() (epoch moved on), a
			// raced transport call, or a fatal now owns the field.
			if (isLatest() && this._playState === PlayState.LOADING) {
				this._playState = priorPlayState;
			}
			throw err;
		}
	},

	/**
	 * Whether the backend's mounted media belongs to an item the queue cursor
	 * has already moved off.
	 *
	 * `transport.next()` and `queue.item()` both move the cursor BEFORE the
	 * media switch, so the UI can repaint the incoming title while its media
	 * loads. For the length of that window the OUTGOING element is still
	 * attached and still emitting position updates. Reading those as the
	 * incoming item's position is how the previous episode's end position gets
	 * written against the next episode.
	 *
	 * `false` until the first successful mount — a consumer driving a media
	 * element without ever calling `load()` has no mounted item to be stale
	 * against, and must not have its position updates suppressed.
	 */
	_mediaIsStale(this: Internals): boolean {
		if (this._mountedItemId === undefined)
			return false;
		const current = this._queueList.current();
		return current !== undefined && current.id !== this._mountedItemId;
	},

	/**
	 * Fetch a remote playlist URL and replace the current queue with the
	 * parsed result.
	 *
	 * The request goes through the same auth pipeline as all other player
	 * fetches — `_authConfig` (or `options.auth` as fallback) is forwarded to
	 * `authFetch` automatically.
	 *
	 * `parser` is optional. When omitted the response body is parsed as JSON.
	 * Supply a custom parser for M3U, XSPF, or other playlist formats.
	 *
	 * Emits `playlistResolving` before the fetch, `playlistReady` on success,
	 * `playlistResolveError` and `error` on failure (and re-throws).
	 */
	async loadQueue<T extends BasePlaylistItem>(
		this: Internals,
		url: string,
		parser?: (raw: string) => T[],
	): Promise<void> {
		this._assertReady();

		this.emit('playlistResolving', { url });

		const config = this.options ?? {};
		const ctrl = new AbortController();
		try {
			const items = await authFetch<T[]>({
				url,
				auth: this._authConfig ?? config.auth,
				parser: parser ?? ((raw: string): T[] => JSON.parse(raw)),
				emit: (event: string, data: unknown) => this.emit(event, data),
				pluginId: undefined,
				scope: 'player',
				signal: ctrl.signal,
			});
			this.queue(items);
			this.emit('playlistReady', { length: items.length });
		}
		catch (err) {
			const playerErr = err instanceof PlayerError
				? err
				: resourceError(
						'core:resource/playlist-fetch-failed',
						err instanceof Error ? err.message : String(err),
					);
			const errorPayload = makePlayerErrorEvent(playerErr, 'error', { kind: 'core' });
			this.emit('playlistResolveError', errorPayload);
			this.emit('error', errorPayload);
			throw err;
		}
	},
} as const;
