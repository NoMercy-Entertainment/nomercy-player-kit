// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { PlayerErrorEvent } from '../errors';

import type { Chapter } from './chapter';
import type { BasePlayerConfig, CastTarget } from './config';
import type { CueEventPayload, SubtitleCueChange } from './cues';
import type { PlaybackMetrics } from './metrics';
import type { TimeState } from './playback';
import type {
	ActionOptions,
	ActionSource,
	PlayerPhase,
	PreventedReason,
} from './player';
import type { BasePlaylistItem } from './playlist';
import type { CastState, RepeatState, ShuffleState } from './state';
import type { SubtitleStyle, SubtitleTrack } from './tracks';

/**
 * Cancellable, mutable, async-aware event payload for every `before*` event.
 *
 *  - `data` is mutable. Listeners modify it; the player reads back the mutated
 *    value when running the default action and when emitting the post-action
 *    event (`play`, `seek`, etc.).
 *  - `preventDefault()` skips the default action AND its post-event chain.
 *    Consumers see a `<action>Prevented` event instead.
 *  - `stopImmediatePropagation()` skips remaining listeners on this event.
 *    Does NOT prevent default — combine with `preventDefault()` if needed.
 *  - `delay(promise)` blocks the player on the given promise. Multiple delays
 *    compose via `Promise.all`. One rejection = `preventDefault`. Bounded by
 *    `setup({ beforeEventTimeoutMs })` (default 10000 ms).
 */
export interface BeforeEvent<TData> {
	data: TData;
	preventDefault(): void;
	isDefaultPrevented(): boolean;
	stopImmediatePropagation(): void;
	isPropagationStopped(): boolean;
	delay(promise: Promise<unknown>): void;
	isDelayed(): boolean;
}

/**
 * The complete event map that every player built on the kit emits. Consumers
 * use these names with `player.on(name, handler)`. Library-specific maps
 * (e.g. `MusicEventMap`, `VideoEventMap`) extend this with domain-only events
 * and may narrow the payload types for shared events like `repeat` and `shuffle`.
 *
 * Every `before*` event is cancellable (`preventDefault()`), delayable
 * (`delay(promise)`), and stops propagation on request
 * (`stopImmediatePropagation()`). See `BeforeEvent<T>` for the full contract.
 *
 * The generic `I` parameter threads the concrete playlist-item type into every
 * item-bearing event payload. Defaults to `BasePlaylistItem` so existing code
 * that references `BaseEventMap` without a type argument is unchanged.
 */
export interface BaseEventMap<I extends BasePlaylistItem = BasePlaylistItem> {
	// ── Setup lifecycle ───────────────────────────────────────────────────────
	// Ordered sequence: beforeSetup → setupStart → configResolved →
	// pluginsRegistering → pluginsRegistered → streamsReady → authReady →
	// playlistResolving → playlistReady → mediaReady → ready.
	// Each stage has a paired error event; telemetry can localize failures.

	'beforeSetup': void;
	'setupStart': { container: HTMLElement };
	'configResolved': { config: BasePlayerConfig };
	'pluginsRegistering': void;
	'pluginsRegistered': void;
	'streamsReady': void;
	'authReady': void;
	'playlistResolving': { url: string };
	'playlistReady': { length: number };
	'playlistError': { url: string; error: Error; code: string };
	'mediaReady': void;
	'ready': void;

	'setupStartError': PlayerErrorEvent;
	'configResolvedError': PlayerErrorEvent;
	'pluginsRegisteringError': PlayerErrorEvent;
	'pluginsRegisteredError': PlayerErrorEvent;
	'streamsReadyError': PlayerErrorEvent;
	'authReadyError': PlayerErrorEvent;
	'playlistResolveError': PlayerErrorEvent;
	'mediaReadyError': PlayerErrorEvent;

	// ── Play-path lifecycle ───────────────────────────────────────────────────
	// Every before* is cancellable + delayable. A prevented action fires its
	// paired *Prevented event instead of the post-action event.

	'beforePlay': BeforeEvent<ActionOptions>;
	'firstFrame': void;

