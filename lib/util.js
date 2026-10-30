/**
 * Small shared helpers: DSH home resolution, atomic JSON state writes,
 * Beijing-day keys and display formatting.
 * @module dsh-feiyu-wardrobe/util
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** @returns {string} DSH home directory (`DSH_HOME` or `~/.dsh`). */
export function dshHome() {
	const env = process.env.DSH_HOME?.trim();
	return env && env.length > 0 ? env : join(homedir(), '.dsh');
}

/** @returns {string} Default wardrobe state path: `<DSH home>/feiyu-wardrobe/state.json`. */
export function defaultStatePath() {
	return join(dshHome(), 'feiyu-wardrobe', 'state.json');
}

/**
 * Expand a leading `~` and return an absolute path.
 * @param {string} path
 * @returns {string}
 */
export function expandHome(path) {
	if (path === '~') return homedir();
	if (path.startsWith('~/')) return join(homedir(), path.slice(2));
	return path;
}

/**
 * Create the parent directory of a file path.
 * @param {string} path
 */
export function ensureParent(path) {
	mkdirSync(dirname(path), { recursive: true });
}

/**
 * Write a UTF-8 file atomically (temp file + rename in the same directory).
 * @param {string} path
 * @param {string} text
 */
export function atomicWriteFile(path, text) {
	ensureParent(path);
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	writeFileSync(tmp, text, 'utf8');
	renameSync(tmp, path);
}

/**
 * Write a Buffer atomically (temp file + rename).
 * @param {string} path
 * @param {Buffer} buffer
 */
export function atomicWriteBuffer(path, buffer) {
	ensureParent(path);
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
	writeFileSync(tmp, buffer);
	renameSync(tmp, path);
}

/**
 * Serialize and write JSON atomically.
 * @param {string} path
 * @param {unknown} value
 */
export function atomicWriteJson(path, value) {
	atomicWriteFile(path, `${JSON.stringify(value, null, '\t')}\n`);
}

/**
 * Read and parse a JSON file; returns `fallback` when the file is missing or corrupt.
 * @param {string} path
 * @param {unknown} fallback
 */
export function readJsonFile(path, fallback = null) {
	if (!existsSync(path)) return fallback;
	try {
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return fallback;
	}
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(value, min, max) {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/**
 * Round to N decimal places.
 * @param {number} value
 * @param {number} [digits]
 * @returns {number}
 */
export function round(value, digits = 6) {
	const factor = 10 ** digits;
	return Math.round(value * factor) / factor;
}

/**
 * Beijing calendar day key (`YYYY-MM-DD`) for an epoch-ms timestamp.
 * @param {number} timeMs
 * @param {number} [timezoneOffsetMinutes]
 * @returns {string}
 */
export function dayKey(timeMs, timezoneOffsetMinutes = 480) {
	const shifted = new Date(timeMs + timezoneOffsetMinutes * 60_000);
	const year = shifted.getUTCFullYear();
	const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
	const day = String(shifted.getUTCDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

/**
 * Epoch ms of the Beijing midnight starting the day that contains `timeMs`.
 * @param {number} timeMs
 * @param {number} [timezoneOffsetMinutes]
 * @returns {number}
 */
export function dayStartMs(timeMs, timezoneOffsetMinutes = 480) {
	const key = dayKey(timeMs, timezoneOffsetMinutes);
	const [year, month, day] = key.split('-').map(Number);
	return Date.UTC(year, month - 1, day) - timezoneOffsetMinutes * 60_000;
}

/**
 * Human-friendly CNY amount. Small amounts keep 4 significant decimals.
 * @param {number} value
 * @returns {string}
 */
export function formatCNY(value) {
	const amount = Number.isFinite(value) ? Math.max(0, value) : 0;
	if (amount === 0) return '¥0';
	if (amount >= 1) return `¥${amount.toFixed(2)}`;
	const shown = amount.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
	return `¥${shown}`;
}

/**
 * Fish-food coin amount, one decimal at most.
 * @param {number} value
 * @returns {string}
 */
export function formatCoins(value) {
	const amount = Number.isFinite(value) ? Math.max(0, value) : 0;
	const rounded = Math.round(amount * 10) / 10;
	return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Compact token count (1.2k / 3.4M).
 * @param {number} value
 * @returns {string}
 */
export function formatTokens(value) {
	const total = Number.isFinite(value) ? Math.max(0, value) : 0;
	if (total >= 1_000_000) return `${(total / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
	if (total >= 1000) return `${(total / 1000).toFixed(1).replace(/\.?0+$/, '')}k`;
	return String(Math.round(total));
}

/**
 * A human user message carries `source.kind === 'user'`; plugin-injected
 * context (recall, tool output, ...) does not. Mirrors the host convention.
 * @param {unknown} message
 * @returns {boolean}
 */
export function isHumanUserMessage(message) {
	if (!message || typeof message !== 'object') return false;
	const source = /** @type {{ source?: { kind?: unknown } }} */ (message).source;
	return source?.kind === 'user';
}
