// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type { BaseEventMap, IPlayer } from '../../types';
import { Plugin } from '../../core/plugin';

/**
 * Map of keyboard combo strings to player action callbacks.
 *
 * Keys are combo strings such as `'Space'`, `'ArrowLeft'`, `'shift+ArrowLeft'`,
 * `'ctrl+k'`. Values receive the player instance so they can call any public
 * method directly, and the `KeyboardEvent` so they can call `preventDefault()`
 * on keys the browser also acts on.
 */
export type KeyBindings<P> = Record<string, (player: P, keyboardEvent: KeyboardEvent) => void>;

/** Options for {@link KeyHandlerPlugin}. */
export interface KeyHandlerOptions<P> {
	/**
	 * Where the `keydown` event listener is attached.
	 *
	 * - `'document'` — listens globally. Catches keys anywhere in the page,
	 *   including when no player element is focused. Default.
	 * - `'container'` — listens only on the player's container element. Keys
	 *   only fire when the container or a child has focus.
	 * - `HTMLElement` — listens on the supplied element directly.
	 */
	scope?: 'document' | 'container' | HTMLElement;

	/**
	 * Extra bindings merged on top of the default group bindings. Each key is a
	 * combo string; the value is a `(player, keyboardEvent) => void` callback. When the same
	 * combo appears in both defaults and here, this map wins.
	 */
	bindings?: KeyBindings<P>;

	/**
	 * Controls whether default bindings (Space, Arrow*, m) are kept.
	 *
	 * - `true` — defaults are installed, then `opts.bindings` is merged on top.
	 *   This is the default behaviour.
	 * - `false` — defaults are cleared before `opts.bindings` is applied. Use
	 *   this to build a fully custom binding set from scratch.
	 */
	extend?: boolean;

	/**
	 * Optional gate predicate. Called before any binding fires. Return `false`
	 * to suppress all key handling for that event — useful for disabling
	 * shortcuts during modals, chat overlays, or other UI states.
	 */
	when?: (keyboardEvent: KeyboardEvent) => boolean;

	/**
	 * Minimum milliseconds between consecutive fires of the same (or any) key.
	 * Prevents rapid-fire seeks or volume changes from a held key. Default `300`.
	 * Set to `0` to disable throttling.
	 */
	cooldownMs?: number;

	/**
	 * When `true`, the W3C hardware media keys installed by `addMediaKeys()`
	 * (`MediaPlay`, `MediaPause`, `MediaPlayPause`, `MediaStop`, `MediaRewind`,
	 * `MediaFastForward`, `MediaTrackNext`, `MediaTrackPrevious`) are silently
	 * ignored. Use this to prevent OS-level media key interception on shared
	 * pages where another player or the OS should own those keys.
	 *
	 * Default: `false` (media keys are active).
	 */
	disableMediaControls?: boolean;
}

/**
 * Keyboard-binding router. Attaches a single `keydown` listener to the
 * configured scope and dispatches events to registered combo callbacks.
 *
 * **Default bindings** installed by the base class:
 * | Combo | Action |
 * |-------|--------|
 * | `Space` | `player.togglePlayback()` |
 * | `ArrowLeft` | `player.rewind(5)` |
 * | `ArrowRight` | `player.forward(5)` |
 * | `ArrowUp` | `player.volumeUp()` |
 * | `ArrowDown` | `player.volumeDown()` |
 * | `m` | `player.toggleMute()` |
 * | `MediaPlay` | `player.play()` (gated on `opts.disableMediaControls`) |
 * | `MediaPause` | `player.pause()` (gated) |
 * | `MediaPlayPause` | `player.togglePlayback()` (gated) |
 * | `MediaStop` | `player.stop()` or `player.pause()` (gated) |
 * | `MediaRewind` | `player.rewind(5)` (gated) |
 * | `MediaFastForward` | `player.forward(5)` (gated) |
 * | `MediaTrackNext` | `player.next?.()` (gated) |
 * | `MediaTrackPrevious` | `player.previous?.()` (gated) |
 *
 * **Extension layers** (in order of evaluation):
 * 1. `opts.bindings` merged at setup — runs once during `use()`.
 * 2. `opts.extend: false` clears defaults before that merge.
 * 3. Runtime mutation via `bind()`, `unbind()`, `replace()`.
 * 4. Subclass overrides of the `addPlaybackKeys()`, `addNavigationKeys()`,
 *    `addVolumeKeys()`, `addMediaKeys()` group methods.
 *
 * **Suppression:** keys silently no-op when the event target is an `<input>`,
 * `<textarea>`, `<select>`, or any `contenteditable` element, and when
 * `opts.when` returns `false`.
 *
 * Subclasses can override any `addX()` group to replace the defaults for that
 * group without touching the others.
 */