	/**
	 * Fires when the backend confirms media is actively rendering — equivalent
	 * to the HTML `playing` event (fires after buffering resolves, not just on
	 * `play()` call). Emitted by per-library backend wiring, not by kit transport.
	 * Carries no payload — the signal itself is the notification.
	 */
	'playing': void;
	'playPrevented': { reason: PreventedReason; cause?: unknown };
	'beforePause': BeforeEvent<ActionOptions>;
	'pausePrevented': { reason: PreventedReason; cause?: unknown };
	'beforeStop': BeforeEvent<ActionOptions>;
	'stopPrevented': { reason: PreventedReason; cause?: unknown };
	'beforeNext': BeforeEvent<ActionOptions>;
	'nextPrevented': { reason: PreventedReason; cause?: unknown };
	'beforePrevious': BeforeEvent<ActionOptions>;
	'previousPrevented': { reason: PreventedReason; cause?: unknown };
	'beforeSeek': BeforeEvent<{ time: number; source?: ActionSource }>;
	'seekPrevented': { reason: PreventedReason; cause?: unknown };
	'beforeLoad': BeforeEvent<{ item: I; source?: ActionSource }>;
	'loadPrevented': { reason: PreventedReason; cause?: unknown };

	// ── Phase-aware mutation contract ─────────────────────────────────────────
	// Fires before any state-mutating method. Hot methods opt-in via
	// `setup({ mutationGuards: [...] })`; normal mutations fire by default.
	// `setup({ mutationGuards: false })` disables entirely.
	//
	// `phase` carries the coarse playback state. `dispatchStack` is the chain
	// of currently-dispatching events (innermost last) — empty if the mutation
	// was called from app code, populated if called from inside an event handler.

	'beforeMutation': BeforeEvent<{
		method: string;
		args: ReadonlyArray<unknown>;
		phase: PlayerPhase;
		dispatchStack: ReadonlyArray<string>;
	}>;
	'mutationPrevented': { method: string; reason: PreventedReason; cause?: unknown };

	// ── Phase transitions ─────────────────────────────────────────────────────
	// Fires every time the player moves between phases. Plugins building UI
	// overlays or debug tooling watch this to track coarse playback state.

	'phase': { from: PlayerPhase; to: PlayerPhase };

	// ── Standard transport ────────────────────────────────────────────────────

	'play': ActionOptions;
	'pause': ActionOptions;
	'stop': ActionOptions;
	'next': ActionOptions;
	'previous': ActionOptions;
	'ended': void;
	'seek': { time: number; source?: ActionSource };

	/**
	 * Fires after a seek settles — once the backend has repositioned and
	 * confirmed the new position. `seek` fires at dispatch time (before the
	 * backend moves); `seeked` fires after.
	 */
	'seeked': { time: number };

	/**
	 * Throttled time update — fires at most every `progressIntervalMs`
	 * (default 5000 ms). Use this instead of `time` for server-side
	 * watch-position saves and analytics to avoid per-frame callback noise.
	 */
	'progress': { time: number; duration: number; percentage: number };

	/**
	 * Per-tick playback clock. The payload is the full `TimeState` snapshot —
	 * `time`/`position`, `duration`, `buffered`, `remaining`, `percentage` —
	 * the same shape `timeData()` returns, so listeners never re-derive time
	 * math from getters inside the handler.
	 */
	'time': TimeState;
	'dispose': void;

	/**
	 * Fires before `dispose()` tears the player down. A listener may
	 * `preventDefault()` — e.g. a Connect plugin flushing final playback state
	 * to a remote session before allowing teardown. Prevented calls leave the
	 * player fully alive; `disposePrevented` fires instead of `dispose`.
	 */
	'beforeDispose': BeforeEvent<void>;
	'disposePrevented': { reason: PreventedReason; cause?: unknown };

	// ── Language change ───────────────────────────────────────────────────────
	// Fires after all plugin translation bundles for the new language have
	// settled. `lang` is the BCP-47 tag passed to `player.language(tag)`.

	'language': { lang: string };

	/**
	 * Fires before `language(tag)` switches the active language and loads
	 * plugin translation bundles. A listener may `preventDefault()` to keep
	 * the current language, or mutate `data.lang` to redirect the switch.
	 */
	'beforeLanguage': BeforeEvent<{ lang: string }>;
	'languagePrevented': { reason: PreventedReason; cause?: unknown };

	// ── Volume + mode state ───────────────────────────────────────────────────

	'volume': { level: number };

	/**
	 * Fires before `volume(level)` applies a new level. Fires unconditionally
	 * — independent of `setup({ mutationGuards })` — so a Connect plugin can
	 * reliably intercept volume changes without opting the player into the
	 * generic mutation-guard surface. Internal fade-in ramps (`load({ fadeIn })`)
	 * bypass this hook entirely; they are not user-facing volume commands.
	 */
	'beforeVolume': BeforeEvent<{ level: number }>;
	'volumePrevented': { reason: PreventedReason; cause?: unknown };

