/**
 * The wardrobe catalog: one original chubby whale plus hand-drawn SVG
 * wearables. Everything here is original artwork (no fan-art assets are
 * bundled); see README for the IP policy.
 *
 * Each item's `svg` is a fragment placed on a 360×360 canvas. Rendering order
 * is defined by SLOTS; the whale body itself lives in render.js.
 * @module dsh-feiyu-wardrobe/catalog
 */

/**
 * @typedef {'bg' | 'body' | 'neck' | 'face' | 'hand' | 'hat'} SlotId
 * @typedef {'common' | 'rare' | 'epic'} Rarity
 * @typedef {object} Item
 * @property {string} id
 * @property {string} name
 * @property {SlotId} slot
 * @property {Rarity} rarity
 * @property {number} price
 * @property {string} desc
 * @property {string} svg
 */

/** @type {Array<{ id: SlotId, label: string }>} */
export const SLOTS = [
	{ id: 'bg', label: '背景' },
	{ id: 'body', label: '身体' },
	{ id: 'neck', label: '颈部' },
	{ id: 'face', label: '面部' },
	{ id: 'hand', label: '手持' },
	{ id: 'hat', label: '头部' },
];

/** @type {Record<Rarity, { label: string, color: string }>} */
export const RARITIES = {
	common: { label: '普通', color: '#7A8CA3' },
	rare: { label: '稀有', color: '#3B82F6' },
	epic: { label: '史诗', color: '#A855F7' },
};

/** Items the fish owns from birth. */
export const STARTER_ITEMS = ['hat-leaf'];

/** @type {string[]} */
export const SLOT_ORDER = SLOTS.map((slot) => slot.id);

