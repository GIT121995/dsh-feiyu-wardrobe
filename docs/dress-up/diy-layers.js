/**
 * 大肥鱼衣橱 · DIY 自动成层（纯像素算法，浏览器 canvas 与 node 测试/QAA 共用）
 *
 * 输入（M0 路线，见 `.scratch/m0-diy/REPORT.md`）：
 *   - `look`：Seedream 生成的「角色穿着用户上传衣服」的 675×1200 渲染图（纯白背景）；
 *   - `flatout`：同姿势把衣服改成高反差平涂色（#808080）的编辑图（同构图、同坐标）；
 *   - `hair` / `arms`：现有身形的 hair / arms 层（675×1200，RGBA，alpha 即掩膜）。
 *
 * 核心收益（M0 实测）：flatout 是 look 的同姿势编辑，`|look - flatout|` 直接隔离衣服，
 * 不需要人工锚点、不需要形状配准（ECC 平移 0.05–0.33px@675）。因此本模块**不做**几何
 * 重采样，只做像素级 matte / 补洞 / 拆袖 / 自动 QA。
 *
 * 输出：body alpha（+ 可选的 sleeve alpha）、自动 QA 指标与分级。
 * 纯函数、无 DOM / 无网络；浏览器把 alpha 贴到 look 的 RGB 上即得图层。
 *
 * @module dsh-feiyu-wardrobe/diy-layers
 */

import { DIY_CATEGORY_SLOTS } from './diy-guard.js';

/** 目标画布（与全部 675×1200 分层素材一致）。 */
export const DIY_CANVAS = { width: 675, height: 1200 };

/** 降阈值序列（M0 §4：浅色衣服需要更低阈值才能覆盖整件衣身）。 */
export const DIFF_THRESHOLDS = [40, 30, 22, 16, 12, 9];

/** 自适应阈值可接受的衣服面积占比（画布口径）。 */
export const ALPHA_AREA_RANGE = { min: 0.004, max: 0.32 };

/** 袖子层最小像素占比（低于此视为无袖）。 */
export const SLEEVE_MIN_FRAC = 0.002;

/** 白边/近白边缘告警阈值。 */
export const WHITE_FRINGE_MAX = 0.05;

/** 同姿势配准告警阈值（675px）。 */
export const MAX_POSE_SHIFT_PX = 2.0;

/**
 * @typedef {object} RgbaImage 画布像素（RGBA，0–255）
 * @property {number} width
 * @property {number} height
 * @property {Uint8ClampedArray} data
 */

/**
 * @typedef {object} DiyLayerInput
 * @property {RgbaImage} look 角色穿衣服的 look
 * @property {RgbaImage | null} flatout 同姿势平涂色版（必需，缺省时成层失败）
 * @property {RgbaImage} hair 身形前发层（alpha 作掩膜）
 * @property {RgbaImage} arms 身形手臂层（alpha 作掩膜）
 * @property {'top'|'bottom'|'dress'|'coat'|'outfit'} category 衣服品类
 * @property {Partial<DiyLayerOptions>} [options]
 */

/**
 * @typedef {object} DiyLayerOptions
 * @property {number} headFraction 衣服区域上界（画布高度比例，Q版头部很大，默认 0.36）
 * @property {number} diffThreshold 固定阈值（不给则自适应）
 * @property {number} hairCutRadius 头发掩膜膨胀半径（默认 3）
 * @property {number} closeRadius 闭运算半径（默认 7）
 * @property {number} maxGrow 闭运算后允许外扩像素（默认 8）
 * @property {number} lookFgThreshold look/flatout 前景判定阈值（对白色背景，默认 245）
 * @property {number} featherRadius alpha 羽化/收缩半径（默认 1）
 * @property {number} armsDilate 拆袖用的手臂掩膜膨胀（默认 6）
 * @property {boolean} measureTiming 是否记录耗时（默认 true）
 * @property {boolean} collectPhases 是否记录分阶段耗时（QA/dev 用，默认 false）
 */

/** @type {Required<DiyLayerOptions>} */
const DEFAULT_OPTIONS = {
	headFraction: 0.36,
	diffThreshold: 0,
	hairCutRadius: 3,
	closeRadius: 7,
	maxGrow: 8,
	lookFgThreshold: 245,
	featherRadius: 1,
	armsDilate: 6,
	measureTiming: true,
	collectPhases: false,
};

/* ---------------- 基础工具 ---------------- */

/**
 * 当前时间（毫秒）：浏览器/Node 都有 performance.now，退化到 Date.now。
 * @returns {number}
 */
function nowMs() {
	return typeof performance !== 'undefined' && typeof performance.now === 'function'
		? performance.now()
		: Date.now();
}

/**
 * 校验 RGBA 图像尺寸一致。
 * @param {RgbaImage} image
 * @param {number} width
 * @param {number} height
 * @param {string} label
 * @returns {boolean}
 */
function validImage(image, width, height, label) {
	if (!image || typeof image.width !== 'number' || !image.data || typeof image.data.length !== 'number') {
		void label;
		return false;
	}
	return image.width === width && image.height === height && image.data.length >= width * height * 4;
}

/**
 * 创建一张空 RGBA 画布。
 * @param {number} width
 * @param {number} height
 * @param {[number, number, number, number]} [fill]
 * @returns {RgbaImage}
 */
export function createRgbaImage(width, height, fill = [0, 0, 0, 0]) {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < width * height; i += 1) {
		data[i * 4] = fill[0];
		data[i * 4 + 1] = fill[1];
		data[i * 4 + 2] = fill[2];
		data[i * 4 + 3] = fill[3];
	}
	return { width, height, data };
}

/**
 * 新建二值掩膜（0/1）。
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function createMask(width, height) {
	return new Uint8Array(width * height);
}

/**
 * 掩膜像素数。
 * @param {Uint8Array} mask
 * @returns {number}
 */
export function countMask(mask) {
	let count = 0;
	for (let i = 0; i < mask.length; i += 1) if (mask[i]) count += 1;
	return count;
}

/**
 * 掩膜包围盒（x1/y1 为开区间）。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {{ x0: number, y0: number, x1: number, y1: number, width: number, height: number, count: number } | null}
 */
export function maskBounds(mask, width, height) {
	let x0 = width;
	let y0 = height;
	let x1 = -1;
	let y1 = -1;
	let count = 0;
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		for (let x = 0; x < width; x += 1) {
			if (!mask[row + x]) continue;
			count += 1;
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
		}
	}
	if (count === 0) return null;
	return { x0, y0, x1: x1 + 1, y1: y1 + 1, width: x1 - x0 + 1, height: y1 - y0 + 1, count };
}

