/**
 * Rendering: composes the 360×360 scene (original whale + worn wearables) and
 * the 1080×1440 shareable "饲养报告" card as self-contained HTML.
 *
 * No external assets, fonts or scripts are referenced — the card renders
 * offline and contains no chat text.
 * @module dsh-feiyu-wardrobe/render
 */

import { ITEMS, ITEM_BY_ID, RARITIES, SLOT_ORDER, rarityLabel, slotLabel } from './catalog.js';
import { moodOf, summaryOf } from './economy.js';
import { dayKey, formatCNY, formatCoins, formatTokens } from './util.js';

export const CANVAS = 360;

/** Default background when no bg item is worn. */
const DEFAULT_BG = `<g>
  <defs><linearGradient id="feiyu-grad-default" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#EAF8FF"/><stop offset="1" stop-color="#CFECFF"/>
  </linearGradient></defs>
  <rect width="360" height="360" fill="url(#feiyu-grad-default)"/>
  <g fill="#FFFFFF" opacity="0.7">
    <circle cx="300" cy="104" r="8"/><circle cx="318" cy="84" r="4"/><circle cx="286" cy="74" r="3.5"/>
    <circle cx="64" cy="150" r="6"/><circle cx="48" cy="180" r="4"/>
  </g>
</g>`;

/**
 * The whale body without facial features.
 * @returns {string}
 */
function whaleBody() {
	return `<g>
    <g stroke="#8ECFF5" stroke-width="5" stroke-linecap="round" fill="none">
      <path d="M170 108 C166 92 156 84 148 78"/>
      <path d="M170 108 C174 92 184 84 192 78"/>
    </g>
    <path d="M268 196 C300 168 316 150 322 142 C336 168 334 214 322 240 C310 226 292 206 268 196 Z" fill="#8ECFF5"/>
    <path d="M62 196 C62 140 112 108 172 108 C236 108 282 142 282 196 C282 252 236 286 172 286 C108 286 62 250 62 196 Z" fill="#8ECFF5"/>
    <path d="M95 238 C120 276 224 276 249 238 C240 272 212 286 172 286 C132 286 104 272 95 238 Z" fill="#EAF8FF"/>
    <path d="M112 204 C92 208 82 224 86 238 C102 242 118 232 124 220 Z" fill="#6DB8E6"/>
  </g>`;
}

/**
 * Facial features for a mood.
 * @param {string} [face]
 * @returns {string}
 */
