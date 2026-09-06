// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { MediaList } from '../../adapters/media-list/default';
import type { ActionOptions, BasePlaylistItem, LoadOptions } from '../../types';

import type { Internals } from '../state';
import { interpolateTitleTokens } from '../title-tokens';

/**
 * The queue mixin's slice of player state — composed into `PlayerCoreState`.
 * Carries the `T` playlist-item generic so per-library subclasses narrow it.
 * Declared here, beside the methods that write it.
 */
export interface QueueState<T extends BasePlaylistItem = BasePlaylistItem> {
	/**
	 * The live play queue. Written by `queueMethods.queue()` and queue
	 * mutators; read by `current()`, `next()`, `previous()`, and every
	 * consumer that calls `player.queue()`. The `MediaList` wrapper provides
	 * cursor tracking and shuffle-safe iteration.
	 */
	_queueList: MediaList<T>;

	/**
	 * Items removed from the queue by auto-advance or manual removes.
	 * Held so `previous()` can reach back past the queue head. Cleared when
	 * the queue is replaced.
	 */
	_backlogList: MediaList<T>;

	/**
	 * `true` once the queue event listeners (item-change, end-of-list) have
	 * been attached to `_queueList`. Guards against double-wiring when
	 * `setup()` or `queue()` is called multiple times.
	 */
	_queueWired: boolean;

	/**
	 * Monotonic counter bumped on each `current()` write call. The autoplay
	 *  continuation in `current()` checks this before calling `play()` so that
	 *  a superseded navigation (rapid episode clicks) does not fire a spurious
	 *  play() once its stale load silently resolves.
	 */
	_currentEpoch?: number;

	/**
	 * Cursor target chosen before the configured playlist reached the queue.
	 * `setup({ playlist })` only seeds during the ready pipeline, so a consumer
	 * picking a start item (a `?season=&episode=` deep link, say) right after
	 * `setup()` addresses an empty queue. The pipeline applies this the moment
	 * the queue exists, which is still inside `ready()` — soon enough for the
	 * per-library autoplay step to see a real choice.
	 */
	_pendingSelection?: BasePlaylistItem | string | number | ((item: BasePlaylistItem) => boolean);
}

/**
 * Move the cursor to a selection parked before the queue existed. Called by the
 * setup pipeline right after the configured playlist seeds.
 */
export function applyPendingSelection(self: Internals): void {
	if (self._pendingSelection === undefined)
		return;

	const target = self._pendingSelection;
	self._pendingSelection = undefined;
	self._queueList.setCurrent(target);
}

// ──────────────────────────────────────────────────────────────────────────
// Wire the MediaList events to the player event bus. Idempotent — safe to
// call before every queue mutation.
// ──────────────────────────────────────────────────────────────────────────

function _wireQueue(self: Internals): void {
	if (self._queueWired)
		return;
	self._queueWired = true;

	self._queueList.on('change', ({ items }) => self.emit('queue', items));
	self._queueList.on('append', data => self.emit('queue:append', data));
	self._queueList.on('prepend', data => self.emit('queue:prepend', data));
	self._queueList.on('insert', data => self.emit('queue:insert', data));
	self._queueList.on('remove', data => self.emit('queue:remove', data));
	self._queueList.on('move', data => self.emit('queue:move', data));
	self._queueList.on('clear', data => self.emit('queue:clear', data));
	self._queueList.on('shuffle', () => self.emit('queue:shuffle'));
	self._queueList.on('sort', () => self.emit('queue:sort'));
	self._queueList.on('item', (data) => {
		self._disposeSidecarSubtitle();

		// The cursor moves before the media switch, so the position and duration
		// on the internal slots still describe the OUTGOING item. Drop them here
		// rather than letting the incoming item inherit them — a listener reading
		// `time()` inside this very `item` handler otherwise gets the previous
		// item's end position and attributes it to the new one.
		if (self._mountedItemId !== undefined && data.item?.id !== self._mountedItemId) {
			self._internalCurrentTime = 0;
			self._internalDuration = 0;
		}

		self.emit('item', data);
		void self._resolveAndEmitChapters(data.item?.id);
	});

	self._backlogList.on('change', ({ items }) => self.emit('backlog', items));
	self._backlogList.on('append', data => self.emit('backlog:append', data));
	self._backlogList.on('remove', data => self.emit('backlog:remove', data));
	self._backlogList.on('clear', data => self.emit('backlog:clear', data));
}