/**
 * 取 RGBA 图像的 alpha 通道（0–255）。
 * @param {RgbaImage} image
 * @returns {Uint8ClampedArray}
 */
export function alphaChannel(image) {
	const out = new Uint8ClampedArray(image.width * image.height);
	for (let i = 0; i < out.length; i += 1) out[i] = image.data[i * 4 + 3];
	return out;
}

/**
 * alpha 通道 → 二值掩膜（>127）。
 * @param {Uint8ClampedArray} alpha
 * @returns {Uint8Array}
 */
export function alphaToMask(alpha) {
	const mask = new Uint8Array(alpha.length);
	for (let i = 0; i < alpha.length; i += 1) mask[i] = alpha[i] > 127 ? 1 : 0;
	return mask;
}

/**
 * 两图 RGB 最大通道差（0–255）。
 * @param {RgbaImage} a
 * @param {RgbaImage} b
 * @returns {Uint8Array}
 */
export function diffMap(a, b) {
	const w = a.width;
	const h = a.height;
	const out = new Uint8Array(w * h);
	const da = a.data;
	const db = b.data;
	for (let i = 0; i < w * h; i += 1) {
		const p = i * 4;
		const dr = Math.abs(da[p] - db[p]);
		const dg = Math.abs(da[p + 1] - db[p + 1]);
		const dbv = Math.abs(da[p + 2] - db[p + 2]);
		out[i] = dr > dg ? (dr > dbv ? dr : dbv) : dg > dbv ? dg : dbv;
	}
	return out;
}

/**
 * 对白色背景估计前景（角色剪影）。纯白背景由 M0 prompt 保证。
 * @param {RgbaImage} image
 * @param {number} [threshold] 与纯白的最大通道差阈值，默认 245（只排除纯白/近白背景）
 * @returns {Uint8Array} 0/1 掩膜
 */
export function foregroundMask(image, threshold = DEFAULT_OPTIONS.lookFgThreshold) {
	const width = image.width;
	const height = image.height;
	const raw = new Uint8Array(width * height);
	const data = image.data;
	for (let i = 0; i < raw.length; i += 1) {
		const p = i * 4;
		const r = data[p];
		const g = data[p + 1];
		const b = data[p + 2];
		const min = r < g ? (r < b ? r : b) : g < b ? g : b;
		raw[i] = min < threshold ? 1 : 0;
	}
	// 白色衣服（白衬衫/白卫衣）落在纯白背景上：靠 26 阈值会挖掉整片衣身。
	// 白衣服被深色描边/皮肤/头发包围，属于「不连到画布边界的洞」→ 填洞后即为前景。
	return fillHolesMask(raw, width, height);
}

/* ---------------- 形态学（O(n)，可分离前缀和） ---------------- */

/**
 * 二值掩膜膨胀（方形核，可分离）：每行/每列滑动窗口 OR。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} radius 0 表示原样复制
 * @returns {Uint8Array}
 */
export function dilateMask(mask, width, height, radius) {
	if (radius <= 0) return mask.slice();
	const total = width * height;
	/** @type {Uint8Array} 水平膨胀结果（垂直 pass 的只读源） */
	const horizontal = new Uint8Array(total);
	const limit = Math.min(radius, width - 1);
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		let count = 0;
		for (let x = 0; x <= limit; x += 1) count += mask[row + x];
		for (let x = 0; x < width; x += 1) {
			horizontal[row + x] = count > 0 ? 1 : 0;
			const add = x + radius + 1;
			if (add < width) count += mask[row + add];
			const remove = x - radius;
			if (remove >= 0) count -= mask[row + remove];
		}
	}
	const out = new Uint8Array(total);
	const counts = new Int32Array(width);
	const topEnd = Math.min(radius, height - 1);
	for (let y = 0; y <= topEnd; y += 1) {
		const row = y * width;
		for (let x = 0; x < width; x += 1) counts[x] += horizontal[row + x];
	}
	const tmpRow = new Uint8Array(width);
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		for (let x = 0; x < width; x += 1) tmpRow[x] = counts[x] > 0 ? 1 : 0;
		out.set(tmpRow, row);
		const addRow = y + radius + 1;
		if (addRow < height) {
			const base = addRow * width;
			for (let x = 0; x < width; x += 1) counts[x] += horizontal[base + x];
		}
		const removeRow = y - radius;
		if (removeRow >= 0) {
			const base = removeRow * width;
			for (let x = 0; x < width; x += 1) counts[x] -= horizontal[base + x];
		}
	}
	return out;
}

/**
 * 二值掩膜腐蚀（方形核，可分离）：窗口内全 1 才保留。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Uint8Array}
 */
export function erodeMask(mask, width, height, radius) {
	if (radius <= 0) return mask.slice();
	const total = width * height;
	/** @type {Uint8Array} 水平腐蚀结果（垂直 pass 的只读源） */
	const horizontal = new Uint8Array(total);
	const needH = new Int32Array(width);
	for (let x = 0; x < width; x += 1) {
		const lo = x - radius < 0 ? 0 : x - radius;
		const hi = x + radius + 1 > width ? width : x + radius + 1;
		needH[x] = hi - lo;
	}
	const limit = Math.min(radius, width - 1);
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		let count = 0;
		for (let x = 0; x <= limit; x += 1) count += mask[row + x];
		for (let x = 0; x < width; x += 1) {
			horizontal[row + x] = count === needH[x] ? 1 : 0;
			const add = x + radius + 1;
			if (add < width) count += mask[row + add];
			const remove = x - radius;
			if (remove >= 0) count -= mask[row + remove];
		}
	}
	const out = new Uint8Array(total);
	const counts = new Int32Array(width);
	const topEnd = Math.min(radius, height - 1);
	for (let y = 0; y <= topEnd; y += 1) {
		const row = y * width;
		for (let x = 0; x < width; x += 1) counts[x] += horizontal[row + x];
	}
	const tmpRow = new Uint8Array(width);
	for (let y = 0; y < height; y += 1) {
		const lo = y - radius < 0 ? 0 : y - radius;
		const hi = y + radius + 1 > height ? height : y + radius + 1;
		const need = hi - lo;
		const row = y * width;
		for (let x = 0; x < width; x += 1) tmpRow[x] = counts[x] === need ? 1 : 0;
		out.set(tmpRow, row);
		const addRow = y + radius + 1;
		if (addRow < height) {
			const base = addRow * width;
			for (let x = 0; x < width; x += 1) counts[x] += horizontal[base + x];
		}
		const removeRow = y - radius;
		if (removeRow >= 0) {
			const base = removeRow * width;
			for (let x = 0; x < width; x += 1) counts[x] -= horizontal[base + x];
		}
	}
	return out;
}