export class KeyHandlerPlugin<P extends IPlayer<BaseEventMap> = IPlayer> extends Plugin<P, KeyHandlerOptions<P>> {
	static override readonly id: string = 'key-handler';
	static override readonly version: string = '2.0.0';
	static override readonly description: string = 'Keyboard binding router with overridable group methods';

	private _bindings: Map<string, (keyboardEvent: KeyboardEvent) => void> = new Map();
	private lastFireAt: number = 0;

	/**
	 * Parse a combo string like `'shift+ArrowLeft'`, `'ctrl+arrowright'`,
	 * `'alt+arrowleft'`, `'+'`, `'shift++'` into a canonical map key.
	 *
	 * Rules:
	 *  - Modifier prefixes are case-insensitive: `alt+`, `ctrl+`, `shift+`.
	 *  - Modifiers are folded to a stable order in the result: `alt`, `ctrl`, `shift`.
	 *  - The KEY (last segment) is lowercased when length === 1, otherwise kept.
	 *    `'P'` → `'p'`, `'ArrowLeft'` → `'ArrowLeft'`.
	 *  - Trailing `+` is preserved as the key — `'+'` and `'shift++'` parse cleanly.
	 *  - A combo without modifiers fires only when NO modifiers are held — a
	 *    `'shift+ArrowLeft'` and `'ArrowLeft'` are independent bindings.
	 */
	private static readonly COMBO_MOD_RE = /^(alt|ctrl|shift)\+/i;

	private parseCombo(combo: string): { key: string; mods: { alt: boolean; ctrl: boolean; shift: boolean } } {
		const mods = {
			alt: false,
			ctrl: false,
			shift: false,
		};
		let remainder = combo;
		while (true) {
			const modMatch = KeyHandlerPlugin.COMBO_MOD_RE.exec(remainder);
			if (!modMatch)
				break;
			const tag = modMatch[1]!.toLowerCase() as 'alt' | 'ctrl' | 'shift';
			mods[tag] = true;
			remainder = remainder.slice(modMatch[0]!.length);
		}
		return {
			// `KeyboardEvent.key` for the spacebar is a single space, so a binding
			// written as `'Space'` matched nothing and failed silently. Both spellings
			// resolve to the same slot; `'Space'` is the one people reach for, and the
			// one every shortcuts overlay shows.
			key: remainder === 'Space' ? ' ' : remainder,
			mods,
		};
	}

	private canonicalKey(key: string, mods: { alt: boolean; ctrl: boolean; shift: boolean }): string {
		const parts: string[] = [];
		if (mods.alt)
			parts.push('alt');
		if (mods.ctrl)
			parts.push('ctrl');
		if (mods.shift)
			parts.push('shift');
		const normalizedKey = key.length === 1 ? key.toLowerCase() : key;
		return parts.length ? `${parts.join('+')}+${normalizedKey}` : normalizedKey;
	}

	/**
	 * Installs the default binding groups, applies `opts.bindings`, then attaches
	 * the `keydown` listener to the resolved scope target.
	 *
	 * The listener is automatically removed when the plugin disposes — no manual
	 * teardown is needed.
	 */
	override use(): void {
		this.addDefaults();
		this.applyOptions();

		const target = this.scope();
		this.listen(target, 'keydown', this.handleKeydown as EventListener);
	}

