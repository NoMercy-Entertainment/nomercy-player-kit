// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * Deep behavioral tests for `KeyHandlerPlugin`.
 *
 * The existing media-session-and-key-handler.test.ts covers: bind/unbind,
 * typing-target suppression, default binding set, hardware media keys map,
 * disableMediaControls option.
 *
 * This file covers the remaining ~52 uncovered lines:
 *  - replace() — semantic alias for bind()
 *  - bindings() snapshot is independent of live map
 *  - opts.extend: false clears defaults before user bindings apply
 *  - opts.bindings merged on top of defaults
 *  - opts.when predicate gates all key handling
 *  - opts.cooldownMs throttles rapid-fire keys
 *  - scope: 'container' binds to container element
 *  - scope: HTMLElement binds to that element
 *  - scope() returns EventTarget (document fallback)
 *  - parseCombo canonical key normalisation (modifier order, case folding)
 *  - contenteditable targets are suppressed
 *  - <select> targets are suppressed
 *  - <textarea> targets are suppressed
 *  - media key actions call the correct player methods
 *  - player.rewind / forward / volumeUp / volumeDown / toggleMute are invoked
 */

import type { BaseEventMap } from '../../types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	composeMixins,
	EventEmitter,
	initPlayerCoreState,
	playerCoreMethods,
	resolvePlayerConstructor,
} from '../../index';
import { KeyHandlerPlugin } from '../../plugins/key-handler';

const _instances = new Map<string, MockPlayer>();

class MockPlayer extends EventEmitter<BaseEventMap> {
	readonly playerId: string = '';
	container: HTMLElement = {} as HTMLElement;

	get id(): string { return this.playerId; }

	declare options: (config?: unknown) => unknown;
	declare setup: (config: unknown) => this;
	declare ready: () => Promise<void>;
	declare dispose: () => void;
	declare phase: () => string;
	declare addPlugin: (PluginClass: unknown, opts?: unknown) => this;
	declare getPlugin: (PluginClass: unknown) => unknown;
	declare getPluginById: (id: string) => unknown;
	declare removePlugin: (PluginClass: unknown) => void;
	declare removePluginById: (id: string) => void;
	declare plugins: () => ReadonlyArray<unknown>;
	declare enabledPlugins: () => ReadonlyArray<unknown>;
	declare play: (opts?: unknown) => Promise<void>;
	declare pause: (opts?: unknown) => Promise<void>;
	declare stop: (opts?: unknown) => Promise<void>;
	declare togglePlayback: (opts?: unknown) => Promise<void>;
	declare t: (key: string, vars?: Record<string, string>) => string;
	declare time: { (): number; (seconds: number, opts?: unknown): Promise<void> };
	declare volume: { (): number; (level: number): void };
	declare experimental: unknown;

	constructor(id?: string | number) {
		super();
		initPlayerCoreState(this, { className: 'MockPlayer' });
		const resolved = resolvePlayerConstructor(id, _instances, 'MockPlayer');
		if (resolved.kind === 'existing')
			return resolved.instance as unknown as this;
		(this as { playerId: string }).playerId = resolved.id;
		this.container = resolved.div;
		_instances.set(resolved.id, this);
	}

	static _reset(): void { _instances.clear(); }
}

composeMixins(MockPlayer.prototype, ...playerCoreMethods);

function makePlayer(divId: string): MockPlayer {
	const div = document.createElement('div');
	div.id = divId;
	document.body.appendChild(div);
	return new MockPlayer(divId);
}

function dispatch(key: string, opts: { altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; target?: EventTarget } = {}): void {
	const ev = new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		altKey: opts.altKey ?? false,
		ctrlKey: opts.ctrlKey ?? false,
		shiftKey: opts.shiftKey ?? false,
	});
	(opts.target ?? document).dispatchEvent(ev);
}