/**
 * 边缘带（1px）：掩膜内/外相邻的像素对（单遍，无需膨胀/腐蚀整图）。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function edgeBandMask(mask, width, height) {
	const band = new Uint8Array(width * height);
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		for (let x = 0; x < width; x += 1) {
			const index = row + x;
			const here = mask[index];
			if (x < width - 1) {
				const right = index + 1;
				if (here !== mask[right]) {
					band[index] = 1;
					band[right] = 1;
				}
			}
			if (y < height - 1) {
				const down = index + width;
				if (here !== mask[down]) {
					band[index] = 1;
					band[down] = 1;
				}
			}
		}
	}
	return band;
}

/**
 * 掩膜闭运算（先膨胀后腐蚀），用于补掉头发/描边在衣服上划出的细通道。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Uint8Array}
 */
export function closeMask(mask, width, height, radius) {
	return erodeMask(dilateMask(mask, width, height, radius), width, height, radius);
}

/** fillHoles 的复用 scratch（同尺寸顺序调用，无并发；调用方之间不保留引用）。 */
const floodScratch = new Map();
/**
 * @param {number} total
 * @returns {{ outside: Uint8Array, stack: Int32Array, spanA: Int32Array, spanB: Int32Array, spanY: Int32Array }}
 */
function scratchFor(total) {
	let entry = floodScratch.get(total);
	if (!entry) {
		entry = {
			outside: new Uint8Array(total),
			stack: new Int32Array(1),
			spanA: new Int32Array(total),
			spanB: new Int32Array(total),
			spanY: new Int32Array(total),
		};
		floodScratch.set(total, entry);
	}
	return entry;
}

/**
 * 填充掩膜内部拓扑洞（不接触画布边界的 0 区域）。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array} 新掩膜（含洞）
 */
export function fillHolesMask(mask, width, height) {
	const total = width * height;
	const scratch = scratchFor(total);
	const outside = scratch.outside;
	const stack = scratch.stack;
	outside.fill(0);
	let top = 0;
	// 扫描线 flood fill：每个被标记的 span 压栈（x1, x2, y），比逐像素 BFS 快数倍
	const spanA = scratch.spanA;
	const spanB = scratch.spanB;
	const spanY = scratch.spanY;
	/**
	 * 从 (x, y) 出发，标记整条连续背景 span 并压栈。
	 * @param {number} x
	 * @param {number} y
	 */
	const pushSpan = (x, y) => {
		if (y < 0 || y >= height) return;
		const row = y * width;
		if (mask[row + x] || outside[row + x]) return;
		let x1 = x;
		while (x1 > 0 && !mask[row + x1 - 1] && !outside[row + x1 - 1]) x1 -= 1;
		let x2 = x;
		while (x2 < width - 1 && !mask[row + x2 + 1] && !outside[row + x2 + 1]) x2 += 1;
		outside.fill(1, row + x1, row + x2 + 1);
		spanA[top] = x1;
		spanB[top] = x2;
		spanY[top] = y;
		top += 1;
	};
	// 四周边界像素作为种子
	for (let x = 0; x < width; x += 1) {
		if (!mask[x]) pushSpan(x, 0);
		const bottom = (height - 1) * width + x;
		if (!mask[bottom]) pushSpan(x, height - 1);
	}
	for (let y = 0; y < height; y += 1) {
		pushSpan(0, y);
		pushSpan(width - 1, y);
	}
	while (top > 0) {
		top -= 1;
		const x1 = spanA[top];
		const x2 = spanB[top];
		const y = spanY[top];
		for (const ny of [y - 1, y + 1]) {
			if (ny < 0 || ny >= height) continue;
			const row = ny * width;
			for (let x = x1; x <= x2; x += 1) {
				if (!mask[row + x] && !outside[row + x]) pushSpan(x, ny);
			}
		}
	}
	const out = new Uint8Array(total);
	for (let i = 0; i < total; i += 1) out[i] = mask[i] || !outside[i] ? 1 : 0;
	return out;
}

/**
 * 只保留面积 ≥ minArea 的连通块（8 连通，两遍 union-find）。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} minArea
 * @returns {Uint8Array}
 */
export function keepLargeComponents(mask, width, height, minArea) {
	const total = width * height;
	const labels = new Int32Array(total); // 0 = 未标记
	/** @type {number[]} */
	const parent = [0];
	const find = (/** @type {number} */ label) => {
		let root = label;
		while (parent[root] !== root) root = parent[root];
		while (parent[label] !== root) {
			const next = parent[label];
			parent[label] = root;
			label = next;
		}
		return root;
	};
	const union = (/** @type {number} */ a, /** @type {number} */ b) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[rb] = ra;
	};
	let nextLabel = 1;
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const index = y * width + x;
			if (!mask[index]) continue;
			let label = 0;
			// 左边 + 上左/上/上右：8 连通的两遍法（按行扫描，右/下邻居尚未标记）
			if (x > 0 && labels[index - 1]) label = labels[index - 1];
			if (y > 0) {
				const up = index - width;
				if (labels[up]) {
					if (label === 0) label = labels[up];
					else union(label, labels[up]);
				}
				if (x > 0 && labels[up - 1]) {
					if (label === 0) label = labels[up - 1];
					else union(label, labels[up - 1]);
				}
				if (x < width - 1 && labels[up + 1]) {
					if (label === 0) label = labels[up + 1];
					else union(label, labels[up + 1]);
				}
			}
			if (label === 0) {
				label = nextLabel;
				nextLabel += 1;
				parent.push(label);
			}
			labels[index] = label;
		}
	}
	const areas = new Int32Array(nextLabel);
	for (let i = 0; i < total; i += 1) {
		if (labels[i]) areas[find(labels[i])] += 1;
	}
	const out = new Uint8Array(total);
	for (let i = 0; i < total; i += 1) {
		if (labels[i] && areas[find(labels[i])] >= minArea) out[i] = 1;
	}
	return out;
}

/**
 * 对 0–255 alpha 做 1px 方形盒式模糊（可分离前缀和）。
 * @param {Uint8ClampedArray | Uint8Array} alpha
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Uint8ClampedArray}
 */
