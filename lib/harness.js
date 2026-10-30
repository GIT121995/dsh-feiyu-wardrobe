/**
 * Harness glue: subscribe to session events and register the `/fish` command.
 * A failure here must never break the agent loop, so every callback is wrapped.
 * @module dsh-feiyu-wardrobe/harness
 */

import { registerFishCommand } from './commands.js';

/**
 * @param {any} ctx cordis plugin context
 * @param {import('./runtime.js').WardrobeRuntime} runtime
 */
export function attachHarness(ctx, runtime) {
	ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
		runtime.handleSessionEvent(session, event);
	});
	ctx.effect(() => registerFishCommand(ctx.commands, runtime), 'feiyu-wardrobe: command');
	ctx.effect(
		() => () => {
			try {
				runtime.save();
			} catch {
				// best-effort flush on unload
			}
		},
		'feiyu-wardrobe: state flush',
	);
	return runtime;
}