	/**
	 * Register a handler for a keyboard combo string.
	 *
	 * ```ts
	 * keyHandler.bind('shift+ArrowLeft', (player) => player.rewind(30));
	 * keyHandler.bind('Space', (player, event) => {
	 *   event.preventDefault();
	 *   player.togglePlayback();
	 * });
	 * ```
	 *
	 * Registering the same combo again replaces the previous handler. Combo
	 * strings are normalised before storage — `'Shift+arrowleft'` and
	 * `'shift+ArrowLeft'` resolve to the same entry.
	 */
	bind(combo: string, fn: (player: P, keyboardEvent: KeyboardEvent) => void): void {
		this._bindings.set(this.normalizeCombo(combo), (keyboardEvent: KeyboardEvent) => fn(this.player, keyboardEvent));
	}

	/**
	 * Remove the handler for the given combo string. No-ops when the combo is
	 * not in the current binding map.
	 */
	unbind(combo: string): void {
		this._bindings.delete(this.normalizeCombo(combo));
	}

	/**
	 * Replace an existing binding with a new handler. Equivalent to `bind()` —
	 * provided as a semantic alias for callers that want to communicate intent
	 * (swapping, not adding).
	 */
	replace(combo: string, fn: (player: P, keyboardEvent: KeyboardEvent) => void): void {
		this.bind(combo, fn);
	}

	/**
	 * Returns a read-only snapshot of the active binding map. The returned
	 * `Map` values are `(player) => void` wrappers — mutation of the snapshot
	 * does not affect the live binding table.
	 */
	bindings(): ReadonlyMap<string, (player: P) => void> {
		const out = new Map<string, (player: P) => void>();
		for (const key of this._bindings.keys()) {
			out.set(key, (player: P) => {
				const handler = this._bindings.get(key);
				if (handler)
					handler(new KeyboardEvent('keydown', { key }));
				void player;
			});
		}
		return out;
	}

	/**
	 * Returns the `EventTarget` that the `keydown` listener is (or will be)
	 * attached to, based on `opts.scope`.
	 *
	 * Falls back to `document` when no scope is set or the player has no
	 * container. Returns a no-op `EventTarget` in non-DOM environments.
	 */
	scope(): EventTarget {
		const opt = this.opts?.scope;
		if (opt instanceof EventTarget)
			return opt;
		if (opt === 'container') {
			const container = this.player.container;
			if (container)
				return container;
		}
		if (typeof document !== 'undefined')
			return document;

		// Non-DOM environments (e.g. Node test runners) — return a no-op target.
		return new EventTarget();
	}

	/**
	 * Apply user-supplied `opts.bindings` after defaults. When `opts.extend` is
	 * `false`, the default bindings are cleared first. Called by `use()`.
	 */
	protected applyOptions(): void {
		const opts = this.opts ?? {};
		if (opts.extend === false)
			this._bindings.clear();

		const userBindings = opts.bindings;
		if (userBindings) {
			for (const [key, fn] of Object.entries(userBindings)) {
				this.bind(key, fn);
			}
		}
	}

	/**
	 * Calls all `addX()` group methods in order. Override individual group
	 * methods rather than this hook when you only want to change a subset of
	 * defaults.
	 */
	protected addDefaults(): void {
		this.addPlaybackKeys();
		this.addNavigationKeys();
		this.addVolumeKeys();
		this.addMediaKeys();
	}

	/** Installs `Space → togglePlayback()`. Override to change the play/pause key. */
	protected addPlaybackKeys(): void {
		this.bind(' ', () => {
			void this.player.togglePlayback?.();
		});
	}

	/** Installs `ArrowLeft → rewind(5)` and `ArrowRight → forward(5)`. */
	protected addNavigationKeys(): void {
		this.bind('ArrowLeft', () => {
			this.player.rewind?.(5);
		});
		this.bind('ArrowRight', () => {
			this.player.forward?.(5);
		});
	}