// ──────────────────────────────────────────────────────────────────────────
// Ingest pipeline — every item entering the queue passes through the
// package-supplied normalizer (wire-format adaptation), then the consumer's
// `transformPlaylistItem` config callback. Both optional; both idempotent
// by contract, so re-queuing already-processed items is safe.
// ──────────────────────────────────────────────────────────────────────────

function _ingestOne(self: Internals, item: BasePlaylistItem): BasePlaylistItem {
	const normalized = self.normalizePlaylistItem ? self.normalizePlaylistItem(item) : item;
	const transform = self.options?.transformPlaylistItem;
	const result: BasePlaylistItem = transform ? transform(normalized) : normalized;

	if (typeof result.title === 'string') {
		result.title = interpolateTitleTokens(result.title, self._translator, self._titleTokenRegistry);
	}

	return result;
}

function _ingest(self: Internals, item: BasePlaylistItem | BasePlaylistItem[]): BasePlaylistItem | BasePlaylistItem[] {
	return Array.isArray(item)
		? item.map(entry => _ingestOne(self, entry))
		: _ingestOne(self, item);
}

// ──────────────────────────────────────────────────────────────────────────
// Mixin: queue + cursor + backlog (delegates to MediaList<T>)
// ──────────────────────────────────────────────────────────────────────────

