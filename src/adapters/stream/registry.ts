// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type {
	IStreamFactory,
	IStreamSource,
	StreamFactoryOptions,
	StreamInterceptor,
} from './IStreamSource';

import { StreamError } from '../../errors';

/** Ids the kit registers itself. A backend handles these without the registry. */
const BUILT_IN_STREAM_IDS = new Set(['native', 'hls']);

/**
 * Per-player catalogue of stream factories and content interceptors.
 *
 * Each player holds one `StreamRegistry`. When the backend needs to load a URL
 * it calls `resolve()`, which walks the factory list newest-first and returns a
 * `IStreamSource` from the first factory whose `canPlay` returns `true`.
 *
 * Built-in factories (`native`, `hls`) are pre-registered on player init. Add
 * further protocols (DASH, smooth streaming, custom CDN) via
 * `player.registerStream(factory)`. Re-registering with the same `id` replaces
 * the old entry.
 *
 * Resolution order is last-in-first-out so a consumer can override a built-in
 * by registering a factory with the same content match — the newer entry wins.
 * Pass `prepend: true` to push a factory to the front (lowest priority).
 */
export class StreamRegistry {
	private readonly factories: IStreamFactory[] = [];
	private readonly interceptors: StreamInterceptor[] = [];

	/**
	 * Add a factory to the registry. If a factory with the same `id` already
	 * exists it is replaced in-place. Pass `prepend: true` to place the factory
	 * at the lowest-priority position instead of the default highest.
	 */
	register(factory: IStreamFactory, prepend?: boolean): void {
		const existing = this.factories.findIndex(streamFactory => streamFactory.id === factory.id);
		if (existing >= 0)
			this.factories.splice(existing, 1);

		if (prepend)
			this.factories.unshift(factory);
		else
			this.factories.push(factory);
	}

	/** Remove the factory with the given `id`. No-op if it was never registered. */
	unregister(id: string): void {
		const idx = this.factories.findIndex(streamFactory => streamFactory.id === id);
		if (idx >= 0)
			this.factories.splice(idx, 1);
	}

	/**
	 * Find the highest-priority factory that claims the URL and return a new
	 * `IStreamSource` for it. Throws `StreamError('core:stream/no-factory-match')`
	 * when no factory matches — register the appropriate factory first.
	 */
	resolve(opts: StreamFactoryOptions): IStreamSource {
		for (let i = this.factories.length - 1; i >= 0; i--) {
			const factory = this.factories[i];
			if (!factory)
				continue;

			if (factory.canPlay(opts.url, opts.contentType, opts.capabilities)) {
				return factory.create({
					...opts,
					registry: this,
				});
			}
		}

		throw new StreamError({
			code: 'core:stream/no-factory-match',
			severity: 'error',
			scope: { kind: 'core' },
			message: `No stream factory could play ${opts.url}${opts.contentType ? ` (${opts.contentType})` : ''}. Register a factory via player.registerStream(...) first.`,
			context: {
				url: opts.url,
				contentType: opts.contentType,
			},
		});
	}

	/**
	 * Resolve only against factories a consumer registered, skipping the
	 * built-in `native` and `hls` entries, and return `undefined` rather than
	 * throwing when none of them claims the URL.
	 *
	 * A backend that already handles HLS and progressive files itself calls this
	 * to find out whether a consumer has registered something for a URL it would
	 * otherwise hand straight to the media element. That keeps the built-in path
	 * byte-identical for every existing player and stops `registerStream` from
	 * being a call that registers a factory nothing ever asks.
	 */
	resolveCustom(opts: StreamFactoryOptions): IStreamSource | undefined {
		for (let i = this.factories.length - 1; i >= 0; i--) {
			const factory = this.factories[i];
			if (!factory || BUILT_IN_STREAM_IDS.has(factory.id))
				continue;

			if (factory.canPlay(opts.url, opts.contentType, opts.capabilities)) {
				return factory.create({
					...opts,
					registry: this,
				});
			}
		}

		return undefined;
	}

	/** `true` if a factory with the given `id` is registered. */
	has(id: string): boolean {
		return this.factories.some(streamFactory => streamFactory.id === id);
	}

	/** Return the factory registered under `id`, or `undefined` if absent. */
	findById(id: string): IStreamFactory | undefined {
		return this.factories.find(streamFactory => streamFactory.id === id);
	}

	/** Factory ids in resolution order (highest priority first). */
	list(): string[] {
		return this.factories.map(streamFactory => streamFactory.id).reverse();
	}

	/**
	 * Install a content interceptor. It runs on every manifest and segment
	 * response before the underlying protocol handler sees the bytes. Multiple
	 * interceptors compose in registration order — each receives the output of
	 * the previous one.
	 *
	 * Returns an unsubscribe function; call it to remove the interceptor.
	 */
	intercept(fn: StreamInterceptor): () => void {
		this.interceptors.push(fn);

		return () => {
			const idx = this.interceptors.indexOf(fn);
			if (idx >= 0)
				this.interceptors.splice(idx, 1);
		};
	}

	/**
	 * Pass `response` through every registered interceptor in order and return
	 * the final result. Called internally by stream sources before yielding bytes
	 * to hls.js or native parsers; not typically called from application code.
	 */
	async runInterceptors(url: string, response: Response): Promise<Response> {
		let current = response;

		for (const fn of this.interceptors) {
			current = await fn(url, current);
		}

		return current;
	}

	/** Release all factories and interceptors. The instance is unusable after this. */
	dispose(): void {
		this.factories.length = 0;
		this.interceptors.length = 0;
	}
}