export function blurAlpha(alpha, width, height, radius) {
	if (radius <= 0) return Uint8ClampedArray.from(alpha);
	if (radius === 1) {
		// 3×3 盒式模糊：两遍滑动窗口，避免前缀和数组分配（拆袖/羽化高频路径）
		/** @type {Float32Array} */
		const tmp = new Float32Array(width * height);
		for (let y = 0; y < height; y += 1) {
			const row = y * width;
			for (let x = 0; x < width; x += 1) {
				const left = x > 0 ? alpha[row + x - 1] : alpha[row];
				const right = x < width - 1 ? alpha[row + x + 1] : alpha[row + x];
				tmp[row + x] = (left + alpha[row + x] + right) / 3;
			}
		}
		const out = new Uint8ClampedArray(width * height);
		for (let y = 0; y < height; y += 1) {
			const up = (y > 0 ? y - 1 : y) * width;
			const down = (y < height - 1 ? y + 1 : y) * width;
			const row = y * width;
			for (let x = 0; x < width; x += 1) {
				out[row + x] = (tmp[up + x] + tmp[row + x] + tmp[down + x]) / 3;
			}
		}
		return out;
	}
	/** @type {Float32Array} */
	const tmp = new Float32Array(width * height);
	const prefix = new Float32Array(width + 1);
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		prefix[0] = 0;
		for (let x = 0; x < width; x += 1) prefix[x + 1] = prefix[x] + alpha[row + x];
		for (let x = 0; x < width; x += 1) {
			const lo = x - radius < 0 ? 0 : x - radius;
			const hi = x + radius + 1 > width ? width : x + radius + 1;
			tmp[row + x] = (prefix[hi] - prefix[lo]) / (hi - lo);
		}
	}
	const out = new Uint8ClampedArray(width * height);
	const colPrefix = new Float32Array(height + 1);
	for (let x = 0; x < width; x += 1) {
		colPrefix[0] = 0;
		for (let y = 0; y < height; y += 1) colPrefix[y + 1] = colPrefix[y] + tmp[y * width + x];
		for (let y = 0; y < height; y += 1) {
			const lo = y - radius < 0 ? 0 : y - radius;
			const hi = y + radius + 1 > height ? height : y + radius + 1;
			out[y * width + x] = (colPrefix[hi] - colPrefix[lo]) / (hi - lo);
		}
	}
	return out;
}

/**
 * alpha 微收缩/羽化：先 1px 盒式模糊再线性收缩（等价 M0 的 blur(σ0.9)×1.05−6）。
 * @param {Uint8ClampedArray | Uint8Array} alpha 0–255
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Uint8ClampedArray}
 */
export function featherAlpha(alpha, width, height, radius) {
	const blurred = blurAlpha(alpha, width, height, Math.max(1, radius));
	const out = new Uint8ClampedArray(width * height);
	for (let i = 0; i < out.length; i += 1) {
		const value = blurred[i] * 1.05 - 6;
		out[i] = value < 0 ? 0 : value > 255 ? 255 : value;
	}
	return out;
}

/**
 * alpha 微收缩/羽化（等价 M0 的 blur(σ0.9) × 1.05 − 6，在 675 口径下用 1px 盒式模糊 + 线性收缩）。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @returns {Uint8ClampedArray}
 */
export function featherMask(mask, width, height, radius) {
	const full = new Uint8ClampedArray(width * height);
	for (let i = 0; i < full.length; i += 1) full[i] = mask[i] ? 255 : 0;
	const blurred = blurAlpha(full, width, height, Math.max(1, radius));
	const out = new Uint8ClampedArray(width * height);
	for (let i = 0; i < out.length; i += 1) {
		const value = blurred[i] * 1.05 - 6;
		out[i] = value < 0 ? 0 : value > 255 ? 255 : value;
	}
	return out;
}

/* ---------------- 皮肤 / 拆袖 ---------------- */

/**
 * look 上的肤色掩膜（M0 `skin_mask` 的 675 口径版本）。
 * @param {RgbaImage} image
 * @returns {Uint8Array}
 */
export function skinMask(image) {
	const mask = new Uint8Array(image.width * image.height);
	const data = image.data;
	for (let i = 0; i < mask.length; i += 1) {
		const p = i * 4;
		const r = data[p];
		const g = data[p + 1];
		const b = data[p + 2];
		const lum = (r + g + b) / 3;
		mask[i] = r - g > 6 && g - b > -8 && r > 200 && lum > 165 ? 1 : 0;
	}
	return mask;
}

/**
 * 手部区域（用于把 sleeve 从手上裁掉）：几何下限 + look 真值肤色。
 * @param {RgbaImage} look
 * @param {Uint8Array} armsMask 手臂掩膜
 * @param {number} width
 * @param {number} height
 * @param {number} dilateRadius
 * @returns {Uint8Array}
 */
export function handRegionMask(look, armsMask, width, height, dilateRadius = 5) {
	const bounds = maskBounds(armsMask, width, height);
	/** @type {Uint8Array} */
	const geom = new Uint8Array(width * height);
	if (!bounds) return geom;
	const cutY = bounds.y0 + Math.floor(bounds.height * 0.78);
	const lowY = bounds.y0 + Math.floor(bounds.height * 0.55);
	const skin = skinMask(look);
	/** @type {Uint8Array} */
	const raw = new Uint8Array(width * height);
	for (let y = cutY; y < bounds.y1; y += 1) {
		for (let x = bounds.x0; x < bounds.x1; x += 1) {
			const index = y * width + x;
			if (armsMask[index]) raw[index] = 1;
		}
	}
	for (let y = lowY; y < bounds.y1; y += 1) {
		for (let x = bounds.x0; x < bounds.x1; x += 1) {
			const index = y * width + x;
			if (armsMask[index] && skin[index]) raw[index] = 1;
		}
	}
	const grown = dilateMask(raw, width, height, dilateRadius);
	for (let i = 0; i < grown.length; i += 1) geom[i] = grown[i] && armsMask[i] ? 1 : 0;
	return geom;
}

/**
 * fill-under-hair 反投影：对每一行，在衣服 α 的左右极值之间，把被头发覆盖的像素补成 α。
 *
 * 依据：look 与 flatout 里头发完全一致 → 头发遮挡区 diff≈0、α 缺失；但头发下沿同一行
 * 两侧通常仍能看到衣身，取「该行 α 的左右极值」即为衣服在这些行的真实横向范围，
 * 中间被头发盖住的部分按反投影补 α（更接近 M0 建议的 hair ∩ 衣服 bbox 反投影）。
 *
 * @param {Uint8Array} alpha 衣服掩膜（会被读取，不修改）
 * @param {Uint8Array} hairMask 前发掩膜（已按需膨胀）
 * @param {Uint8Array} keepMask 允许补洞的区域（角色前景），可为 null
 * @param {number} width
 * @param {number} height
 * @returns {{ alpha: Uint8Array, filled: number }}
 */