describe('KeyHandlerPlugin — deep behavioral coverage', () => {
	beforeEach(() => MockPlayer._reset());
	afterEach(() => {
		MockPlayer._reset();
		document.body.innerHTML = '';
	});

	// ── replace() ─────────────────────────────────────────────────────────────

	it('replace() is equivalent to bind() — replaces handler for the same combo', async () => {
		const mockPlayer = makePlayer('kh-replace-1').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const fn1 = vi.fn();
		const fn2 = vi.fn();
		inst.bind('g', fn1);
		inst.replace('g', fn2);
		dispatch('g');

		expect(fn2).toHaveBeenCalledOnce();
		expect(fn1).not.toHaveBeenCalled();
	});

	// ── bindings() snapshot ───────────────────────────────────────────────────

	it('bindings() returns a snapshot — mutating it does not affect live binding table', async () => {
		const mockPlayer = makePlayer('kh-snapshot-1').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const snapshot = inst.bindings();
		(snapshot as Map<string, unknown>).delete(' ');

		// Live binding table still has Space.
		expect(inst.bindings().has(' ')).toBe(true);
	});

	// ── opts.extend: false ────────────────────────────────────────────────────

	it('opts.extend: false clears defaults; only user bindings survive', async () => {
		const mockPlayer = makePlayer('kh-extend-false-1').setup({});
		const custom = vi.fn();
		mockPlayer.addPlugin(KeyHandlerPlugin, {
			extend: false,
			bindings: { x: custom },
		});
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const map = inst.bindings();
		expect(map.has(' ')).toBe(false);
		expect(map.has('x')).toBe(true);

		dispatch('x');
		expect(custom).toHaveBeenCalledOnce();
	});

	// ── opts.bindings merged on top ────────────────────────────────────────────

	it('opts.bindings wins over defaults for the same combo', async () => {
		const mockPlayer = makePlayer('kh-opts-bindings-1').setup({});
		const customSpace = vi.fn();
		mockPlayer.addPlugin(KeyHandlerPlugin, {
			bindings: { ' ': customSpace },
		});
		await mockPlayer.ready();

		dispatch(' ');
		expect(customSpace).toHaveBeenCalledOnce();
	});

	// ── opts.when predicate ────────────────────────────────────────────────────

	it('opts.when returning false suppresses all key handling', async () => {
		const mockPlayer = makePlayer('kh-when-1').setup({});
		const whenFn = vi.fn(() => false);
		mockPlayer.addPlugin(KeyHandlerPlugin, { when: whenFn });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const handler = vi.fn();
		inst.bind('q', handler);
		dispatch('q');

		expect(whenFn).toHaveBeenCalled();
		expect(handler).not.toHaveBeenCalled();
	});

	it('opts.when returning true allows key handling', async () => {
		const mockPlayer = makePlayer('kh-when-2').setup({});
		const whenFn = vi.fn(() => true);
		mockPlayer.addPlugin(KeyHandlerPlugin, { when: whenFn });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const handler = vi.fn();
		inst.bind('q', handler);
		dispatch('q');

		expect(handler).toHaveBeenCalledOnce();
	});

	// ── opts.cooldownMs ────────────────────────────────────────────────────────

	it('opts.cooldownMs: 0 disables throttling — consecutive fires pass through', async () => {
		const mockPlayer = makePlayer('kh-cooldown-0').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const handler = vi.fn();
		inst.bind('q', handler);
		dispatch('q');
		dispatch('q');
		dispatch('q');

		expect(handler).toHaveBeenCalledTimes(3);
	});

	it('default cooldownMs 300 throttles rapid-fire keys', async () => {
		vi.useFakeTimers();
		const mockPlayer = makePlayer('kh-cooldown-default').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const handler = vi.fn();
		inst.bind('q', handler);

		dispatch('q'); // fires
		dispatch('q'); // throttled — < 300ms since last fire
		dispatch('q'); // throttled

		expect(handler).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(300);
		dispatch('q'); // fires again after cooldown
		expect(handler).toHaveBeenCalledTimes(2);

		vi.useRealTimers();
	});

	// ── scope: 'container' ────────────────────────────────────────────────────

	it('scope: "container" attaches listener to container element', async () => {
		const mockPlayer = makePlayer('kh-scope-container').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { scope: 'container' });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		expect(inst.scope()).toBe(mockPlayer.container);
	});

	// ── scope: HTMLElement ────────────────────────────────────────────────────

	it('scope: HTMLElement attaches listener to the given element', async () => {
		const customEl = document.createElement('div');
		document.body.appendChild(customEl);

		const mockPlayer = makePlayer('kh-scope-el').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { scope: customEl });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		// Verify behavior: handler fires when the event is dispatched on customEl.
		const handler = vi.fn();
		inst.bind('h', handler);

		const ev = new KeyboardEvent('keydown', { key: 'h', bubbles: true });
		customEl.dispatchEvent(ev);

		expect(handler).toHaveBeenCalledOnce();
	});

	// ── combo normalisation ────────────────────────────────────────────────────

	it('modifier order is canonical — shift+ctrl+k and ctrl+shift+k resolve the same', async () => {
		const mockPlayer = makePlayer('kh-combo-1').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { extend: false, bindings: {} });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const fn = vi.fn();
		inst.bind('shift+ctrl+k', fn);

		const ev = new KeyboardEvent('keydown', {
			key: 'k',
			ctrlKey: true,
			shiftKey: true,
			bubbles: true,
		});
		document.dispatchEvent(ev);

		expect(fn).toHaveBeenCalledOnce();
	});

	it('single-character keys are lowercased in canonical form', async () => {
		const mockPlayer = makePlayer('kh-combo-lower').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { extend: false });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const fn = vi.fn();
		inst.bind('P', fn);

		dispatch('p');
		expect(fn).toHaveBeenCalledOnce();
	});

	// ── typing target suppression ──────────────────────────────────────────────

	it('suppresses keys from <textarea> targets', async () => {
		const mockPlayer = makePlayer('kh-textarea').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const fn = vi.fn();
		inst.bind('p', fn);

		const ta = document.createElement('textarea');
		document.body.appendChild(ta);
		dispatch('p', { target: ta });
		expect(fn).not.toHaveBeenCalled();
	});

	it('suppresses keys from <select> targets', async () => {
		const mockPlayer = makePlayer('kh-select').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const fn = vi.fn();
		inst.bind('p', fn);

		const sel = document.createElement('select');
		document.body.appendChild(sel);
		dispatch('p', { target: sel });
		expect(fn).not.toHaveBeenCalled();
	});

	it('suppresses keys from contenteditable elements', async () => {
		const mockPlayer = makePlayer('kh-contenteditable').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();
		const inst = mockPlayer.getPluginById('key-handler') as KeyHandlerPlugin;

		const fn = vi.fn();
		inst.bind('p', fn);

		const div = document.createElement('div');
		div.contentEditable = 'true';
		document.body.appendChild(div);
		dispatch('p', { target: div });
		expect(fn).not.toHaveBeenCalled();
	});

	// ── default bindings trigger player methods ───────────────────────────────

	it('Space calls player.togglePlayback()', async () => {
		const mockPlayer = makePlayer('kh-space').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();

		const toggleFn = vi.fn(() => Promise.resolve());
		mockPlayer.togglePlayback = toggleFn;

		dispatch(' ');
		expect(toggleFn).toHaveBeenCalledOnce();
	});

	// The docs, the shipped shortcuts overlay and every reader write the play/pause
	// key as 'Space'. `KeyboardEvent.key` for the spacebar is a single space, so that
	// binding silently matched nothing and no error said so. Both spellings now land
	// on the same slot.
	it('a binding written as Space answers the spacebar', async () => {
		const spaceFn = vi.fn();
		const mockPlayer = makePlayer('kh-space-alias').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { bindings: { Space: spaceFn } });
		await mockPlayer.ready();

		dispatch(' ');
		expect(spaceFn).toHaveBeenCalledOnce();
	});

	it('ArrowLeft calls player.rewind(5)', async () => {
		const mockPlayer = makePlayer('kh-arrowleft').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();

		const rewindFn = vi.fn();
		(mockPlayer as MockPlayer & { rewind: (secs: number) => void }).rewind = rewindFn;

		dispatch('ArrowLeft');
		expect(rewindFn).toHaveBeenCalledWith(5);
	});

	it('ArrowRight calls player.forward(5)', async () => {
		const mockPlayer = makePlayer('kh-arrowright').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();

		const forwardFn = vi.fn();
		(mockPlayer as MockPlayer & { forward: (secs: number) => void }).forward = forwardFn;

		dispatch('ArrowRight');
		expect(forwardFn).toHaveBeenCalledWith(5);
	});

	it('ArrowUp calls player.volumeUp()', async () => {
		const mockPlayer = makePlayer('kh-arrowup').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();

		const volumeUpFn = vi.fn();
		(mockPlayer as MockPlayer & { volumeUp: () => void }).volumeUp = volumeUpFn;

		dispatch('ArrowUp');
		expect(volumeUpFn).toHaveBeenCalledOnce();
	});

	it('ArrowDown calls player.volumeDown()', async () => {
		const mockPlayer = makePlayer('kh-arrowdown').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();

		const volumeDownFn = vi.fn();
		(mockPlayer as MockPlayer & { volumeDown: () => void }).volumeDown = volumeDownFn;

		dispatch('ArrowDown');
		expect(volumeDownFn).toHaveBeenCalledOnce();
	});

	it('m calls player.toggleMute()', async () => {
		const mockPlayer = makePlayer('kh-m').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin);
		await mockPlayer.ready();

		const toggleMuteFn = vi.fn();
		(mockPlayer as MockPlayer & { toggleMute: () => void }).toggleMute = toggleMuteFn;

		dispatch('m');
		expect(toggleMuteFn).toHaveBeenCalledOnce();
	});

	it('MediaPlay calls player.play() when disableMediaControls is false', async () => {
		const mockPlayer = makePlayer('kh-mediaplay').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();

		const playFn = vi.fn(() => Promise.resolve());
		mockPlayer.play = playFn;

		dispatch('MediaPlay');
		expect(playFn).toHaveBeenCalledOnce();
	});

	it('MediaPause calls player.pause() when disableMediaControls is false', async () => {
		const mockPlayer = makePlayer('kh-mediapause').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();

		const pauseFn = vi.fn(() => Promise.resolve());
		mockPlayer.pause = pauseFn;

		dispatch('MediaPause');
		expect(pauseFn).toHaveBeenCalledOnce();
	});

	it('MediaTrackNext calls player.next?.()', async () => {
		const mockPlayer = makePlayer('kh-tracknext').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();

		const nextFn = vi.fn(() => Promise.resolve());
		(mockPlayer as MockPlayer & { next: () => Promise<void> }).next = nextFn;

		dispatch('MediaTrackNext');
		expect(nextFn).toHaveBeenCalledOnce();
	});

	it('MediaTrackPrevious calls player.previous?.()', async () => {
		const mockPlayer = makePlayer('kh-trackprev').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();

		const prevFn = vi.fn(() => Promise.resolve());
		(mockPlayer as MockPlayer & { previous: () => Promise<void> }).previous = prevFn;

		dispatch('MediaTrackPrevious');
		expect(prevFn).toHaveBeenCalledOnce();
	});

	it('hands the KeyboardEvent to a binding so it can stop the browser default', async () => {
		const mockPlayer = makePlayer('kh-event-arg').setup({});
		let seen: KeyboardEvent | undefined;
		mockPlayer.addPlugin(KeyHandlerPlugin, {
			cooldownMs: 0,
			bindings: {
				' ': (_player, keyboardEvent) => {
					seen = keyboardEvent;
					keyboardEvent.preventDefault();
				},
			},
		});
		await mockPlayer.ready();

		const ev = new KeyboardEvent('keydown', {
			key: ' ',
			bubbles: true,
			cancelable: true,
		});
		document.dispatchEvent(ev);

		expect(seen).toBeInstanceOf(KeyboardEvent);
		expect(ev.defaultPrevented).toBe(true);
	});

	it('hands the KeyboardEvent to a binding registered through bind()', async () => {
		const mockPlayer = makePlayer('kh-event-bind').setup({});
		mockPlayer.addPlugin(KeyHandlerPlugin, { cooldownMs: 0 });
		await mockPlayer.ready();

		const handler = vi.fn();
		const keys = mockPlayer.getPlugin(KeyHandlerPlugin) as KeyHandlerPlugin;
		keys.bind('k', handler);

		dispatch('k');

		expect(handler).toHaveBeenCalledOnce();
		expect(handler.mock.calls[0]![1]).toBeInstanceOf(KeyboardEvent);
	});
});
