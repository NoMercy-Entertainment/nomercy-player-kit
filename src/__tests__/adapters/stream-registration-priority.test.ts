// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * A factory registered before setup keeps the priority it was given.
 *
 * Resolution walks newest-first. The built-ins used to be seeded during setup,
 * after a consumer's pre-setup `registerStream`, which pushed that factory below
 * them and lost it every URL the built-ins also claim. The registry's own
 * docblock said the defaults were seeded on first touch; nothing did it.
 */

import type { IStreamFactory, IStreamSource } from '../../adapters/stream/IStreamSource';

import { describe, expect, it, vi } from 'vitest';

import { StreamRegistry } from '../../adapters/stream/registry';
import { streamRegistrationMethods } from '../../core/mixins/stream-registration';

interface RegistryHost {
	_streamRegistry: StreamRegistry | undefined;
	registerStream: (factory: IStreamFactory, prepend?: boolean) => unknown;
	streams: () => ReadonlyArray<string>;
}

function host(): RegistryHost {
	return {
		_streamRegistry: undefined,
		registerStream: streamRegistrationMethods.registerStream,
		streams: streamRegistrationMethods.streams,
	} as unknown as RegistryHost;
}

function factory(id: string): IStreamFactory {
	return {
		id,
		canPlay: () => true,
		create: () => ({} as IStreamSource),
	} as unknown as IStreamFactory;
}

describe('a factory registered before setup', () => {
	it('outranks the built-ins, which are seeded with the registry', () => {
		const player = host();

		player.registerStream(factory('mine'));

		expect(player.streams()[0], 'newest-first, so the consumer is asked first').toBe('mine');
	});

	it('is asked before native and hls, not after them', () => {
		const player = host();

		player.registerStream(factory('mine'));

		const order = player.streams();

		expect(order).toContain('native');
		expect(order).toContain('hls');
		expect(order.indexOf('mine')).toBeLessThan(order.indexOf('hls'));
		expect(order.indexOf('mine')).toBeLessThan(order.indexOf('native'));
	});

	it('still yields to a factory registered after it', () => {
		const player = host();

		player.registerStream(factory('first'));
		player.registerStream(factory('second'));

		expect(player.streams()[0]).toBe('second');
	});

	it('goes to the back when it asks to, and stays behind the built-ins', () => {
		const player = host();

		player.registerStream(factory('mine'), true);

		const order = player.streams();

		expect(order.indexOf('mine')).toBeGreaterThan(order.indexOf('hls'));
	});
});

describe('the registry a player starts with', () => {
	it('already carries both built-ins before anything is registered', () => {
		const player = host();

		expect(new Set(player.streams())).toEqual(new Set(['hls', 'native']));
	});

	it('never allocates a second registry', () => {
		const player = host();
		const created = vi.fn();

		player.streams();
		const first = player._streamRegistry;
		player.registerStream(factory('mine'));

		expect(player._streamRegistry).toBe(first);
		expect(created).not.toHaveBeenCalled();
	});
});