export function fillUnderHairRows(alpha, hairMask, keepMask, width, height) {
	const out = alpha.slice();
	let filled = 0;
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		let left = -1;
		let right = -1;
		for (let x = 0; x < width; x += 1) {
			if (alpha[row + x]) {
				left = x;
				break;
			}
		}
		for (let x = width - 1; x >= 0; x -= 1) {
			if (alpha[row + x]) {
				right = x;
				break;
			}
		}
		if (left < 0 || right <= left) continue;
		for (let x = left + 1; x < right; x += 1) {
			const index = row + x;
			if (!hairMask[index] || out[index]) continue;
			if (keepMask && !keepMask[index]) continue;
			out[index] = 1;
			filled += 1;
		}
	}
	return { alpha: out, filled };
}

/**
 * 拆袖：garment alpha ∩ dilate(arms, 6px) − 手部区域，羽化后作为 sleeve 层。
 * @param {RgbaImage} look
 * @param {Uint8Array} alphaMask 衣身 alpha（二值）
 * @param {Uint8Array} armsMask
 * @param {number} width
 * @param {number} height
 * @param {number} armsDilate
 * @returns {{ alpha: Uint8ClampedArray, frac: number } | null}
 */
export function splitSleeveAlpha(look, alphaMask, armsMask, width, height, armsDilate = 6, bodyAlpha = null) {
	const grownArms = dilateMask(armsMask, width, height, armsDilate);
	// 手部区域 = 手臂 bbox 下部几何矩形 ∩ arms + look 露肤的袖口下手臂；两层都已包含手，
	// 不额外膨胀（省一次全图形态学，M0 的 9px 膨胀是为配准误差兜底，本管线同坐标无配准）。
	const hand = handRegionMask(look, armsMask, width, height, 0);
	const feather = bodyAlpha ? Uint8ClampedArray.from(bodyAlpha) : featherMask(alphaMask, width, height, 1);
	/** @type {Uint8ClampedArray} */
	const sleeve = new Uint8ClampedArray(width * height);
	let covered = 0;
	for (let i = 0; i < sleeve.length; i += 1) {
		if (grownArms[i] && !hand[i]) {
			sleeve[i] = feather[i];
			if (sleeve[i] > 20) covered += 1;
		}
	}
	const frac = covered / (width * height);
	if (frac < SLEEVE_MIN_FRAC) return null;
	const smoothed = blurAlpha(sleeve, width, height, 1);
	return { alpha: smoothed, frac };
}

/* ---------------- 自适应阈值选 alpha ---------------- */

/**
 * 自适应阈值：选择「面积首次达到 3% 画布」的最高阈值（浅色衣服自动降到更低阈值）。
 * @param {Uint8Array} diff
 * @param {number} width
 * @param {number} height
 * @param {{ x0: number, y0: number, x1: number, y1: number }} region
 * @returns {{ threshold: number, frac: number }}
 */
export function chooseThreshold(diff, width, height, region) {
	const canvasArea = width * height;
	/** @type {{ threshold: number, frac: number }} */
	let fallback = { threshold: 9, frac: 0 };
	for (const threshold of DIFF_THRESHOLDS) {
		let count = 0;
		for (let y = region.y0; y < region.y1; y += 1) {
			const row = y * width;
			for (let x = region.x0; x < region.x1; x += 1) if (diff[row + x] > threshold) count += 1;
		}
		const frac = count / canvasArea;
		if (threshold === 9) fallback = { threshold, frac };
		if (frac >= 0.03 && frac <= 0.25) return { threshold, frac };
	}
	return fallback;
}

/**
 * 衣服「是否浅色/白色」分类（自适应阈值的可解释输出；始终用 flatout diff 成层，
 * 该分类只进 QA 报告）。
 * @param {RgbaImage} look
 * @param {Uint8Array} mask
 * @returns {{ white: boolean, meanRgb: [number, number, number], nearWhiteFrac: number }}
 */
export function classifyGarmentColor(look, mask) {
	let count = 0;
	let sumR = 0;
	let sumG = 0;
	let sumB = 0;
	let nearWhite = 0;
	for (let i = 0; i < mask.length; i += 1) {
		if (!mask[i]) continue;
		const p = i * 4;
		const r = look.data[p];
		const g = look.data[p + 1];
		const b = look.data[p + 2];
		count += 1;
		sumR += r;
		sumG += g;
		sumB += b;
		const min = r < g ? (r < b ? r : b) : g < b ? g : b;
		const max = r > g ? (r > b ? r : b) : g > b ? g : b;
		if (min > 215 && max - min < 35) nearWhite += 1;
	}
	if (count === 0) return { white: false, meanRgb: [0, 0, 0], nearWhiteFrac: 0 };
	return {
		white: nearWhite / count > 0.5,
		meanRgb: [Math.round(sumR / count), Math.round(sumG / count), Math.round(sumB / count)],
		nearWhiteFrac: Number((nearWhite / count).toFixed(3)),
	};
}

/**
 * 同姿势配准质量（同构图 whiteout/flatout 的核心假设：不做几何重采样，只量化偏差）。
 * @param {Uint8Array} lookFg
 * @param {Uint8Array} flatFg
 * @param {number} width
 * @param {number} height
 * @returns {{ shiftPx: number, dx: number, dy: number, iou: number, ok: boolean }}
 */
export function poseRegistration(lookFg, flatFg, width, height) {
	let lookCount = 0;
	let flatCount = 0;
	let lookX = 0;
	let lookY = 0;
	let flatX = 0;
	let flatY = 0;
	let intersection = 0;
	let union = 0;
	for (let y = 0; y < height; y += 1) {
		const row = y * width;
		for (let x = 0; x < width; x += 1) {
			const a = lookFg[row + x];
			const b = flatFg[row + x];
			if (a) {
				lookCount += 1;
				lookX += x;
				lookY += y;
			}
			if (b) {
				flatCount += 1;
				flatX += x;
				flatY += y;
			}
			if (a && b) intersection += 1;
			if (a || b) union += 1;
		}
	}
	if (!lookCount || !flatCount || !union) {
		return { shiftPx: 0, dx: 0, dy: 0, iou: 0, ok: false };
	}
	const dx = flatX / flatCount - lookX / lookCount;
	const dy = flatY / flatCount - lookY / lookCount;
	return {
		shiftPx: Number(Math.hypot(dx, dy).toFixed(2)),
		dx: Number(dx.toFixed(2)),
		dy: Number(dy.toFixed(2)),
		iou: Number((intersection / union).toFixed(4)),
		ok: true,
	};
}

/* ---------------- 半分辨率拓扑 / 全分辨率边缘 ---------------- */

/**
 * 2×2 多数投票降采样二值掩膜（675→338/600 口径），拓扑运算提速 ~4×。
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {{ mask: Uint8Array, width: number, height: number }}
 */