export function faceSvg(face = 'calm') {
	const blush =
		face === 'happy' || face === 'stuffed'
			? `<ellipse cx="116" cy="214" rx="15" ry="9" fill="#FFB3C7" opacity="0.95"/>
         <ellipse cx="228" cy="214" rx="15" ry="9" fill="#FFB3C7" opacity="0.95"/>`
			: face === 'hungry'
				? `<ellipse cx="120" cy="214" rx="9" ry="5" fill="#FFB3C7" opacity="0.7"/>
           <ellipse cx="224" cy="214" rx="9" ry="5" fill="#FFB3C7" opacity="0.7"/>`
				: `<ellipse cx="118" cy="214" rx="12" ry="7" fill="#FFB3C7" opacity="0.85"/>
           <ellipse cx="228" cy="214" rx="12" ry="7" fill="#FFB3C7" opacity="0.85"/>`;
	if (face === 'happy') {
		return `<g>
      <path d="M128 190 C134 178 146 178 152 190" stroke="#1B2A3A" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M192 190 C198 178 210 178 216 190" stroke="#1B2A3A" stroke-width="5" fill="none" stroke-linecap="round"/>
      ${blush}
      <path d="M158 212 C166 230 180 230 186 212" stroke="#1B2A3A" stroke-width="4" fill="#FF8FA3" stroke-linecap="round"/>
      <path d="M292 118 l5 10 10 5 -10 5 -5 10 -5 -10 -10 -5 10 -5 z" fill="#FFD27A"/>
    </g>`;
	}
	if (face === 'hungry') {
		return `<g>
      <ellipse cx="140" cy="190" rx="9" ry="11" fill="#1B2A3A"/>
      <ellipse cx="206" cy="190" rx="9" ry="11" fill="#1B2A3A"/>
      <circle cx="143" cy="187" r="3.5" fill="#FFFFFF"/>
      <circle cx="209" cy="187" r="3.5" fill="#FFFFFF"/>
      ${blush}
      <path d="M162 218 C168 212 176 224 182 218" stroke="#1B2A3A" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="M286 122 C280 132 278 138 284 142 C290 138 292 132 286 122 Z" fill="#8ECFF5"/>
      <text x="300" y="152" font-size="26" fill="#7A8CA3" font-family="sans-serif" font-weight="700">…</text>
    </g>`;
	}
	if (face === 'stuffed') {
		return `<g>
      <path d="M128 190 C136 182 148 182 154 190" stroke="#1B2A3A" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M190 190 C196 182 208 182 216 190" stroke="#1B2A3A" stroke-width="5" fill="none" stroke-linecap="round"/>
      ${blush}
      <ellipse cx="172" cy="214" rx="9" ry="7" fill="#1B2A3A"/>
      <g fill="#A8C8E0"><circle cx="292" cy="140" r="4"/><circle cx="308" cy="156" r="3"/><circle cx="322" cy="136" r="2.5"/></g>
    </g>`;
	}
	return `<g>
    <circle cx="140" cy="188" r="11" fill="#1B2A3A"/>
    <circle cx="206" cy="188" r="11" fill="#1B2A3A"/>
    <circle cx="144" cy="184" r="4" fill="#FFFFFF"/>
    <circle cx="210" cy="184" r="4" fill="#FFFFFF"/>
    ${blush}
    <path d="M162 214 C166 224 178 224 182 214" stroke="#1B2A3A" stroke-width="4" fill="none" stroke-linecap="round"/>
  </g>`;
}

/**
 * The whale with a mood face, as an SVG fragment.
 * @param {string} [face]
 * @returns {string}
 */
export function whaleSvg(face = 'calm') {
	return `${whaleBody()}${faceSvg(face)}`;
}

/**
 * @param {import('./state.js').FishState} state
 * @param {string} slot
 * @returns {import('./catalog.js').Item | null}
 */
function equippedIn(state, slot) {
	const id = state.equipped[slot];
	return id ? ITEM_BY_ID.get(id) ?? null : null;
}

/**
 * Inner content of the 360×360 scene: background, whale, then worn items in
 * layer order (bg → body → neck → face → hand → hat).
 * @param {import('./state.js').FishState} state
 * @param {{ face?: string }} [options]
 * @returns {string}
 */
export function sceneInner(state, options = {}) {
	const bg = equippedIn(state, 'bg');
	const layers = [];
	layers.push(bg ? bg.svg : DEFAULT_BG);
	layers.push(whaleSvg(options.face ?? 'calm'));
	for (const slot of SLOT_ORDER) {
		if (slot === 'bg') continue;
		const item = equippedIn(state, slot);
		if (item) layers.push(item.svg);
	}
	return layers.join('\n');
}

/**
 * Full standalone scene SVG.
 * @param {import('./state.js').FishState} state
 * @param {{ face?: string, size?: number, label?: string }} [options]
 * @returns {string}
 */
