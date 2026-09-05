// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

import type {
	AuthConfig,
	IUrlResolver,
	ResolvedUrl,
	UrlCategory,
	UrlResolverContext,
} from '../../types';
import type { Internals } from '../state';

import { buildResolvedUrl } from '../resolved-url';

/**
 * The auth mixin's slice of player state — composed into `PlayerCoreState`.
 * Declared here, beside the methods that write it.
 */
export interface AuthState {
	/** Live `AuthConfig` — readable via `auth()`, mutable via `auth(config)` / `auth(partial)`. */
	_authConfig: AuthConfig | undefined;

	/** Live URL resolver — readable via `urlResolver()`, mutable via `urlResolver(fn)`. */
	_urlResolver: IUrlResolver | undefined;
}

/**
 * Returns a copy of `cfg` with the token-bearing field (`bearerToken`)
 * stripped. Used by `auth()` to produce a safe public snapshot and by `resolveUrl`
 * to produce a safe `UrlResolverContext.auth` handed to consumer code.
 *
 * All non-secret fields — `credentials`, `headers`, `transformUrl`, `signRequest`,
 * `refreshOnUnauthenticated`, `retryAfterRefresh` — are retained.
 */
function redactTokenFields(cfg: AuthConfig): Readonly<AuthConfig> {
	const { bearerToken: _b, ...safe } = cfg;
	return Object.freeze(safe);
}

// ──────────────────────────────────────────────────────────────────────────
// Mixin: auth runtime — `auth` / `urlResolver` / `refreshAuth`.
// Single source of truth for auth config, URL resolution, and token refresh.
// Both the music and video players wire this mixin through `playerCoreMethods`.
// ──────────────────────────────────────────────────────────────────────────