	/** Installs `ArrowUp → volumeUp()`, `ArrowDown → volumeDown()`, `m → toggleMute()`. */
	protected addVolumeKeys(): void {
		this.bind('ArrowUp', () => {
			this.player.volumeUp?.();
		});
		this.bind('ArrowDown', () => {
			this.player.volumeDown?.();
		});
		this.bind('m', () => {
			this.player.toggleMute?.();
		});
	}

	/**
	 * Installs the W3C hardware media keys that fire from physical media keys,
	 * Bluetooth headphone controls, and most TV remotes. All eight bindings
	 * silently no-op when `opts.disableMediaControls` is `true`.
	 *
	 * | Key | Action |
	 * |---|---|
	 * | `MediaPlay` | `player.play()` |
	 * | `MediaPause` | `player.pause()` |
	 * | `MediaPlayPause` | `player.togglePlayback()` |
	 * | `MediaStop` | `player.stop()` (falls back to `pause()`) |
	 * | `MediaRewind` | `player.rewind(5)` |
	 * | `MediaFastForward` | `player.forward(5)` |
	 * | `MediaTrackNext` | `player.next?.()` |
	 * | `MediaTrackPrevious` | `player.previous?.()` |
	 */
	protected addMediaKeys(): void {
		this.bind('MediaPlay', () => {
			if (this.opts?.disableMediaControls)
				return;
			void this.player.play?.();
		});
		this.bind('MediaPause', () => {
			if (this.opts?.disableMediaControls)
				return;
			void this.player.pause?.();
		});
		this.bind('MediaPlayPause', () => {
			if (this.opts?.disableMediaControls)
				return;
			void this.player.togglePlayback?.();
		});
		this.bind('MediaStop', () => {
			if (this.opts?.disableMediaControls)
				return;
			void (this.player.stop ?? this.player.pause)?.();
		});
		this.bind('MediaRewind', () => {
			if (this.opts?.disableMediaControls)
				return;
			this.player.rewind?.(5);
		});
		this.bind('MediaFastForward', () => {
			if (this.opts?.disableMediaControls)
				return;
			this.player.forward?.(5);
		});
		this.bind('MediaTrackNext', () => {
			if (this.opts?.disableMediaControls)
				return;
			void this.player.next?.();
		});
		this.bind('MediaTrackPrevious', () => {
			if (this.opts?.disableMediaControls)
				return;
			void this.player.previous?.();
		});
	}

	/** Alias for `addDefaults()`. */
	protected defaultBindings(): void {
		this.addDefaults();
	}

	private normalizeCombo(combo: string): string {
		const { key, mods } = this.parseCombo(combo);
		return this.canonicalKey(key, mods);
	}

	private readonly handleKeydown = (event: Event): void => {
		const ev = event as KeyboardEvent;
		if (!this.enabled())
			return;
		if (this.isTypingTarget(ev.target))
			return;

		const when = this.opts?.when;
		if (typeof when === 'function' && !when(ev))
			return;

		const cooldown = this.opts?.cooldownMs ?? 300;
		const now = Date.now();
		if (cooldown > 0 && now - this.lastFireAt < cooldown)
			return;

		const canonical = this.canonicalKey(ev.key, {
			alt: ev.altKey,
			ctrl: ev.ctrlKey,
			shift: ev.shiftKey,
		});
		const handler = this._bindings.get(canonical);
		if (!handler)
			return;

		this.lastFireAt = now;
		handler(ev);
	};

	private isTypingTarget(target: EventTarget | null): boolean {
		if (!target || !(target instanceof Element))
			return false;
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT')
			return true;
		if ((target as HTMLElement).isContentEditable)
			return true;
		return false;
	}
}

/** Plugin alias for {@link KeyHandlerPlugin}. Pass to `addPlugin(keyHandlerPlugin)`. */
export const keyHandlerPlugin = KeyHandlerPlugin;