export function sceneSvg(state, options = {}) {
	const size = options.size ?? CANVAS;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="${size}" height="${size}" role="img" aria-label="大肥鱼">
${sceneInner(state, options)}
</svg>`;
}

/**
 * @param {string} key
 * @returns {string}
 */
export function moodLine(key) {
	switch (key) {
		case 'starving':
			return '鱼在喊饿：今天还没吃 token 呢。';
		case 'hungry':
			return '有点馋，再来点 token。';
		case 'fine':
			return '悠哉游哉，正在想下一顿。';
		case 'happy':
			return '吃饱喝足，心情不错。';
		case 'stuffed':
			return '吃撑了，正在翻肚。';
		default:
			return '一条安静的鱼。';
	}
}

/**
 * @param {number} value
 * @returns {string}
 */
function starsOf(value) {
	const count = Math.max(1, Math.min(5, Math.round(value / 2) + 1));
	return '★'.repeat(count) + '☆'.repeat(5 - count);
}

/**
 * Seven-day food bars for the card.
 * @param {import('./state.js').FishState} state
 * @param {import('./config.js').FeiyuConfig} config
 * @param {number} now
 * @returns {string}
 */
export function weekBarsSvg(state, config, now) {
	const days = [];
	for (let offset = 6; offset >= 0; offset -= 1) {
		const key = dayKey(now - offset * 86_400_000, config.timezoneOffsetMinutes);
		days.push({ key, costCNY: state.daily[key]?.costCNY ?? 0 });
	}
	const max = Math.max(0.0001, ...days.map((day) => day.costCNY));
	const barWidth = 46;
	const gap = 30;
	const width = days.length * barWidth + (days.length - 1) * gap;
	const chartHeight = 68;
	const bars = days
		.map((day, index) => {
			const height = Math.max(4, Math.round((day.costCNY / max) * chartHeight));
			const x = index * (barWidth + gap);
			const y = chartHeight - height;
			const opacity = 0.35 + 0.65 * (day.costCNY / max);
			return `<rect x="${x}" y="${y + 12}" width="${barWidth}" height="${height}" rx="8" fill="#F5C542" opacity="${opacity.toFixed(2)}"/>`;
		})
		.join('');
	return `<svg viewBox="0 0 ${width} ${chartHeight + 12}" width="100%" height="80" preserveAspectRatio="xMidYEnd meet" role="img" aria-label="近七天伙食">${bars}</svg>`;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
	return String(text)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

/**
 * @param {import('./catalog.js').Item} item
 * @returns {string}
 */
function rarityColor(item) {
	return RARITIES[item.rarity]?.color ?? '#7A8CA3';
}

/**
 * Build the shareable 1080×1440 report card (self-contained HTML).
 * @param {import('./state.js').FishState} state
 * @param {import('./config.js').FeiyuConfig} config
 * @param {{ now?: number, title?: string }} [options]
 * @returns {string}
 */
export function renderCardHtml(state, config, options = {}) {
	const now = options.now ?? Date.now();
	const summary = summaryOf(state, now, config);
	const mood = moodOf(state, now, config);
	const date = dayKey(now, config.timezoneOffsetMinutes).replaceAll('-', '.');
	const equipped = [];
	for (const slot of SLOT_ORDER) {
		const item = equippedIn(state, slot);
		if (item) equipped.push(item);
	}
	const chipHtml = equipped
		.map(
			(item) =>
				`<span class="chip" style="border-color:${rarityColor(item)}55;color:${rarityColor(item)}">${escapeHtml(item.name)}<em>${escapeHtml(slotLabel(item.slot))}</em></span>`,
		)
		.join('');
	const scene = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" width="100%" height="100%" role="img" aria-label="大肥鱼">
${sceneInner(state, { face: mood.face })}
</svg>`;
	const title = options.title ?? '饲养报告';
	const days = summary.daysAlive;
	const tokensTotal = summary.tokens.total || summary.tokens.input + summary.tokens.cacheRead + summary.tokens.output;
	const stat = (label, value, hint = '') =>
		`<div class="stat"><div class="statValue">${value}</div><div class="statLabel">${label}</div>${hint ? `<div class="statHint">${hint}</div>` : ''}</div>`;
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${escapeHtml(state.fishName)} · 大肥鱼衣橱 ${title}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1080px; height: 1440px; overflow: hidden; }
  body {
    background: #0D1524;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
    color: #F5F7FF;
  }
  .card {
    position: relative; width: 1080px; height: 1440px; padding: 44px 60px;
    display: flex; flex-direction: column; gap: 18px;
    background:
      radial-gradient(900px 520px at 82% -8%, rgba(91,231,240,0.16), transparent 62%),
      radial-gradient(760px 480px at 6% 16%, rgba(142,207,245,0.14), transparent 60%),
      linear-gradient(180deg, #101A2C 0%, #0C1420 58%, #0A111B 100%);
  }
  .card::after {
    content: ""; position: absolute; inset: 22px; border: 1px solid rgba(245,247,255,0.10);
    border-radius: 30px; pointer-events: none;
  }
  .header { display: flex; align-items: baseline; justify-content: space-between; }
  .brand { font-size: 26px; font-weight: 800; letter-spacing: 1px; color: #F5F7FF; }
  .brand span { color: #5BE7F0; }
  .date { font-size: 18px; color: #93A4BC; letter-spacing: 2px; }
  .scene {
    height: 496px; border-radius: 30px; padding: 16px;
    background: linear-gradient(180deg, #F7FBFF, #E8F4FF);
    box-shadow: 0 24px 60px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.6);
    display: flex; align-items: center; justify-content: center;
  }
  .scene svg { display: block; border-radius: 22px; overflow: hidden; }
  .identity { display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; }
  .name { font-size: 52px; font-weight: 800; letter-spacing: 1px; line-height: 1.1; }
  .sub { margin-top: 8px; font-size: 20px; color: #9FB0C8; }
  .mood {
    display: flex; align-items: center; gap: 12px; padding: 12px 22px; border-radius: 999px;
    background: rgba(91,231,240,0.10); border: 1px solid rgba(91,231,240,0.35);
    font-size: 22px; color: #CFFAFF; white-space: nowrap;
  }
  .mood b { font-size: 26px; }
  .quote { font-size: 19px; color: #8FA3BE; margin-top: -4px; }
  .stats {
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
  }
  .stat {
    background: rgba(255,255,255,0.045); border: 1px solid rgba(245,247,255,0.08);
    border-radius: 20px; padding: 16px 20px; min-height: 96px;
  }
  .statValue { font-size: 34px; font-weight: 800; color: #F5C542; letter-spacing: 0.5px; }
  .statLabel { margin-top: 4px; font-size: 17px; color: #9FB0C8; }
  .statHint { margin-top: 2px; font-size: 14px; color: #6E819C; }
  .week { display: flex; align-items: center; gap: 22px; padding: 6px 2px 0; }
  .weekLabel { font-size: 17px; color: #9FB0C8; white-space: nowrap; }
  .weekChart { flex: 1; }
  .howto {
    margin-top: 4px; padding: 16px 22px; border-radius: 20px;
    background: rgba(91,231,240,0.06); border: 1px dashed rgba(91,231,240,0.35);
  }
  .howtoTitle { font-size: 15px; color: #8FA3BE; letter-spacing: 1px; }
  .howtoCmd { margin-top: 6px; font-size: 22px; font-weight: 700; color: #F5C542; letter-spacing: 0.4px; }
  .howtoHint { margin-top: 4px; font-size: 15px; color: #9FB0C8; }
  .wardrobe { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .wardrobeLabel { font-size: 17px; color: #9FB0C8; margin-right: 4px; }
  .chip {
    display: inline-flex; align-items: baseline; gap: 8px;
    padding: 8px 16px; border-radius: 999px; font-size: 18px; font-weight: 700;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(245,247,255,0.16);
  }
  .chip em { font-style: normal; font-size: 13px; font-weight: 500; color: #7C8DA6; }
  .footer {
    margin-top: auto; display: flex; align-items: center; justify-content: space-between;
    gap: 20px; font-size: 14px; color: #6E819C; letter-spacing: 0.3px; white-space: nowrap;
  }
  .footer b { color: #AFC1DA; font-weight: 700; }
</style></head>
<body><div class="card">
  <div class="header">
    <div class="brand">🐋 大肥鱼衣橱 <span>·</span> ${escapeHtml(title)}</div>
    <div class="date">${date}</div>
  </div>
  <div class="scene">${scene}</div>
  <div>
    <div class="identity">
      <div>
        <div class="name">${escapeHtml(state.fishName)}</div>
        <div class="sub">第 ${days} 天 · ${escapeHtml(summary.intimacy.emoji)} ${escapeHtml(summary.intimacy.title)} · ${starsOf(summary.intimacy.score)}</div>
      </div>
      <div class="mood">${escapeHtml(mood.emoji)} <b>${escapeHtml(mood.label)}</b></div>
    </div>
    <div class="quote">${escapeHtml(moodLine(mood.key))}</div>
  </div>
  <div class="stats">
    ${stat('投喂金额', formatCNY(summary.costCNY), `今日 ${formatCNY(summary.today.costCNY)}`)}
    ${stat('吃掉 Token', formatTokens(tokensTotal), `干饭 ${summary.meals} 顿`)}
    ${stat('互动次数', String(summary.interactions), `连续 ${summary.streakDays} 天`)}
    ${stat('亲密度', `${summary.intimacy.score}/100`, summary.intimacy.nextTitle ? `下一档：${summary.intimacy.nextTitle}` : '已满级')}
    ${stat('鱼粮币', formatCoins(summary.coins), 'token 换的')}
    ${stat('今日干饭', `${summary.today.meals} 顿`, formatCNY(summary.today.costCNY))}
  </div>
  <div class="week">
    <div class="weekLabel">近 7 天伙食</div>
    <div class="weekChart">${weekBarsSvg(state, config, now)}</div>
  </div>
  <div class="wardrobe">
    <span class="wardrobeLabel">今日穿搭</span>
    ${chipHtml || '<span class="chip" style="color:#8FA3BE">素鱼一条</span>'}
  </div>
  <div class="howto">
    <div class="howtoTitle">怎么养出同款</div>
    <div class="howtoCmd">dsh plugin --profile web add dsh-feiyu-wardrobe</div>
    <div class="howtoHint">照常让 agent 干活 → token 自动变成鱼粮 → /fish list 换装 · /fish report 出卡</div>
  </div>
  <div class="footer">
    <div><b>github.com/GIT121995/dsh-feiyu-wardrobe</b></div>
    <div>原创形象 · 非官方二创 · 数据只在本机</div>
  </div>
</div></body></html>`;
}

/**
 * A catalog sheet: every wearable rendered once (README / docs asset).
 * @returns {string}
 */
export function renderWardrobeSheetHtml() {
	const cells = ITEMS.map((item) => {
		/** @type {import('./state.js').FishState} */
		const fake = {
			version: 1,
			fishName: '大肥鱼',
			bornAt: 0,
			lastActiveAt: 0,
			lastMealAt: null,
			totals: {
				costCNY: 0,
				coinsEarned: 0,
				meals: 0,
				interactions: 0,
				turns: 0,
				tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 },
			},
			coins: 0,
			sessions: [],
			daily: {},
			streak: { lastDay: null, days: 0 },
			equipped: item.slot === 'bg' ? { bg: item.id } : { [item.slot]: item.id },
			owned: [item.id],
			updatedAt: 0,
		};
		const price = item.price === 0 ? '出生自带' : `${item.price} 币`;
		return `<div class="cell">
      <div class="mini">${sceneSvg(fake, { size: 200 })}</div>
      <div class="meta">
        <div class="cellName">${escapeHtml(item.name)} <span class="rarity" style="color:${rarityColor(item)}">${escapeHtml(rarityLabel(item.rarity))}</span></div>
        <div class="cellInfo">${escapeHtml(slotLabel(item.slot))} · ${price}</div>
      </div>
    </div>`;
	}).join('');
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>大肥鱼衣橱 · 衣柜</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #E9EEF4; font-family: -apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif; padding: 36px 44px 48px; }
  h1 { font-size: 30px; color: #1E2B3A; margin-bottom: 6px; }
  .sub { font-size: 14px; color: #6B7A8C; margin-bottom: 26px; }
  .grid { display: grid; grid-template-columns: repeat(7, 170px); gap: 16px; }
  .cell { background: #FFFFFF; border-radius: 18px; padding: 10px; box-shadow: 0 6px 18px rgba(30,50,80,0.08); }
  .mini { border-radius: 12px; overflow: hidden; background: #F4F9FF; }
  .meta { padding: 8px 4px 2px; }
  .cellName { font-size: 15px; font-weight: 700; color: #22303F; }
  .rarity { font-size: 11px; font-weight: 600; margin-left: 4px; }
  .cellInfo { margin-top: 3px; font-size: 12px; color: #7C8DA0; }
</style></head><body>
  <h1>🐋 大肥鱼衣橱 · 衣柜</h1>
  <div class="sub">${ITEMS.length} 件原创单品 · SVG 分层 · 投喂 token 赚鱼粮币解锁 · 非官方二创</div>
  <div class="grid">${cells}</div>
</body></html>`;
}