export const authMethods = {
	/**
	 * Read or write the auth config.
	 *
	 * `auth()` — returns a **redacted** read-only frozen snapshot of the current
	 * auth config, or `undefined` when none has been set. The token-bearing field
	 * (`bearerToken`) is stripped from the snapshot so that the
	 * bearer secret is unreachable from public consumer code. Non-secret fields
	 * (`credentials`, `headers`, `transformUrl`, `signRequest`,
	 * `refreshOnUnauthenticated`, `retryAfterRefresh`) are retained.
	 *
	 * `auth(config)` — shallow-merge onto the current auth config; fields not
	 * named are retained. Emits `auth:refreshed` so listeners (cached fetchers,
	 * telemetry) re-resolve. To drop a field, call `auth(null)` first.
	 *
	 * `auth(partial)` — identical: `AuthConfig` and `Partial<AuthConfig>` are
	 * structurally the same type, so both forms take the merge path.
	 *
	 * `auth(null)` — clear the auth config entirely. Emits `auth:refreshed`.
	 */
	auth(this: Internals, configOrPartial?: AuthConfig | Partial<AuthConfig> | null): Readonly<AuthConfig> | undefined | void {
		if (configOrPartial === undefined) {
			if (!this._authConfig)
				return undefined;
			return redactTokenFields(this._authConfig);
		}
		if (configOrPartial === null) {
			this._authConfig = undefined;
			this.emit('auth:refreshed', { tokenAcquiredAt: Date.now() });
			return;
		}
		const next: AuthConfig = {
			...(this._authConfig ?? {}),
			...configOrPartial,
		};
		this._authConfig = next;
		this.emit('auth:refreshed', { tokenAcquiredAt: Date.now() });
	},

	/** Returns `true` when an auth config is present, `false` otherwise. Does not expose the token. */
	hasAuth(this: Internals): boolean {
		return this._authConfig !== undefined;
	},

	/**
	 * Returns the raw `AuthConfig` including token fields.
	 * Internal use only — the fetch pipeline reads auth through this path.
	 * Never expose on a public interface.
	 */
	_rawAuth(this: Internals): AuthConfig | undefined {
		return this._authConfig;
	},

	/**
	 * Resolve a URL through the configured `urlResolver` (custom-supplied
	 * via `setup({ urlResolver })` / `urlResolver(fn)`) or fall back to
	 * the built-in pipeline (`auth.transformUrl` + `buildResolvedUrl`).
	 *
	 * `category` lets custom resolvers route per consumer ('media',
	 * 'subtitle', 'cast', 'license', ...). Defaults to `'media'`.
	 *
	 * Returned `ResolvedUrl` carries the post-transform `href` plus parsed
	 * parts (origin, pathname, ext, searchParams, ...). Pass `.href` (or
	 * interpolate the object — `toString()` returns `href`) to the consumer.
	 */
	async resolveUrl(this: Internals, url: string, category?: UrlCategory): Promise<ResolvedUrl> {
		const resolvedCategory = category ?? 'media';

		// Poster and cast artwork must be absolute so the OS MediaSession API and
		// Cast receivers can fetch them without a page-origin anchor. `baseImageUrl`
		// is a string prefix (not a URL base) — matching the documented intent:
		// "Base URL prepended to relative image / poster paths". Standard URL
		// resolution semantics (`new URL(path, base)`) would strip the base path
		// segment when the path starts with `/`, producing wrong TMDB-style URLs.
		const isArtworkCategory = resolvedCategory === 'poster' || resolvedCategory === 'cast';
		const imageBase = this.options?.baseImageUrl;

		const auth = this._authConfig;

		const defaultResolve = async (rawUrl: string): Promise<ResolvedUrl> => {
			const transformer = auth?.transformUrl;
			const transformed = transformer ? await transformer(rawUrl) : rawUrl;

			const isAbsolute = /^[a-z][a-z\d+\-.]*:/iu.test(transformed);
			const base = this._baseUrl ?? this.options?.baseUrl;

			// baseUrl and baseImageUrl are path prefixes, not URL bases: a relative
			// media or image path is appended as a raw string, keeping the base path
			// segment. Standard new URL(path, base) drops that segment when the path
			// starts with a slash. The server sends base without a trailing slash and
			// paths with a leading slash, so raw concatenation joins them cleanly.
			const prefixBase = isArtworkCategory ? imageBase : base;
			if (prefixBase && !isAbsolute)
				return buildResolvedUrl(rawUrl, prefixBase + transformed);

			const result = buildResolvedUrl(rawUrl, transformed, base);

			if (result.relative) {
				this.options?.logger?.warn(
					`[resolveUrl] ${resolvedCategory} URL resolved to a relative path — the OS or receiver will 404. `
					+ `Set baseImageUrl in player config or supply a urlResolver. Raw: "${rawUrl}"`,
				);
			}

			return result;
		};

		const resolver = this._urlResolver;
		if (!resolver)
			return defaultResolve(url);

		// Custom resolvers receive the baseImageUrl as `baseUrl` for artwork
		// categories so they can apply the same prefix logic or override it.
		// Token fields are stripped so consumer resolver code cannot read the bearer.
		const ctxBaseUrl = (isArtworkCategory && imageBase) ? imageBase : (this._baseUrl ?? this.options?.baseUrl);
		const ctx: UrlResolverContext = {
			auth: auth ? redactTokenFields(auth) : undefined,
			baseUrl: ctxBaseUrl,
			category: resolvedCategory,
			defaultResolve,
		};
		const out = await resolver(url, ctx);
		// Defensive: a custom resolver returning a falsy / non-object value
		// shouldn't blow up downstream consumers. Fall back to default.
		if (!out || typeof out !== 'object' || typeof out.href !== 'string') {
			return defaultResolve(url);
		}
		return out;
	},

	/**
	 * Read or write the URL resolver.
	 *
	 * `urlResolver()` — returns the current custom resolver, or `undefined`
	 * when the built-in auth pipeline (`auth.transformUrl` + `buildResolvedUrl`)
	 * is active.
	 *
	 * `urlResolver(fn)` — replace the resolver at runtime. Pass `undefined`
	 * to revert to the built-in default. Takes effect on the next `resolveUrl`
	 * call; fires no event.
	 */
	urlResolver(this: Internals, resolver?: IUrlResolver | undefined): IUrlResolver | undefined | void {
		if (arguments.length === 0) {
			return this._urlResolver;
		}
		this._urlResolver = resolver;
	},

	/**
	 * Invoke `auth.refreshOnUnauthenticated` if present, then emit
	 * `auth:refreshed { tokenAcquiredAt }`. On failure emits `auth:failed`
	 * (does NOT throw — callers wire to the event for error UI).
	 */
	async refreshAuth(this: Internals): Promise<void> {
		const cfg = this._authConfig;
		const handler = cfg?.refreshOnUnauthenticated;
		if (!handler) {
			this.emit('auth:refreshed', { tokenAcquiredAt: Date.now() });
			return;
		}
		try {
			await handler();
			this.emit('auth:refreshed', { tokenAcquiredAt: Date.now() });
		}
		catch (err) {
			this.emit('auth:failed', { error: err });
		}
	},
} as const;