	'mute': { muted: boolean };

	/**
	 * Fires before `mute()` or `unmute()` changes the mute state. `data.muted`
	 * carries the target state (`true` for `mute()`, `false` for `unmute()`).
	 * No-ops (already in the target state) never dispatch.
	 */
	'beforeMute': BeforeEvent<{ muted: boolean }>;
	'mutePrevented': { reason: PreventedReason; cause?: unknown };

	'repeat': { state: RepeatState };

	/** Fires before `repeatState(state)` changes the repeat mode. */
	'beforeRepeat': BeforeEvent<{ state: RepeatState }>;
	'repeatPrevented': { reason: PreventedReason; cause?: unknown };

	'shuffle': { state: ShuffleState };

	/**
	 * Fires before `shuffleState(state)` changes the shuffle mode. `data.state`
	 * is already normalised to `ShuffleState` — the boolean shorthand accepted
	 * by `shuffleState()` is resolved before this dispatches.
	 */
	'beforeShuffle': BeforeEvent<{ state: ShuffleState }>;
	'shufflePrevented': { reason: PreventedReason; cause?: unknown };

	'playbackRate': { rate: number };

	/**
	 * Fires before `playbackRate(rate)` applies a new rate. Fires
	 * unconditionally — independent of `setup({ mutationGuards })` — same
	 * rationale as `beforeVolume`. `data.rate` is already clamped to
	 * `[0.25, 2]`.
	 */
	'beforePlaybackRate': BeforeEvent<{ rate: number }>;
	'playbackRatePrevented': { reason: PreventedReason; cause?: unknown };

	// ── Error severity tiers ──────────────────────────────────────────────────
	// `fatal` = unrecoverable; the only thing the kit does is flip the play
	// state to `ERROR`, in `container-class-emit`.
	// `error` = recoverable problem (e.g. `core:resource/playlist-fetch-failed`).
	// `warning` / `info` = observability only.

	'fatal': PlayerErrorEvent;
	'error': PlayerErrorEvent;
	'warning': PlayerErrorEvent;
	'info': PlayerErrorEvent;

	// ── Cursor / item change ──────────────────────────────────────────────────
	// Fires every time the active item pointer moves (load, next, previous,
	// item(target)). `item` is `undefined` when the queue is empty after a clear.

	'item': { item: I | undefined; index: number };

	// ── Queue mutation events ─────────────────────────────────────────────────
	// Re-emitted from the internal MediaList<T> instance whenever the queue
	// structure changes. Subscribe to these for reactive queue UI.

	'queue': I[];
	'queue:append': { items: I[]; from: number };
	'queue:prepend': { items: I[] };
	'queue:insert': { items: I[]; index: number };
	'queue:remove': { id: string | number; index: number; item: I };
	'queue:move': { from: number; to: number };
	'queue:clear': { previousLength: number };
	'queue:shuffle': void;
	'queue:sort': void;

	/**
	 * Fires from `next()` when there is nothing to move to: the end of a
	 * non-repeating queue, or an empty queue under any repeat mode. A track
	 * ending on its own does not reach it, because nothing calls `next()`
	 * without an auto-advance plugin registered.
	 */
	'queue:exhausted': void;

	// ── Backlog / history ─────────────────────────────────────────────────────
	// A separate MediaList<T> the consumer owns. Transport never touches it:
	// `next()` and `previous()` do not reference `_backlogList` at all, so a
	// history is built by calling the backlog methods on `queue.ts` directly.

	'backlog': I[];
	'backlog:append': { items: I[] };
	'backlog:remove': { id: string | number; index: number; item: I };
	'backlog:clear': { previousLength: number };

	// ── Item ending soon ─────────────────────────────────────────────────────
	// Fires once per item, `itemEndingSoonThreshold` seconds before the natural
	// end. The latch resets whenever the cursor changes or a new item loads.
	// Consumers use this to preload the next item, start a crossfade, or display
	// a "coming up next" overlay. `remaining` is seconds left at the moment the
	// threshold was crossed.

	/**
	 * Fires once per item when `remaining <= itemEndingSoonThreshold` (default 10 s).
	 * `item` is the currently-playing item at the moment the threshold was crossed.
	 * The latch resets on each new item so the event fires exactly once per item.
	 */
	'itemEndingSoon': { remaining: number; item: I };