export function downsampleMask(mask, width, height) {
	const hw = Math.max(1, width >> 1);
	const hh = Math.max(1, height >> 1);
	const out = new Uint8Array(hw * hh);
	for (let y = 0; y < hh; y += 1) {
		const y0 = y * 2;
		const y1 = Math.min(height - 1, y0 + 1);
		for (let x = 0; x < hw; x += 1) {
			const x0 = x * 2;
			const x1 = Math.min(width - 1, x0 + 1);
			const sum = mask[y0 * width + x0] + mask[y0 * width + x1] + mask[y1 * width + x0] + mask[y1 * width + x1];
			out[y * hw + x] = sum >= 2 ? 1 : 0;
		}
	}
	return { mask: out, width: hw, height: hh };
}

/**
 * 2×2 最大值降采样 diff 图（保留衣服边缘的高差值）。
 * @param {Uint8Array} diff
 * @param {number} width
 * @param {number} height
 * @returns {{ diff: Uint8Array, width: number, height: number }}
 */
export function downsampleDiff(diff, width, height) {
	const hw = Math.max(1, width >> 1);
	const hh = Math.max(1, height >> 1);
	const out = new Uint8Array(hw * hh);
	for (let y = 0; y < hh; y += 1) {
		const y0 = y * 2;
		const y1 = Math.min(height - 1, y0 + 1);
		for (let x = 0; x < hw; x += 1) {
			const x0 = x * 2;
			const x1 = Math.min(width - 1, x0 + 1);
			const a = diff[y0 * width + x0];
			const b = diff[y0 * width + x1];
			const cc = diff[y1 * width + x0];
			const d = diff[y1 * width + x1];
			out[y * hw + x] = Math.max(a, b, cc, d);
		}
	}
	return { diff: out, width: hw, height: hh };
}

/**
 * 双线性上采样 alpha（半分辨率 → 675×1200）。
 * @param {Uint8ClampedArray | Uint8Array} alpha
 * @param {number} halfWidth
 * @param {number} halfHeight
 * @param {number} width
 * @param {number} height
 * @returns {Uint8ClampedArray}
 */
export function upsampleAlpha(alpha, halfWidth, halfHeight, width, height) {
	const out = new Uint8ClampedArray(width * height);
	const xScale = halfWidth / width;
	const yScale = halfHeight / height;
	for (let y = 0; y < height; y += 1) {
		let sy = (y + 0.5) * yScale - 0.5;
		sy = sy < 0 ? 0 : sy > halfHeight - 1 ? halfHeight - 1 : sy;
		const y0 = Math.floor(sy);
		const y1 = Math.min(halfHeight - 1, y0 + 1);
		const fy = sy - y0;
		const row0 = y0 * halfWidth;
		const row1 = y1 * halfWidth;
		for (let x = 0; x < width; x += 1) {
			let sx = (x + 0.5) * xScale - 0.5;
			sx = sx < 0 ? 0 : sx > halfWidth - 1 ? halfWidth - 1 : sx;
			const x0 = Math.floor(sx);
			const x1 = Math.min(halfWidth - 1, x0 + 1);
			const fx = sx - x0;
			const top = alpha[row0 + x0] * (1 - fx) + alpha[row0 + x1] * fx;
			const bottom = alpha[row1 + x0] * (1 - fx) + alpha[row1 + x1] * fx;
			out[y * width + x] = top * (1 - fy) + bottom * fy;
		}
	}
	return out;
}

/* ---------------- 主流程 ---------------- */

/**
 * @typedef {object} DiyLayerQa
 * @property {'flatout_diff'} alphaMode
 * @property {number} threshold 实际使用的 diff 阈值
 * @property {number} alphaAreaFrac alpha 面积占比（画布）
 * @property {number} alphaHolePx alpha 拓扑洞（排除头发覆盖区）
 * @property {number} missingGarmentPx 估计的衣服可见区但 alpha 未覆盖像素
 * @property {number} bgResiduePx alpha 落到角色剪影外的像素（背景残留）
 * @property {number} whiteFringeFrac 边缘近白像素占比（白边/洗白）
 * @property {number} poseShiftPx look↔flatout 剪影质心平移（675px）
 * @property {number} poseIou look↔flatout 剪影 IoU
 * @property {boolean} sleevePresent
 * @property {number} sleeveAreaFrac
 * @property {{ white: boolean, meanRgb: [number, number, number], nearWhiteFrac: number }} garmentColor
 * @property {number} fillUnderHairPx 反投影补在头发下的 alpha 像素
 * @property {number} timingMs
 */

/**
 * @typedef {object} DiyLayerResult
 * @property {boolean} ok
 * @property {string} [reason] 失败原因（`flatout_missing` / `garment_not_found` / `image_size_mismatch` / `too_large`）
 * @property {'top'|'bottom'|'dress'|'coat'|'outfit'} category
 * @property {RgbaImage} [look] 透传输入（浏览器回贴 RGB 用）
 * @property {Uint8ClampedArray | null} [bodyAlpha]
 * @property {Uint8ClampedArray | null} [sleeveAlpha]
 * @property {DiyLayerQa | null} [qa]
 * @property {'pass'|'needs-fix'|'fail'} [grade]
 * @property {string[]} [defects]
 */

/**
 * 从 look + flatout 自动成层（M1 主入口，纯函数）。
 *
 * - 自适应阈值取 `|look-flatout|` 的衣区（浅色衣服自动降阈值）；
 * - fill-under-hair：用现有 hair 层 alpha 反投影补头发/手臂下缺失的衣身；
 * - 拆袖：top/dress/coat/outfit 用 arms alpha 拆 sleeve 并裁掉手部；bottom 不拆袖；
 * - 自动 QA：α 洞 / 缺衣 / 背景残留 / 白边 / 同姿势配准，输出分级与缺陷列表。
 *
 * @param {DiyLayerInput} input
 * @returns {DiyLayerResult}
 */
