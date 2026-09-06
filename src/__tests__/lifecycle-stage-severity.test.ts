// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * A failed setup stage reports on the channel its error asks for.
 *
 * The runner hard-coded `error`, so an error declaring itself `fatal` still
 * arrived on the recoverable channel and the listener that tears the interface
 * down never heard about it. The runner's own docblock promised the severity
 * tier it did not deliver.
 *
 * Tested at the decision rather than through the pipeline: no stage body throws
 * a fatal error today, so driving it end to end would assert a path no consumer
 * can currently reach, and would pass with the decision removed.
 */

import { describe, expect, it } from 'vitest';

import { StateError } from '../errors';
import { stageErrorTier } from '../core/mixins/lifecycle';

describe('the channel a failed setup stage reports on', () => {
	it('sends an error that declares itself fatal to the fatal channel', () => {
		const error = new StateError({
			code: 'core:test/fatal',
			severity: 'fatal',
			scope: { kind: 'core' },
			message: 'unrecoverable',
		});

		expect(stageErrorTier(error)).toBe('fatal');
	});

	it('leaves a recoverable error on the error channel', () => {
		const error = new StateError({
			code: 'core:test/recoverable',
			severity: 'error',
			scope: { kind: 'core' },
			message: 'recoverable',
		});

		expect(stageErrorTier(error)).toBe('error');
	});

	it('treats an error with no severity as recoverable, which is what a plain throw becomes', () => {
		expect(stageErrorTier({})).toBe('error');
	});

	it('treats a warning as recoverable rather than promoting it', () => {
		expect(stageErrorTier({ severity: 'warning' })).toBe('error');
	});
});