/** @type {Item[]} */
export const ITEMS = [
	// ——— backgrounds ———
	{
		id: 'bg-dawn',
		name: '晨光',
		slot: 'bg',
		rarity: 'common',
		price: 60,
		desc: '早上七点的光，适合赖床。',
		svg: `<g>
      <defs><linearGradient id="feiyu-grad-dawn" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#FFE9C9"/><stop offset="1" stop-color="#FFF7EC"/>
      </linearGradient></defs>
      <rect width="360" height="360" fill="url(#feiyu-grad-dawn)"/>
      <circle cx="292" cy="82" r="34" fill="#FFD27A"/>
      <circle cx="292" cy="82" r="46" fill="#FFD27A" opacity="0.25"/>
      <g fill="#FFFFFF" opacity="0.85">
        <ellipse cx="84" cy="86" rx="34" ry="16"/><ellipse cx="112" cy="78" rx="24" ry="13"/>
        <ellipse cx="66" cy="92" rx="18" ry="11"/>
      </g>
    </g>`,
	},
	{
		id: 'bg-tank',
		name: '鱼缸',
		slot: 'bg',
		rarity: 'common',
		price: 120,
		desc: '一室一厅，自带水草。',
		svg: `<g>
      <defs><linearGradient id="feiyu-grad-tank" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#EAF8FF"/><stop offset="1" stop-color="#C9EBFF"/>
      </linearGradient></defs>
      <rect width="360" height="360" fill="url(#feiyu-grad-tank)"/>
      <path d="M20 316 C60 296 120 312 180 300 C240 288 300 306 340 296 L340 360 L20 360 Z" fill="#F2E3C8"/>
      <path d="M56 316 C48 278 64 250 58 218 C72 252 74 286 70 316 Z" fill="#A8D8B9"/>
      <path d="M86 316 C80 286 92 264 86 240 C102 268 100 294 96 316 Z" fill="#8FCCA6"/>
      <g fill="#FFFFFF" opacity="0.75">
        <circle cx="300" cy="110" r="9"/><circle cx="318" cy="88" r="5"/><circle cx="286" cy="80" r="4"/>
        <circle cx="70" cy="150" r="6"/><circle cx="54" cy="182" r="4"/>
      </g>
    </g>`,
	},
	{
		id: 'bg-stars',
		name: '星空',
		slot: 'bg',
		rarity: 'rare',
		price: 200,
		desc: '今晚的星星，都归你。',
		svg: `<g>
      <defs><linearGradient id="feiyu-grad-stars" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#101A2E"/><stop offset="1" stop-color="#1D2B4A"/>
      </linearGradient></defs>
      <rect width="360" height="360" fill="url(#feiyu-grad-stars)"/>
      <g fill="#F5F7FF">
        <circle cx="52" cy="58" r="2.6"/><circle cx="118" cy="46" r="1.8"/><circle cx="236" cy="40" r="2"/>
        <circle cx="330" cy="120" r="2.4"/><circle cx="42" cy="240" r="2"/><circle cx="300" cy="300" r="2.2"/>
        <circle cx="268" cy="196" r="1.6"/><circle cx="92" cy="300" r="1.6"/><circle cx="160" cy="30" r="1.5"/>
      </g>
      <circle cx="304" cy="72" r="26" fill="#F5F7FF"/>
      <circle cx="296" cy="64" r="5" fill="#D7DEEF"/><circle cx="312" cy="80" r="3.5" fill="#D7DEEF"/>
      <path d="M264 300 C286 286 300 288 318 296" stroke="#F5F7FF" stroke-width="2" opacity="0.4" fill="none"/>
    </g>`,
	},
	{
		id: 'bg-cyber',
		name: '赛博网格',
		slot: 'bg',
		rarity: 'rare',
		price: 320,
		desc: '在霓虹里游泳，记得戴面罩。',
		svg: `<g>
      <rect width="360" height="360" fill="#0B1220"/>
      <g stroke="#5BE7F0" stroke-width="1.4" opacity="0.35">
        <path d="M0 60 H360 M0 120 H360 M0 180 H360 M0 240 H360 M0 300 H360"/>
        <path d="M60 0 V360 M120 0 V360 M180 0 V360 M240 0 V360 M300 0 V360"/>
      </g>
      <g stroke="#5BE7F0" stroke-width="2" opacity="0.7" fill="none">
        <path d="M24 330 L110 296 L170 326 L250 286 L336 316"/>
      </g>
      <circle cx="316" cy="64" r="30" fill="#5BE7F0" opacity="0.10"/>
      <circle cx="316" cy="64" r="16" fill="#5BE7F0" opacity="0.22"/>
      <g fill="#5BE7F0" opacity="0.6"><circle cx="40" cy="40" r="2"/><circle cx="332" cy="170" r="2"/></g>
    </g>`,
	},

	// ——— body ———
	{
		id: 'body-apron',
		name: '白围裙',
		slot: 'body',
		rarity: 'common',
		price: 150,
		desc: '开饭前先系上，专业。',
		svg: `<g>
      <path d="M150 236 L138 200 M192 236 L204 200" stroke="#C9D6E3" stroke-width="5" fill="none" stroke-linecap="round"/>
      <path d="M130 236 C140 250 202 250 212 236 L222 300 C190 312 150 312 118 300 Z" fill="#FFFFFF" stroke="#C9D6E3" stroke-width="3"/>
      <path d="M150 260 L150 296" stroke="#E3E9EF" stroke-width="2"/>
      <path d="M192 260 L192 296" stroke="#E3E9EF" stroke-width="2"/>
      <path d="M158 272 C162 266 172 266 176 272 C180 266 190 266 194 272 C190 282 176 288 176 288 C176 288 162 282 158 272 Z" fill="#FFB3C7" opacity="0.85"/>
    </g>`,
	},
	{
		id: 'body-blanket',
		name: '小毯子',
		slot: 'body',
		rarity: 'common',
		price: 180,
		desc: '躺平专用，温度刚好。',
		svg: `<g>
      <path d="M104 250 C130 268 214 268 240 250 L258 300 C212 318 132 318 86 300 Z" fill="#7B88D6" opacity="0.97"/>
      <path d="M118 258 C150 270 194 270 226 258" stroke="#9AA6E8" stroke-width="4" fill="none" stroke-dasharray="10 8"/>
      <g fill="#FFFFFF" opacity="0.8"><circle cx="108" cy="290" r="4"/><circle cx="128" cy="302" r="4"/><circle cx="236" cy="296" r="4"/></g>
      <text x="150" y="296" font-size="18" fill="#C9D2FF" font-family="sans-serif" font-weight="700">Z z</text>
    </g>`,
	},
	{
		id: 'body-astro',
		name: '宇航服',
		slot: 'body',
		rarity: 'rare',
		price: 400,
		desc: '为去捞月亮做的准备。',
		svg: `<g>
      <path d="M104 262 C120 284 224 284 240 262 L246 288 C216 306 128 306 98 288 Z" fill="#FFFFFF" stroke="#CFE6FF" stroke-width="3"/>
      <rect x="158" y="286" width="28" height="10" rx="5" fill="#5BE7F0" opacity="0.9"/>
      <rect x="282" y="196" width="16" height="42" rx="7" fill="#DCE8F5"/>
      <circle cx="290" cy="246" r="6" fill="#5BE7F0" opacity="0.85"/>
      <path d="M132 268 L148 292 M212 268 L196 292" stroke="#CFE6FF" stroke-width="3"/>
      <circle cx="128" cy="276" r="5" fill="#FFD27A"/>
    </g>`,
	},
	{
		id: 'body-suit',
		name: '小西装',
		slot: 'body',
		rarity: 'rare',
		price: 260,
		desc: '今天也要体面地搬砖。',
		svg: `<g>
      <path d="M120 250 C140 268 204 268 224 250 L240 302 C204 316 140 316 104 302 Z" fill="#33415C"/>
      <path d="M150 252 L172 282 L194 252 L184 246 L160 246 Z" fill="#F5F7FF"/>
      <path d="M158 246 L166 246 L162 256 Z" fill="#FF6B6B"/>
      <g fill="#F5C542"><circle cx="172" cy="292" r="3"/><circle cx="172" cy="304" r="3"/></g>
    </g>`,
	},

	// ——— neck ———
	{
		id: 'neck-scarf',
		name: '红围巾',
		slot: 'neck',
		rarity: 'common',
		price: 100,
		desc: '风大的时候，围住的是体面。',
		svg: `<g>
      <path d="M120 232 C150 246 194 246 224 232 L228 250 C196 262 148 262 116 250 Z" fill="#FF6B6B" stroke="#E05555" stroke-width="2"/>
      <path d="M228 244 L262 262 L252 278 L218 256 Z" fill="#FF8A8A" stroke="#E05555" stroke-width="2"/>
      <path d="M254 270 L248 282 M260 266 L256 278 M246 276 L240 286" stroke="#E05555" stroke-width="2" stroke-linecap="round"/>
    </g>`,
	},
	{
		id: 'neck-tie',
		name: '领带',
		slot: 'neck',
		rarity: 'common',
		price: 120,
		desc: '打上领带，假装很忙。',
		svg: `<g>
      <path d="M132 244 L166 240 L158 258 Z" fill="#F5F7FF" stroke="#C9D6E3" stroke-width="2"/>
      <path d="M212 244 L178 240 L186 258 Z" fill="#F5F7FF" stroke="#C9D6E3" stroke-width="2"/>
      <path d="M166 246 L184 246 L190 258 L176 292 L162 258 Z" fill="#FF6B6B" stroke="#E05555" stroke-width="2"/>
      <path d="M158 240 L192 240 L184 250 L166 250 Z" fill="#FF8A8A"/>
    </g>`,
	},
	{
		id: 'neck-shell',
		name: '贝壳项链',
		slot: 'neck',
		rarity: 'common',
		price: 90,
		desc: '海边捡的，不值钱但舍不得扔。',
		svg: `<g>
      <path d="M130 236 Q172 264 214 236" stroke="#C68A4A" stroke-width="2.5" fill="none"/>
      <path d="M158 252 C158 240 186 240 186 252 C186 262 172 268 172 268 C172 268 158 262 158 252 Z" fill="#FFC1D9" stroke="#E89BB6" stroke-width="2"/>
      <path d="M164 252 L172 238 M172 252 L172 238 M180 252 L172 238" stroke="#E89BB6" stroke-width="1.6" fill="none"/>
    </g>`,
	},

	// ——— face ———
	{
		id: 'face-glasses',
		name: '圆框眼镜',
		slot: 'face',
		rarity: 'common',
		price: 140,
		desc: '看起来会算数的样子。',
		svg: `<g>
      <g fill="#FFFFFF" opacity="0.28" stroke="#33415C" stroke-width="4">
        <rect x="118" y="174" width="42" height="28" rx="9"/>
        <rect x="186" y="174" width="42" height="28" rx="9"/>
      </g>
      <path d="M160 188 L186 188" stroke="#33415C" stroke-width="4"/>
      <path d="M118 184 L104 176 M228 184 L242 176" stroke="#33415C" stroke-width="4" stroke-linecap="round"/>
    </g>`,
	},
	{
		id: 'face-mask',
		name: '眼罩',
		slot: 'face',
		rarity: 'rare',
		price: 200,
		desc: '睡眠质量是鱼类核心竞争力。',
		svg: `<g>
      <rect x="116" y="172" width="112" height="32" rx="16" fill="#5D6BB8" stroke="#45539E" stroke-width="3"/>
      <path d="M116 188 L100 182 M228 188 L244 182" stroke="#45539E" stroke-width="5" stroke-linecap="round"/>
      <text x="152" y="194" font-size="15" fill="#C9D2FF" font-family="sans-serif" font-weight="700">Z Z</text>
    </g>`,
	},
	{
		id: 'face-visor',
		name: '赛博面罩',
		slot: 'face',
		rarity: 'epic',
		price: 380,
		desc: '已觉醒，但还在打工。',
		svg: `<g>
      <rect x="108" y="172" width="128" height="36" rx="12" fill="#0E2A3A" stroke="#5BE7F0" stroke-width="3"/>
      <rect x="124" y="184" width="42" height="9" rx="4.5" fill="#5BE7F0" opacity="0.9"/>
      <rect x="178" y="184" width="42" height="9" rx="4.5" fill="#5BE7F0" opacity="0.9"/>
      <path d="M108 190 L92 184 M236 190 L252 184" stroke="#3C4A6B" stroke-width="6" stroke-linecap="round"/>
      <ellipse cx="172" cy="196" rx="96" ry="30" fill="none" stroke="#5BE7F0" stroke-width="1.4" opacity="0.3" transform="rotate(-6 172 196)"/>
    </g>`,
	},

	// ——— hand ———
	{
		id: 'hand-bowl',
		name: '饭碗',
		slot: 'hand',
		rarity: 'common',
		price: 80,
		desc: '吃白饭是正经事。',
		svg: `<g>
      <path d="M120 300 C120 286 160 280 180 280 C200 280 240 286 240 300 Z" fill="#FFFFFF" stroke="#C9D6E3" stroke-width="3"/>
      <ellipse cx="180" cy="282" rx="58" ry="12" fill="#FFF6E5" stroke="#C9D6E3" stroke-width="3"/>
      <ellipse cx="180" cy="280" rx="44" ry="8" fill="#FFFFFF"/>
      <g fill="#FFFFFF" stroke="#E3E9EF" stroke-width="1.5">
        <ellipse cx="166" cy="276" rx="7" ry="5"/><ellipse cx="180" cy="272" rx="7" ry="5"/>
        <ellipse cx="194" cy="276" rx="7" ry="5"/><ellipse cx="174" cy="282" rx="7" ry="5"/>
        <ellipse cx="188" cy="282" rx="7" ry="5"/>
      </g>
      <g stroke="#C68A4A" stroke-width="5" stroke-linecap="round"><path d="M236 258 L262 276"/><path d="M244 252 L270 272"/></g>
    </g>`,
	},
	{
		id: 'hand-coffee',
		name: '咖啡杯',
		slot: 'hand',
		rarity: 'common',
		price: 120,
		desc: '续命用，鱼也喝美式。',
		svg: `<g>
      <rect x="268" y="238" width="42" height="36" rx="8" fill="#FFFFFF" stroke="#C9D6E3" stroke-width="3"/>
      <path d="M310 248 C326 248 326 272 310 272" fill="none" stroke="#C9D6E3" stroke-width="3"/>
      <rect x="276" y="246" width="26" height="10" rx="4" fill="#B07A4A" opacity="0.85"/>
      <path d="M284 228 C280 220 288 214 284 206" stroke="#C9D6E3" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M296 230 C292 222 300 216 296 208" stroke="#C9D6E3" stroke-width="3" fill="none" stroke-linecap="round"/>
    </g>`,
	},
	{
		id: 'hand-spoon',
		name: '木勺',
		slot: 'hand',
		rarity: 'common',
		price: 60,
		desc: '干饭的家伙事儿。',
		svg: `<g transform="rotate(-18 300 250)">
      <rect x="288" y="200" width="7" height="70" rx="3" fill="#C9D6E3"/>
      <circle cx="291" cy="276" r="16" fill="#C9D6E3"/>
      <circle cx="291" cy="276" r="9" fill="#E9EFF5"/>
    </g>`,
	},

	// ——— hat ———
	{
		id: 'hat-leaf',
		name: '小叶子',
		slot: 'hat',
		rarity: 'common',
		price: 0,
		desc: '出生自带，证明它是植物系的鱼。',
		svg: `<g>
      <path d="M172 108 C176 88 196 78 212 82 C208 100 192 112 172 108 Z" fill="#A8E6CF" stroke="#7BC9A8" stroke-width="2"/>
      <path d="M174 106 C184 96 198 88 206 86" stroke="#7BC9A8" stroke-width="1.8" fill="none"/>
    </g>`,
	},
	{
		id: 'hat-straw',
		name: '草帽',
		slot: 'hat',
		rarity: 'common',
		price: 120,
		desc: '防晒，也防老板。',
		svg: `<g>
      <ellipse cx="172" cy="138" rx="80" ry="17" fill="#F5C542" stroke="#D9A62E" stroke-width="3"/>
      <path d="M118 136 C118 104 226 104 226 136 Z" fill="#F5C542" stroke="#D9A62E" stroke-width="3"/>
      <path d="M120 128 C140 120 204 120 224 128" stroke="#FF6B6B" stroke-width="8" fill="none"/>
      <path d="M118 140 C140 148 204 148 226 140" stroke="#D9A62E" stroke-width="2" fill="none" opacity="0.6"/>
    </g>`,
	},
	{
		id: 'hat-nightcap',
		name: '睡帽',
		slot: 'hat',
		rarity: 'rare',
		price: 160,
		desc: '戴上就进入勿扰模式。',
		svg: `<g>
      <path d="M126 132 C130 96 214 96 218 132 C232 108 276 116 262 148 C250 174 236 178 224 160 L214 140 L130 140 Z" fill="#8C9BE8" stroke="#6C7BD0" stroke-width="3"/>
      <circle cx="262" cy="146" r="12" fill="#FFFFFF"/>
      <path d="M132 140 L214 140" stroke="#6C7BD0" stroke-width="3" opacity="0.6"/>
    </g>`,
	},
	{
		id: 'hat-crown',
		name: '王冠',
		slot: 'hat',
		rarity: 'epic',
		price: 600,
		desc: '鱼塘之王，饭量也是王。',
		svg: `<g>
      <path d="M132 132 L144 94 L160 116 L172 88 L184 116 L200 94 L212 132 Z" fill="#F5C542" stroke="#D9A62E" stroke-width="3" stroke-linejoin="round"/>
      <rect x="130" y="128" width="84" height="14" rx="6" fill="#F5C542" stroke="#D9A62E" stroke-width="2.5"/>
      <circle cx="150" cy="120" r="4" fill="#FF6B6B"/><circle cx="172" cy="114" r="4" fill="#5BE7F0"/><circle cx="194" cy="120" r="4" fill="#FF6B6B"/>
      <circle cx="172" cy="94" r="3.5" fill="#FFFFFF" opacity="0.9"/>
    </g>`,
	},
];

/** @type {Map<string, Item>} */
export const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

/**
 * @param {SlotId} slot
 * @returns {Item[]}
 */
export function itemsForSlot(slot) {
	return ITEMS.filter((item) => item.slot === slot);
}

/**
 * Find an item by id, exact name, or unique name substring (case-insensitive).
 * @param {string} query
 * @returns {Item | null}
 */
export function findItem(query) {
	const text = String(query ?? '').trim().toLowerCase();
	if (text.length === 0) return null;
	const direct = ITEM_BY_ID.get(text);
	if (direct) return direct;
	const byName = ITEMS.filter((item) => item.name.toLowerCase() === text);
	if (byName.length === 1) return byName[0];
	const partial = ITEMS.filter(
		(item) => item.id.includes(text) || item.name.toLowerCase().includes(text),
	);
	return partial.length === 1 ? partial[0] : null;
}

/**
 * @param {string} slot
 * @returns {string}
 */
export function slotLabel(slot) {
	return SLOTS.find((entry) => entry.id === slot)?.label ?? slot;
}

/**
 * @param {string} rarity
 * @returns {string}
 */
export function rarityLabel(rarity) {
	return RARITIES[/** @type {Rarity} */ (rarity)]?.label ?? rarity;
}