export function extractDiyLayer(input) {
	const startTime = nowMs();
	/** @type {Record<string, number>} */
	const phases = {};
	let phaseStart = startTime;
	/** @param {string} name */
	const mark = (name) => {
		if (!input.options || !input.options.collectPhases) return;
		const now = nowMs();
		phases[name] = Math.round(now - phaseStart);
		phaseStart = now;
	};
	const category = input.category;
	const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
	const look = input.look;
	const flatout = input.flatout;
	/**
	 * @param {string} reason
	 * @returns {DiyLayerResult}
	 */
	const failed = (reason) => ({
		ok: false,
		reason,
		category,
		bodyAlpha: null,
		sleeveAlpha: null,
		qa: null,
		grade: /** @type {const} */ ('fail'),
		defects: [reason],
	});
	const width = look && look.width;
	const height = look && look.height;
	if (!width || !height || !validImage(look, width, height, 'look')) return failed('image_size_mismatch');
	if (!flatout || flatout.width !== width || flatout.height !== height) return failed('flatout_missing');
	if (!validImage(input.hair, width, height, 'hair') || !validImage(input.arms, width, height, 'arms')) {
		return failed('image_size_mismatch');
	}
	const slot = DIY_CATEGORY_SLOTS[/** @type {keyof typeof DIY_CATEGORY_SLOTS} */ (category)];
	if (!slot) return failed('category_unsupported');
	const canvasArea = width * height;

	/* 1) 全分辨率：前景剪影（白衣服靠填洞保住整片衣身）+ 同姿势配准 QA */
	const lookFg = foregroundMask(look, options.lookFgThreshold);
	const flatFg = foregroundMask(flatout, options.lookFgThreshold);
	const pose = poseRegistration(lookFg, flatFg, width, height);
	const lookBounds = maskBounds(lookFg, width, height);
	mark('foreground+pose');

	/* 2) 全分辨率 diff（衣区证据），拓扑在 1/2 分辨率做（4× 提速），
	      最后用全分辨率 diff 做 1px 边缘精修——精度不靠拓扑分辨率。 */
	const diff = diffMap(look, flatout);
	mark('diff');
	const half = downsampleDiff(diff, width, height);
	const halfDiff = half.diff;
	const hw = half.width;
	const hh = half.height;
	const halfCanvasArea = hw * hh;

	/* 3) 半分辨率掩膜：hair / arms / look 前景 */
	const hairMask = alphaToMask(alphaChannel(input.hair));
	const armsMask = alphaToMask(alphaChannel(input.arms));
	const hairHalf = downsampleMask(hairMask, width, height);
	const armsHalf = downsampleMask(armsMask, width, height);
	const lookFgHalf = downsampleMask(lookFg, width, height);
	const hairHalfD = dilateMask(hairHalf.mask, hw, hh, 3);
	const hairHalfD2 = dilateMask(hairHalf.mask, hw, hh, 2);
	const lookFgHalfGrown = dilateMask(lookFgHalf.mask, hw, hh, 3);
	mark('masks-downsample');

	/* 4) 衣服区域 = 角色 bbox 内、头部以下（半分辨率口径） */
	const margin = Math.max(4, Math.round(hw * 0.02));
	const halfBounds = maskBounds(lookFgHalf.mask, hw, hh);
	const region = {
		x0: halfBounds ? Math.max(0, halfBounds.x0 - margin) : 0,
		y0: Math.round(hh * options.headFraction),
		x1: halfBounds ? Math.min(hw, halfBounds.x1 + margin) : hw,
		y1: Math.min(hh, Math.round(hh * 0.99)),
	};

	/* 5) 自适应阈值 + 原始衣区 */
	const chosen =
		options.diffThreshold > 0
			? { threshold: options.diffThreshold, frac: 0 }
			: chooseThreshold(halfDiff, hw, hh, region);
	const threshold = chosen.threshold;
	/** @type {Uint8Array} */
	let raw = new Uint8Array(hw * hh);
	let rawCount = 0;
	for (let y = region.y0; y < region.y1; y += 1) {
		const row = y * hw;
		for (let x = region.x0; x < region.x1; x += 1) {
			const index = row + x;
			if (halfDiff[index] > threshold && !hairHalfD[index]) {
				raw[index] = 1;
				rawCount += 1;
			}
		}
	}
	mark('threshold+raw');
	if (rawCount / halfCanvasArea < 0.002) return failed('garment_not_found');

	/* 6) 闭运算补头发通道 → 填洞 → 去零碎块（M0 close_fill 的半分辨率口径） */
	const filled = fillHolesMask(raw, hw, hh);
	let mask = closeMask(filled, hw, hh, Math.max(2, Math.round(options.closeRadius / 2)));
	mask = fillHolesMask(mask, hw, hh);
	mask = keepLargeComponents(mask, hw, hh, 125);
	for (let i = 0; i < mask.length; i += 1) mask[i] = mask[i] && lookFgHalfGrown[i] ? 1 : 0;
	mask = fillHolesMask(mask, hw, hh);
	mark('close+fill+ccl');
	const maskBeforeFill = mask;
	const maskArea = countMask(mask);
	if ((maskArea * 4) / canvasArea > ALPHA_AREA_RANGE.max) return failed('too_large');

	/* 7) fill-under-hair：用现有 hair 掩膜做行级反投影补头发遮挡区（发下的衣身 α） */
	const underHair = fillUnderHairRows(mask, hairHalfD, lookFgHalf.mask, hw, hh);
	let alphaMask = fillHolesMask(underHair.alpha, hw, hh);
	const filledUnderHair = underHair.filled;
	mark('fill-under-hair');
	const alphaArea = countMask(alphaMask);
	if ((alphaArea * 4) / canvasArea < ALPHA_AREA_RANGE.min) return failed('garment_not_found');

	/* 8) 上采样 → 全分辨率边缘精修（用全分辨率 diff 收 1px 边）→ 羽化 */
	const alphaBinHalf = alphaMask;
	const upsampled = upsampleAlpha(Uint8ClampedArray.from(alphaBinHalf, (v) => v * 255), hw, hh, width, height);
	const upsampledBin = alphaToMask(upsampled);
	const band = edgeBandMask(upsampledBin, width, height);
	const gateLo = threshold * 0.5;
	const gateSpan = Math.max(1, threshold * 0.6);
	for (let i = 0; i < upsampled.length; i += 1) {
		if (!band[i]) continue;
		const gate = Math.max(0, Math.min(1, (diff[i] - gateLo) / gateSpan));
		if (gate < 1) upsampled[i] = Math.min(upsampled[i], 255 * gate);
	}
	const bodyAlpha = featherAlpha(upsampled, width, height, options.featherRadius);
	mark('upsample+edge+feather');

	/* 9) 拆袖（bottom 不拆；全分辨率 arms 掩膜 + look 手部裁切） */
	/** @type {Uint8ClampedArray | null} */
	let sleeveAlpha = null;
	let sleeveFrac = 0;
	if (slot.sleeve) {
		const sleeve = splitSleeveAlpha(
			look,
			alphaToMask(upsampled),
			armsMask,
			width,
			height,
			options.armsDilate,
			bodyAlpha,
		);
		if (sleeve) {
			sleeveAlpha = sleeve.alpha;
			sleeveFrac = sleeve.frac;
		}
	}

	mark('sleeve');
	/* 10) 自动 QA（洞/缺衣/面积在半分辨率统计并折算成全分辨率像素；白边/残留在全分辨率） */
	const alphaBin = alphaToMask(bodyAlpha);
	const holeFilled = fillHolesMask(alphaBinHalf, hw, hh);
	let alphaHoleHalf = 0;
	for (let i = 0; i < alphaBinHalf.length; i += 1) {
		if (holeFilled[i] && !alphaBinHalf[i] && !hairHalfD2[i]) alphaHoleHalf += 1;
	}
	const alphaHolePx = alphaHoleHalf * 4;
	const bandFull = band;
	// 白边只统计「不透明边界内侧像素」：外侧半透明像素本来就会混入白背景，属于正常 AA，
	// 不是洗白；真正要抓的是深色衣服轮廓上出现的一圈近白像素。
	let whiteFringe = 0;
	let bandInside = 0;
	let bandSemi = 0;
	let bgResidueHalf = 0;
	for (let i = 0; i < alphaBin.length; i += 1) {
		const alpha = bodyAlpha[i];
		if (!bandFull[i]) continue;
		if (alpha > 20 && alpha < 235) bandSemi += 1;
		if (alpha >= 200) {
			bandInside += 1;
			const p = i * 4;
			if (look.data[p] > 238 && look.data[p + 1] > 238 && look.data[p + 2] > 238) whiteFringe += 1;
		}
	}
	for (let i = 0; i < alphaBinHalf.length; i += 1) {
		if (alphaBinHalf[i] && !lookFgHalfGrown[i]) bgResidueHalf += 1;
	}
	const bgResidue = bgResidueHalf * 4;
	const whiteFringeFrac = bandInside ? whiteFringe / bandInside : 0;
	// 缺衣：衣服区（排除头发/手臂覆盖）但 alpha 没盖住
	const armsHalfD = dilateMask(armsHalf.mask, hw, hh, 2);
	let missingHalf = 0;
	for (let i = 0; i < maskBeforeFill.length; i += 1) {
		if (maskBeforeFill[i] && !hairHalfD[i] && !armsHalfD[i] && !alphaBinHalf[i]) missingHalf += 1;
	}
	const missingGarmentPx = missingHalf * 4;
	mark('qa-holes-residue');
	const garmentColor = classifyGarmentColor(look, alphaBin);
	mark('garment-color');
	/** @type {DiyLayerQa} */
	const qa = {
		alphaMode: 'flatout_diff',
		threshold,
		alphaAreaFrac: Number(((alphaArea * 4) / canvasArea).toFixed(4)),
		alphaHolePx,
		missingGarmentPx,
		bgResiduePx: bgResidue,
		whiteFringeFrac: Number(whiteFringeFrac.toFixed(4)),
		poseShiftPx: pose.shiftPx,
		poseIou: pose.iou,
		sleevePresent: sleeveAlpha !== null,
		sleeveAreaFrac: Number(sleeveFrac.toFixed(4)),
		garmentColor,
		fillUnderHairPx: filledUnderHair * 4,
		timingMs: options.measureTiming ? Math.round(nowMs() - startTime) : 0,
	};

	/* 11) 分级与缺陷（M0 §5 指标口径，gate 见 task-7 验收） */
	const defects = [];
	if (alphaHolePx > 50) defects.push(`alpha 洞 ${alphaHolePx}px > 50`);
	if (missingGarmentPx > 50) defects.push(`缺衣/露底 ${missingGarmentPx}px > 50`);
	if (bgResidue > 200) defects.push(`背景残留 ${bgResidue}px > 200`);
	if (!garmentColor.white && whiteFringeFrac > WHITE_FRINGE_MAX) {
		defects.push(`白边/洗白 ${(whiteFringeFrac * 100).toFixed(0)}% > 5%`);
	}
	if (pose.shiftPx > MAX_POSE_SHIFT_PX) defects.push(`同姿势配准 ${pose.shiftPx}px > 2px`);
	if (qa.alphaAreaFrac < ALPHA_AREA_RANGE.min || qa.alphaAreaFrac > ALPHA_AREA_RANGE.max) {
		defects.push(`alpha 面积 ${(qa.alphaAreaFrac * 100).toFixed(1)}% 超出范围`);
	}
	const hardFail = alphaHolePx > 4000 || missingGarmentPx > 8000 || qa.alphaAreaFrac > ALPHA_AREA_RANGE.max;
	return {
		ok: true,
		category,
		look,
		bodyAlpha,
		sleeveAlpha,
		qa,
		grade: hardFail ? 'fail' : defects.length > 0 ? 'needs-fix' : 'pass',
		defects,
		...(input.options && input.options.collectPhases ? { phaseMs: phases } : {}),
	};
}

