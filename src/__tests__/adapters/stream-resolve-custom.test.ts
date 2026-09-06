// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * `resolveCustom` is what lets a registered factory reach playback at all.
 *
 * A backend that handles HLS and progressive files itself asks this before
 * falling back to the media element, so the answer must be a source for a
 * consumer's factory and nothing for the built-ins, which the backend already
 * covers.
 */

import type { IStreamFactory, IStreamSource } from '../../adapters/stream/IStreamSource';

import { describe, expect, it, vi } from 'vitest';

import { hlsFactory } from '../../adapters/stream/hls';
import { nativeFactory } from '../../adapters/stream/native';
import { StreamRegistry } from '../../adapters/stream/registry';

function fakeSource(): IStreamSource {
	return {
		kind: 'dash',
		attach: vi.fn(async () => {}),
		detach: vi.fn(),
		destroy: vi.fn(),
		state: () => 'idle',
	} as unknown as IStreamSource;
}

function customFactory(id: string, matches: (url: string) => boolean, source: IStreamSource): IStreamFactory {
	return {
		id,
		canPlay: (url: string) => matches(url),
		create: () => source,
	} as unknown as IStreamFactory;
}

const MPD = 'https://media.invalid/movie/manifest.mpd';
const M3U8 = 'https://media.invalid/movie/index.m3u8';
const MP4 = 'https://media.invalid/movie/movie.mp4';

describe('resolving against consumer-registered factories', () => {
	it('returns a source from a factory the consumer registered', () => {
		const registry = new StreamRegistry();
		const source = fakeSource();

		registry.register(nativeFactory);
		registry.register(hlsFactory);
		registry.register(customFactory('dash', url => url.endsWith('.mpd'), source));

		expect(registry.resolveCustom({ url: MPD })).toBe(source);
	});

	it('returns nothing for a URL only the built-ins claim, rather than throwing', () => {
		const registry = new StreamRegistry();

		registry.register(nativeFactory);
		registry.register(hlsFactory);
		registry.register(customFactory('dash', url => url.endsWith('.mpd'), fakeSource()));

		expect(registry.resolveCustom({ url: M3U8 }), 'HLS is the backend\'s own path').toBeUndefined();
		expect(registry.resolveCustom({ url: MP4 }), 'a progressive file is the element\'s own path').toBeUndefined();
	});

	it('returns nothing when the consumer registered no factory at all', () => {
		const registry = new StreamRegistry();

		registry.register(nativeFactory);
		registry.register(hlsFactory);

		expect(registry.resolveCustom({ url: MPD })).toBeUndefined();
	});

	it('prefers the most recently registered custom factory', () => {
		const registry = new StreamRegistry();
		const first = fakeSource();
		const second = fakeSource();

		registry.register(customFactory('dash', url => url.endsWith('.mpd'), first));
		registry.register(customFactory('dash-next', url => url.endsWith('.mpd'), second));

		expect(registry.resolveCustom({ url: MPD })).toBe(second);
	});

	it('leaves resolve() throwing for an unmatched URL, so the built-in contract is unchanged', () => {
		const registry = new StreamRegistry();

		registry.register(nativeFactory);
		registry.register(hlsFactory);

		expect(() => registry.resolve({ url: MPD })).toThrow(/no stream factory could play/i);
	});
});