	// ── Duration ──────────────────────────────────────────────────────────────
	// Re-emitted when the backend resolves the total duration of the active
	// item. Useful for UIs that need an up-front "duration ready" signal
	// without polling `timeData()`.

	'duration': { duration: number };

	// ── Backend lifecycle ─────────────────────────────────────────────────────

	'backend:changed': { kind: string };
	'backend:loading': { url: string; kind: string };
	'backend:loaded': { url: string; kind: string; duration: number };
	'backend:error': { error: PlayerErrorEvent['error']; kind: string };
	'backend:stalled': { time: number };
	'backend:ratechange': { rate: number };
	'backend:waiting': void;

	// ── Auth runtime ──────────────────────────────────────────────────────────

	'auth:refreshed': { tokenAcquiredAt: number };
	'auth:failed': { error: PlayerErrorEvent['error'] };

	// ── Stream-level ──────────────────────────────────────────────────────────
	// Re-exposed from the active IStreamSource so consumers don't need to reach
	// into the backend to observe manifest / fragment / encryption events.

	'stream:manifest-loaded': { url: string };
	'stream:level-switched': { level: number; label: string };
	'stream:fragment-loaded': { url: string; durationMs: number };
	'stream:level-considered': { candidate: number; decided: number; reason: string };
	'stream:error': { details: string; fatal: boolean };
	'stream:encrypted': { initData: ArrayBuffer; initDataType: string };

	// ── Cue tracker ───────────────────────────────────────────────────────────

	'cue:enter': CueEventPayload;
	'cue:exit': CueEventPayload;

	// ── Subtitle cue stream ───────────────────────────────────────────────────
	// Unified across sidecar VTT (kit-driven) and native HLS / MSE / WebCodecs
	// text tracks (backend-driven). Fires on every cuechange / enter+exit
	// boundary; `cues: []` means between cues or subtitles disabled.

	'subtitleCue': SubtitleCueChange;

	// ── Subtitle styling ──────────────────────────────────────────────────────
	// Written by `player.subtitleStyle({...})`, read by overlay renderers and
	// settings menus. The merged record is emitted so subscribers don't need
	// to re-fetch via the getter.

	'subtitleStyle': SubtitleStyle;
	'subtitle': { track: number | null };

	/**
	 * Fires before `subtitle(idx)` changes the active subtitle track.
	 * `data.track` mirrors the setter argument — `null` (or negative) disables
	 * subtitles.
	 */
	'beforeSubtitle': BeforeEvent<{ track: number | null }>;
	'subtitlePrevented': { reason: PreventedReason; cause?: unknown };

	/**
	 * Fires when `addSubtitleTrack()` or `removeSubtitleTrack()` changes the
	 * sidecar subtitle set on the active item. Carries the full merged list
	 * (backend + sidecar, same shape as `subtitles()`) so a subscribed menu
	 * redraws without a separate `subtitles()` call.
	 */
	'subtitles': { tracks: ReadonlyArray<SubtitleTrack> };

	// ── Audio track selection ─────────────────────────────────────────────────
	// Emitted by `audioTrack(idx)`. `id` follows the kit's
	// `audioTracks()` index space so consumers don't need to re-resolve.

	'audioTrack': { id: number | null };

	/** Fires before `audioTrack(idx)` changes the active audio track. */
	'beforeAudioTrack': BeforeEvent<{ id: number }>;
	'audioTrackPrevented': { reason: PreventedReason; cause?: unknown };

	// ── Chapter events ────────────────────────────────────────────────────────
	// `chapter` — emitted by `seekToChapter`. `index` is zero-based; `title`
	//   is the chapter's display name.
	// `chapters` — emitted after the chapter list is resolved from a sidecar
	//   VTT for the active item. Subscribe here instead of polling `chapters()`.

	'chapter': { index: number; title: string };
	'chapters': { chapters: ReadonlyArray<Chapter> };

	// ── Cast / handoff state ──────────────────────────────────────────────────
	// Emitted by `transferTo()` on every state transition. Mirrors the return
	// value of `castState()` for reactive subscriptions.

	'castState': { state: CastState };