/* ---------------- 预览/QA 合成 ---------------- */

/**
 * source-over 合成（用于预览与 QA 拼图）。
 * @param {RgbaImage} dst 目标画布（会被原地修改）
 * @param {RgbaImage} src 上层图像
 * @param {Uint8ClampedArray} [alphaOverride] 用指定 alpha 代替 src 的 alpha
 * @returns {RgbaImage}
 */
export function overRgba(dst, src, alphaOverride) {
	const out = dst.data;
	const s = src.data;
	const count = dst.width * dst.height;
	for (let i = 0; i < count; i += 1) {
		const p = i * 4;
		const a = (alphaOverride ? alphaOverride[i] : s[p + 3]) / 255;
		if (a <= 0) continue;
		out[p] = out[p] * (1 - a) + s[p] * a;
		out[p + 1] = out[p + 1] * (1 - a) + s[p + 1] * a;
		out[p + 2] = out[p + 2] * (1 - a) + s[p + 2] * a;
		out[p + 3] = out[p + 3] * (1 - a) + a * 255;
	}
	return dst;
}

/**
 * 按绘制顺序合成图层栈（画布初始透明）。
 * @param {number} width
 * @param {number} height
 * @param {Array<RgbaImage>} layers 从下到上
 * @returns {RgbaImage}
 */
export function compositeStack(width, height, layers) {
	const canvas = createRgbaImage(width, height);
	for (const layer of layers) overRgba(canvas, layer);
	return canvas;
}

/**
 * look 的 RGB + 给定 alpha → 可直接写 PNG/WebP 的图层。
 * @param {RgbaImage} look
 * @param {Uint8ClampedArray} alpha
 * @returns {RgbaImage}
 */
export function layerFromAlpha(look, alpha) {
	const image = createRgbaImage(look.width, look.height);
	for (let i = 0; i < alpha.length; i += 1) {
		const p = i * 4;
		image.data[p] = look.data[p];
		image.data[p + 1] = look.data[p + 1];
		image.data[p + 2] = look.data[p + 2];
		image.data[p + 3] = alpha[i];
	}
	return image;
}
