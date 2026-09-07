// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * `ActionOptions.silent` does what its docblock says.
 *
 * It was declared on every transport, queue and load action and read nowhere, so
 * a consumer restoring saved state got the full `beforePlay` guard and a `play`
 * event announcing user intent that no user had.
 */

import type { BaseEventMap } from '../types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	composeMixins,
	EventEmitter,
	initPlayerCoreState,
	playerCoreMethods,
	resolvePlayerConstructor,
} from '../index';

const _instances = new Map<string, MockPlayer>();

class MockPlayer extends EventEmitter<BaseEventMap> {
	readonly playerId: string = '';
	container: HTMLElement = {} as HTMLElement;

	get id(): string {
		return this.playerId;
	}

	declare setup: (config: unknown) => this;
	declare ready: () => Promise<void>;
	declare play: (opts?: { silent?: boolean }) => Promise<void>;
	declare pause: (opts?: { silent?: boolean }) => Promise<void>;

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

	static _reset(): void {
		_instances.clear();
	}
}

composeMixins(MockPlayer.prototype, ...playerCoreMethods);

async function readyPlayer(id: string): Promise<MockPlayer> {
	const div = document.createElement('div');
	div.id = id;
	document.body.appendChild(div);

	const player = new MockPlayer(id);
	player.setup({});
	await player.ready();

	return player;
}

describe('a silent action', () => {
	beforeEach(() => {
		MockPlayer._reset();
		document.body.innerHTML = '';
	});

	it('emits no lifecycle event', async () => {
		const player = await readyPlayer('silent-1');
		const onPlay = vi.fn();

		player.on('play', onPlay);
		await player.play({ silent: true });

		expect(onPlay).not.toHaveBeenCalled();
	});

	it('does not run the before guard, so a listener cannot cancel it', async () => {
		const player = await readyPlayer('silent-2');
		const onBefore = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
		const onPrevented = vi.fn();

		player.on('beforePlay', onBefore as never);
		player.on('playPrevented', onPrevented);
		await player.play({ silent: true });

		expect(onBefore, 'a restore is not user intent to answer').not.toHaveBeenCalled();
		expect(onPrevented).not.toHaveBeenCalled();
	});

	it('leaves an ordinary action emitting and guarded', async () => {
		const player = await readyPlayer('silent-3');
		const onPlay = vi.fn();
		const onBefore = vi.fn();

		player.on('beforePlay', onBefore as never);
		player.on('play', onPlay);
		await player.play();

		expect(onBefore).toHaveBeenCalledTimes(1);
		expect(onPlay).toHaveBeenCalledTimes(1);
	});

	it('silences pause the same way', async () => {
		const player = await readyPlayer('silent-4');
		const onPause = vi.fn();

		player.on('pause', onPause);
		await player.pause({ silent: true });

		expect(onPause).not.toHaveBeenCalled();
	});
});
