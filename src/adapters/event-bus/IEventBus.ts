// -----------------------------------------------------------------------------
//  Copyright (c) NoMercy Entertainment
//
//  Licensed under the Apache License, Version 2.0. See LICENSE for details.
//
//  SPDX-License-Identifier: Apache-2.0
// -----------------------------------------------------------------------------

/**
 * Typed event bus contract. Mirrors the `EventEmitter` surface used by both
 * player classes and the plugin base.
 *
 * This is a type to write against, not a slot to fill: there is no `eventBus`
 * setup option and nothing in the kit reads a replacement. Use it to type a
 * wrapper that forwards events into a store, a fake in a test, or a function
 * that takes "anything you can listen to" without naming a player.
 */
export interface IEventBus<E extends Record<string, any> = Record<string, any>> {
	on<K extends keyof E>(event: K, fn: (data: E[K]) => void): void;
	on(event: string, fn: (data: unknown) => void): void;

	once<K extends keyof E>(event: K, fn: (data: E[K]) => void): void;
	once(event: string, fn: (data: unknown) => void): void;

	off<K extends keyof E>(event: K, fn?: (data: E[K]) => void): void;
	off(event: 'all'): void;
	off(event: string, fn?: (data: unknown) => void): void;

	emit<K extends keyof E>(event: K, data?: E[K]): void;
	emit(event: string, data?: unknown): void;

	hasListeners<K extends keyof E>(event: K): boolean;
	hasListeners(event: string): boolean;

	listenerCount(): number;
}