	/**
	 * Fires before `transferTo(target)` hands playback off to a remote target
	 * (or pulls it back to local). The Connect-critical device-handoff hook —
	 * a plugin may `preventDefault()` to block a handoff (e.g. DRM-restricted
	 * content) or `delay()` while confirming the remote device is reachable.
	 * Named `beforeTransfer` (not `beforeCastState`) because `castState` is the
	 * state *notification*; `transferTo` is the action.
	 */
	'beforeTransfer': BeforeEvent<{ target: CastTarget }>;
	'transferPrevented': { reason: PreventedReason; cause?: unknown };

	// ── Shared state-enum change events ───────────────────────────────────────
	// Emitted by both music and video players. Typed as string unions so
	// library-local enum values (which have identical string forms) are
	// assignable without importing library types into the kit.

	'qualityState': { state: 'auto' | 'manual' };
	'audioTrackState': { state: 'default' | 'manual' };

	// ── HLS adaptive level switch ─────────────────────────────────────────────
	// Emitted by stream parsers and forwarded by the video backend. `level` is
	// the variant index in the manifest's level list; use `qualityLevels()` to
	// look up the metadata for that index.

	'level-switched': { level: number };

	// ── Plugin lifecycle channel ──────────────────────────────────────────────

	'plugin:installed': { id: string; version: string };
	'plugin:enabled': { id: string };
	'plugin:disabled': { id: string; reason?: string };
	'plugin:opts:changed': { id: string; opts: unknown };
	'plugin:disposed': { id: string };
	'plugin:failed': { id: string; error: PlayerErrorEvent['error'] };
	'plugin:error': PlayerErrorEvent;
	'plugin:warning': PlayerErrorEvent;

	// ── Network / visibility / connectivity ───────────────────────────────────

	'network:online': void;
	'network:offline': void;

	/**
	 * Fires when a network transition reveals a slow connection: online but
	 * downlink < 1.5 Mbps. `rttMs` is `undefined` when the Network Information
	 * API is unavailable (Firefox, Safari). Only fires when the condition
	 * transitions from not-slow to slow — not on every heartbeat.
	 */
	'network:slow': { rttMs: number | undefined };
	'visibility:visible': void;
	'visibility:hidden': void;

	// ── Performance metrics ───────────────────────────────────────────────────

	'playback:metrics': PlaybackMetrics;

	/** Fetch lifecycle — observability for loading UI / telemetry. */
	'fetch:start': { url: string; pluginId?: string };
	'fetch:retry': { url: string; attempt: number; reason: 'unauthenticated' | 'http-5xx' | 'timeout' | 'network'; delayMs: number; pluginId?: string };
	'fetch:complete': { url: string; ok: boolean; status?: number; durationMs: number; pluginId?: string };

	/**
	 * User activity state change. `active: true` when the user moves the
	 * pointer, touches the screen, or presses a key; `active: false` after the
	 * `inactivityMs` timeout while playing. Emitted by the player's own
	 * activity tracker (see `bumpActivity()` / `activityTracking()`); the
	 * container's `.active` / `.inactive` classes follow it automatically, so
	 * UI show / hide is plain CSS. A UI plugin with a richer state machine can
	 * take over emission via `activityTracking(false)`.
	 */
	'activity': { active: boolean };

	/**
	 * Fires whenever the listener count for a named event changes. Useful for
	 * devtools that want to track which events are being observed.
	 */
	'listeners-changed': { name: string; count: number };

	// ── Preload lifecycle ─────────────────────────────────────────────────────
	// Emitted by the generic preload orchestration in `preloadMethods`.

	/** The player began prefetching assets for the next item. */
	'preloadStart': { item: I; assets: ReadonlyArray<{ url: string; category: string }> };

	/** An individual preload asset completed or failed — progress update. */
	'preloadProgress': { item: I; loaded: number; total: number };

	/** All queued preload assets have been fetched successfully. */
	'preloadComplete': { item: I };

	/** One or more preload assets could not be fetched (non-fatal). */
	'preloadError': { item: I; error: unknown };

	// ── Transition lifecycle ──────────────────────────────────────────────────

	/** The transition window has begun (outgoing fading, incoming starting). */
	'transitionStart': { outgoing: I; incoming: I };

	/**
	 * Per-frame progress during the transition window.
	 * `fraction` is [0..1] — 0 at transition start, 1 at completion.
	 */
	'transitionProgress': { outgoing: I; incoming: I; fraction: number };

	/** The transition completed — incoming is now primary. */
	'transitionComplete': { from: I; to: I };

	/** The transition was aborted before it could complete. */
	'transitionCancelled': { reason: string };
}
