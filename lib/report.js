/**
 * Report-card generation shared by `/fish report`, the `dsh-feiyu-report`
 * CLI and the demo/screenshot scripts.
 * @module dsh-feiyu-wardrobe/report
 */

import { dirname, join } from 'node:path';
import { renderCardHtml } from './render.js';
import { atomicWriteFile } from './util.js';

/**
 * @param {import('./config.js').FeiyuConfig} config
 * @returns {string}
 */
export function defaultReportPath(config) {
	return join(dirname(config.statePath), 'report.html');
}

/**
 * Render the share card and write it next to the state file.
 * @param {import('./state.js').FishState} state
 * @param {import('./config.js').FeiyuConfig} config
 * @param {{ now?: number, outPath?: string, title?: string }} [options]
 * @returns {string} written path
 */
export function writeReportCard(state, config, options = {}) {
	const now = options.now ?? Date.now();
	const outPath = options.outPath ?? defaultReportPath(config);
	const html = renderCardHtml(state, config, { now, ...(options.title ? { title: options.title } : {}) });
	atomicWriteFile(outPath, html);
	return outPath;
}
