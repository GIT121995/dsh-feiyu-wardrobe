import assert from 'node:assert/strict';
import test from 'node:test';

import { computeCost, isPeak, normalizeUsage, resolvePrice } from '../lib/pricing.js';

// 2026-10-30 is a Friday (Asia/Shanghai).
const PEAK = Date.parse('2026-10-30T02:30:00Z'); // 10:30 Beijing
const OFF_PEAK = Date.parse('2026-10-30T05:00:00Z'); // 13:00 Beijing
const WEEKEND = Date.parse('2026-10-31T02:30:00Z'); // Saturday 10:30 Beijing

test('isPeak follows the Beijing weekday windows', () => {
	assert.equal(isPeak(PEAK), true);
	assert.equal(isPeak(OFF_PEAK), false);
	assert.equal(isPeak(WEEKEND), false);
	assert.equal(isPeak(Date.parse('2026-10-30T00:30:00Z')), false, '08:30 Beijing is before the morning window');
	// 09:00 Beijing exactly starts peak
	assert.equal(isPeak(Date.parse('2026-10-30T01:00:00Z')), true);
	// 12:00 Beijing ends the morning window
	assert.equal(isPeak(Date.parse('2026-10-30T04:00:00Z')), false);
});

test('holidays are off-peak', () => {
	const time = PEAK;
	assert.equal(isPeak(time, { holidays: ['2026-10-30'] }), false);
});

test('normalizeUsage maps cache reads to the hit bucket', () => {
	const usage = normalizeUsage({ inputTokens: 10, cacheReadTokens: 20, outputTokens: 5, cacheWriteTokens: 1 });
	assert.deepEqual(usage, {
		cacheHitInput: 20,
		cacheMissInput: 10,
		cacheWriteInput: 1,
		output: 5,
		total: 36,
	});
});

test('flash costs: miss input, cache hit and output are priced separately', () => {
	const offPeak = computeCost(
		{ inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 },
		{ timeMs: OFF_PEAK, model: 'deepseek-flash' },
	);
	assert.equal(offPeak.costCNY, 1 + 0.02 + 4);
	assert.equal(offPeak.peak, false);
	assert.equal(offPeak.knownModel, true);
});

test('peak doubles the price', () => {
	const peak = computeCost({ inputTokens: 1_000_000 }, { timeMs: PEAK, model: 'deepseek-flash' });
	const offPeak = computeCost({ inputTokens: 1_000_000 }, { timeMs: OFF_PEAK, model: 'deepseek-flash' });
	assert.equal(peak.costCNY, 2);
	assert.equal(offPeak.costCNY, 1);
});

test('model aliases resolve to a canonical pricing row', () => {
	assert.equal(resolvePrice('deepseek-v4-flash').model, 'deepseek-flash');
	const pro = computeCost({ outputTokens: 1_000_000 }, { timeMs: OFF_PEAK, model: 'deepseek-v4-pro' });
	assert.equal(pro.costCNY, 13.5);
});

test('unknown models fall back to the default model but are flagged', () => {
	const priced = computeCost({ inputTokens: 1_000_000 }, { timeMs: OFF_PEAK, model: 'some-future-model' });
	assert.equal(priced.knownModel, false);
	assert.equal(priced.costCNY, 1);
});

test('malformed usage never produces negative costs', () => {
	const priced = computeCost(
		{ inputTokens: -5, cacheReadTokens: 'oops', outputTokens: Number.NaN },
		{ timeMs: OFF_PEAK },
	);
	assert.equal(priced.costCNY, 0);
});