export const queueMethods = {
	/**
	 * Read or write the queue.
	 *
	 * `queue()` — returns the current playlist as a read-only array. Wires the
	 * internal `MediaList` event bridge on first call so subsequent mutations
	 * automatically emit the corresponding `queue:*` events.
	 *
	 * `queue(items)` — replace the entire playlist with `items`. Emits `queue`
	 * with the new array.
	 */
	queue(this: Internals, items?: BasePlaylistItem[], _opts?: ActionOptions): ReadonlyArray<BasePlaylistItem> | void {
		_wireQueue(this);
		if (items === undefined)
			return this._queueList.get();
		this._queueList.set(_ingest(this, items) as BasePlaylistItem[]);
	},

	/**
	 * Append one item or an array of items to the end of the queue. Emits
	 * `queue:append` with the added item(s) and index range.
	 */
	queueAppend(this: Internals, item: BasePlaylistItem | BasePlaylistItem[], _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.append(_ingest(this, item));
	},

	/**
	 * Prepend one item or an array of items to the start of the queue. Emits
	 * `queue:prepend` with the added item(s).
	 */
	queuePrepend(this: Internals, item: BasePlaylistItem | BasePlaylistItem[], _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.prepend(_ingest(this, item));
	},

	/**
	 * Insert one item or an array of items at `index`. Items at and after that
	 * position shift right. Emits `queue:insert` with the item(s) and insertion
	 * index.
	 */
	queueInsert(this: Internals, item: BasePlaylistItem | BasePlaylistItem[], index: number, _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.insert(_ingest(this, item), index);
	},

	/**
	 * Remove the item with the given `id` from the queue. No-op when the id is
	 * not found. Emits `queue:remove` with the removed item and its former index.
	 */
	queueRemove(this: Internals, id: string | number, _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.remove(id);
	},

	/**
	 * Remove the item at the given zero-based `index`. No-op when `index` is
	 * out of range. Emits `queue:remove`.
	 */
	queueRemoveAt(this: Internals, index: number, _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.removeAt(index);
	},

	/**
	 * Move the item at position `from` to position `to` (both zero-based).
	 * No-op when either index is out of range. Emits `queue:move` with the
	 * old and new indices.
	 */
	queueMove(this: Internals, from: number, to: number, _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.move(from, to);
	},

	/**
	 * Remove all items from the queue. Emits `queue:clear`.
	 */
	queueClear(this: Internals, _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.clear();
	},

	/**
	 * Randomly reorder all items in the queue in-place. Emits `queue:shuffle`.
	 */
	queueShuffle(this: Internals, _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.shuffle();
	},

	/**
	 * Sort the queue in-place using `compare` (same contract as
	 * `Array.prototype.sort`). Emits `queue:sort`.
	 */
	queueSort(this: Internals, compare: (itemA: BasePlaylistItem, itemB: BasePlaylistItem) => number, _opts?: ActionOptions): void {
		_wireQueue(this);
		this._queueList.sort(compare);
	},

	/**
	 * Return the item that would become active if `next()` were called now,
	 * without moving the cursor. Returns `undefined` when the queue is
	 * exhausted.
	 */
	peekNext(this: Internals): BasePlaylistItem | undefined {
		return this._queueList.peekNext();
	},

	/**
	 * Return the item that would become active if `previous()` were called now,
	 * without moving the cursor. Returns `undefined` when already at the start.
	 */
	peekPrevious(this: Internals): BasePlaylistItem | undefined {
		return this._queueList.peekPrevious();
	},

	/**
	 * Return the total number of items in the queue.
	 */
	queueLength(this: Internals): number {
		return this._queueList.length();
	},

	/**
	 * Return the zero-based index of the item with the given `id`, or `-1`
	 * when not found.
	 */
	queueIndexOf(this: Internals, id: string | number): number {
		return this._queueList.get().findIndex(item => item.id === id);
	},

	/**
	 * Read or write the active queue cursor.
	 *
	 * `item()` — returns the active playlist item, or `undefined` when the
	 * queue is empty.
	 *
	 * `item(target, opts?)` — move the cursor to `target` (item ref, id
	 * string, or index). Fires `beforeMutation` so advisory plugins can cancel
	 * the change. Emits the `item` event when the cursor moves.
	 */
	item(this: Internals, target?: BasePlaylistItem | string | number | ((item: BasePlaylistItem) => boolean), opts?: LoadOptions): BasePlaylistItem | undefined | void {
		if (target === undefined) {
			return this._queueList.current();
		}
		_wireQueue(this);
		if (!this._emitBeforeMutation('current', [target]))
			return;

		// Bump the load epoch so any in-flight load()'s cursor-move continuation
		// does not overwrite the position we're about to set. Without this,
		// item(B) called while load(A) is still awaiting the backend would
		// let load(A) snap the cursor back to A on resolution.
		this._loadEpoch = (this._loadEpoch ?? 0) + 1;

		// Bump the current epoch independently of _loadEpoch. load() internally
		// bumps _loadEpoch again (race-guard for its own continuation), so
		// _loadEpoch at the call site is not a stable sentinel for the autoplay
		// continuation below. _currentEpoch is only ever written here, making it
		// a reliable "was a newer item() called?" check.
		this._currentEpoch = (this._currentEpoch ?? 0) + 1;
		const navigationEpoch = this._currentEpoch;

		// An empty queue during setup is the configured playlist not having
		// seeded yet, not an absent item — park the choice for the pipeline
		// rather than dropping it on the floor.
		const awaitingPlaylist = this._phase === 'setup' && this._queueList.get().length === 0;
		if (awaitingPlaylist)
			this._pendingSelection = target;
		else
			this._queueList.setCurrent(target);

		if (this._phase === 'idle' || this._phase === 'disposed' || this._phase === 'disposing')
			return;

		const activeItem = awaitingPlaylist ? undefined : this._queueList.current();
		if (!activeItem && !awaitingPlaylist)
			return;

		const doLoad = (): void => {
			if (this._currentEpoch !== navigationEpoch)
				return;

			const currentItem = this._queueList.current();
			if (!currentItem)
				return;

			void this.load(currentItem, {
				source: opts?.source,
				startAt: opts?.startAt,
			}).then(() => {
				if (this._currentEpoch !== navigationEpoch)
					return;
				// Autoplay is the default: picking an item is a decision to watch
				// it, and a caller that means otherwise passes `autoplay: false`.
				// Matches core-kmp's `item(id, autoplay = true)`.
				if (opts?.autoplay !== false) {
					// A browser refusing autoplay without a gesture rejects here.
					// That is the ordinary outcome of item() on page load, not an
					// error, and nobody is awaiting this call — left bare it
					// surfaces as an unhandled rejection in every consumer's
					// console. Nothing else reports it: a play failure reaches
					// no listener at all.
					void this.play({ source: opts?.source }).catch(() => { /* see above */ });
				}
			})
				.catch(() => { /* load errors reach no listener; suppressed to avoid an unhandled rejection. */ });
		};

		if (this._phase === 'setup') {
			void this.ready().then(doLoad)
				.catch(() => { /* setup failed — nothing to load */ });
		}
		else {
			doLoad();
		}
	},

	/**
	 * Return the zero-based index of the currently active item, or `-1` when
	 * the queue is empty.
	 */
	index(this: Internals): number {
		return this._queueList.currentIndex();
	},

	/**
	 * Navigate to a playlist item by 1-based ordinal position.
	 *
	 * `seekToIndex(1)` loads the first item, `seekToIndex(queueLength())` loads
	 * the last. Out-of-range values are silently ignored (no cursor move).
	 * Fires the same `beforeMutation` / `current` lifecycle as `item(target)`.
	 *
	 * @throws {RangeError} when `position` is not a positive integer.
	 */
	seekToIndex(this: Internals, position: number, _opts?: ActionOptions): void {
		if (!Number.isInteger(position) || position < 1) {
			throw new RangeError(`seekToIndex: position must be a positive integer, got ${position}`);
		}

		const zeroBasedIndex = position - 1;
		const items = this._queueList.get();

		if (zeroBasedIndex >= items.length)
			return;

		_wireQueue(this);
		if (!this._emitBeforeMutation('current', [zeroBasedIndex]))
			return;

		this._queueList.setCurrent(zeroBasedIndex);
	},

	/**
	 * Read or write the backlog (items that have already played and precede the
	 * current queue). The backlog does not drive cursor movement — it is a
	 * history store that consumers populate manually.
	 *
	 * `backlog()` — returns the backlog as a read-only array.
	 * `backlog(items)` — replace the backlog with `items`. Emits `backlog`.
	 */
	backlog(this: Internals, items?: BasePlaylistItem[]): ReadonlyArray<BasePlaylistItem> | void {
		_wireQueue(this);
		if (items === undefined)
			return this._backlogList.get();
		this._backlogList.set(items);
	},

	/**
	 * Append one item or an array of items to the backlog. Emits
	 * `backlog:append`.
	 */
	backlogAppend(this: Internals, item: BasePlaylistItem | BasePlaylistItem[]): void {
		_wireQueue(this);
		this._backlogList.append(item);
	},

	/**
	 * Remove the item with the given `id` from the backlog. No-op when not
	 * found. Emits `backlog:remove`.
	 */
	backlogRemove(this: Internals, id: string | number): void {
		_wireQueue(this);
		this._backlogList.remove(id);
	},

	/**
	 * Remove all items from the backlog. Emits `backlog:clear`.
	 */
	backlogClear(this: Internals): void {
		_wireQueue(this);
		this._backlogList.clear();
	},

	/**
	 * Merge additional letter→key pairs into this player's title-token registry.
	 *
	 * Registered tokens are resolved in place on every item that passes through
	 * the ingest pipeline (`queue()`, `queueAppend()`, etc.). Core ships with an
	 * empty registry; per-library players call this once in their constructor to
	 * opt in. Later calls merge without clearing earlier registrations.
	 *
	 * Example (video player):
	 *   `player.registerTitleTokens({ S: 'plugin.desktop-ui.token.season', E: 'plugin.desktop-ui.token.episode' })`
	 */
	registerTitleTokens(this: Internals, tokens: Record<string, string>): void {
		this._titleTokenRegistry = {
			...this._titleTokenRegistry,
			...tokens,
		};
	},
} as const;
