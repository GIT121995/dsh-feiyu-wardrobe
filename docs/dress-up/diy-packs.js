/**
 * 大肥鱼衣橱 · DIY 已安装套装（S3：宿主 registry + runtime 动态 outfit pack 消费）
 *
 * 流程：
 *   1) boot 时 GET `/feiyu/diy/registry.json`（宿主路由；静态托管 404 → 无 DIY，不报错）；
 *   2) `inject(manifest)` 把已安装套装注入衣柜（outfits 分类；图标用 pack 纹理缩略图）；
 *   3) 选中时 `ensureLoaded(runtime, id)` → runtime.addOutfitPack({pack, assetBase})（多纹理、不重建 base 图集）；
 *   4) QA fallback=static 的套装走静态贴片路径（layer 图来自 pack/static/，UI 明确提示）；
 *   5) 提供删除（宿主 POST /feiyu/diy/remove）、`.dshskin` 导出/导入、刷新（轮询 registry）。
 *
 * 所有宿主请求同源、带 `x-feiyu-diy: 1`；API key 不经过页面。默认关闭时 registry 404 → 页面无 DIY。
 *
 * @module dsh-feiyu-wardrobe/diy-packs
 */

/** 宿主 DIY 路由根（与 lib/diy.js DIY_PATH 一致）。 */
const DIY_ROOT = '/feiyu/diy';

/** @param {string} path */
async function getJson(path) {
	const response = await fetch(path, { cache: 'no-store' });
	if (!response.ok) {
		const error = new Error(`HTTP ${response.status}`);
		error.status = response.status;
		throw error;
	}
	return response.json();
}

/** @param {string} path @param {unknown} body */
async function postJson(path, body) {
	const response = await fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-feiyu-diy': '1' },
		body: JSON.stringify(body),
	});
	let data = null;
	try {
		data = await response.json();
	} catch {
		/* 非 JSON 响应 */
	}
	if (!response.ok) {
		const error = new Error((data && data.message) || `HTTP ${response.status}`);
		error.code = data && data.code;
		error.status = response.status;
		throw error;
	}
	return data;
}

/**
 * @param {{ manifest: any, fetchImpl?: typeof fetch }} options
 */
export function createDiyPacks(options) {
	const manifest = options.manifest;
	/** @type {any[]} */
	let items = [];
	/** @type {Map<string, { pack: any, assetBase: string, entry: any, outfitId: string }>} */
	const packs = new Map();
	let available = false;
	let lastError = '';
	/** @type {any[]} */
	let uiRefs = [];

	function setAvailable(value) {
		available = value;
	}

	/** 读取宿主 registry + 每个动态套装 pack 元数据（不加载纹理/GL）。 */
	async function prepare() {
		try {
			const registry = await getJson(`${DIY_ROOT}/registry.json`);
			const list = registry && registry.items && typeof registry.items === 'object' ? Object.values(registry.items) : [];
			const nextItems = [];
			packs.clear();
			for (const entry of list) {
				if (!entry || typeof entry !== 'object' || !entry.id || entry.shape !== 'chibi') continue;
				const item = {
					id: String(entry.id),
					name: String(entry.name || entry.id),
					category: String(entry.category || 'top'),
					animated: entry.animated !== false,
					fallback: entry.fallback === 'static' ? 'static' : 'none',
					packDir: String(entry.packDir || `packs/${entry.id}`),
					qa: entry.qa || null,
					icon: '',
					outfitId: String(entry.id),
					diyPack: true,
					diy: entry.animated !== true,
					diyAnimated: entry.animated === true,
					diyStatic: entry.animated !== true,
				};
				if (item.animated) {
					try {
						const assetBase = `${DIY_ROOT}/${item.packDir}/`;
						const pack = await getJson(`${assetBase}diy-pack.json`);
						const outfitId = (pack.outfits && Object.keys(pack.outfits)[0]) || item.id;
						item.outfitId = outfitId;
						const body = (pack.drawables || []).find((drawable) => drawable && drawable.texture);
						item.icon = body ? `${assetBase}${body.texture}` : '';
						packs.set(item.id, { pack, assetBase, entry, outfitId });
					} catch {
						item.animated = false;
						item.diy = true;
						item.diyAnimated = false;
						item.diyStatic = true;
					}
				}
				if (!item.animated) {
					// 静态回退：pack/static/{body,sleeve}.png 作为 675×1200 全画布贴片
					const assetBase = `${DIY_ROOT}/${item.packDir}/`;
					item.layers = { chibi: { body: `${assetBase}static/body.png` } };
					item.icon = item.icon || `${assetBase}static/body.png`;
					if (entry.static && entry.static.sleeve) item.layers.chibi.sleeve = `${assetBase}${entry.static.sleeve}`;
				}
				nextItems.push(item);
			}
			items = nextItems;
			setAvailable(true);
			lastError = '';
			return { available: true, items };
		} catch (error) {
			setAvailable(false);
			items = [];
			packs.clear();
			lastError = error && error.status === 404 ? '' : String((error && error.message) || error);
			return { available: false, items: [] };
		}
	}

	/** 把已安装 DIY 套装注入 manifest（outfits 分类；不重复注入）。 */
	function inject(localManifest) {
		const target = localManifest || manifest;
		const outfits = target.items && target.items.outfits;
		if (!Array.isArray(outfits)) return items;
		for (const item of items) {
			if (outfits.some((entry) => entry && entry.id === item.id)) continue;
			outfits.push({
				id: item.id,
				name: item.name,
				emoji: '🧵',
				desc: item.animated ? 'DIY 动态 2.5D 套装（本地安装）' : 'DIY 静态贴片（该件未通过自动 QA）',
				icon: item.icon || '',
				diy: item.diy,
				diyPack: true,
				diyAnimated: item.diyAnimated,
				layers: item.layers || null,
			});
		}
		return items;
	}

	/** @param {string} itemId */
	function find(itemId) {
		return items.find((item) => item.id === itemId) || null;
	}

	/** @param {string} outfitId */
	function findByOutfit(outfitId) {
		if (typeof outfitId !== 'string' || !outfitId) return null;
		return items.find((item) => item.outfitId === outfitId || item.id === outfitId) || null;
	}

	/**
	 * 确保某个动态 pack 已加载进 runtime（幂等；失败抛错，页面可回退静态提示）。
	 * @param {any} runtime
	 * @param {string} itemId
	 * @returns {Promise<string|null>} outfitId
	 */
	async function ensureLoaded(runtime, itemId) {
		const meta = packs.get(itemId);
		if (!meta || !runtime) return null;
		if (typeof runtime.getOutfitPacks === 'function') {
			const loaded = runtime.getOutfitPacks();
			if (loaded.some((entry) => entry.packId === itemId)) return meta.outfitId;
		}
		await runtime.addOutfitPack({ pack: meta.pack, packId: itemId, assetBase: meta.assetBase });
		return meta.outfitId;
	}

	/** @param {string} itemId */
	function loaded(runtime, itemId) {
		return !!(runtime && typeof runtime.getOutfitPacks === 'function'
			&& runtime.getOutfitPacks().some((entry) => entry.packId === itemId));
	}

	/** 卸载 runtime 内已加载的 pack（不删除宿主安装）。 */
	function unload(runtime, itemId) {
		if (runtime && typeof runtime.removeOutfitPack === 'function') {
			try {
				runtime.removeOutfitPack(itemId);
			} catch {
				/* 卸载失败不影响宿主删除流程 */
			}
		}
	}

	/** 导出 `.dshskin`（含 pack JSON + 纹理/静态贴片 base64；不写宿主）。 */
	async function exportSkin(itemId) {
		const item = find(itemId);
		if (!item) throw new Error('找不到该 DIY 套装');
		const assetBase = `${DIY_ROOT}/${item.packDir}/`;
		const entries = [];
		if (item.animated) {
			const meta = packs.get(item.id);
			const pack = meta ? meta.pack : await getJson(`${assetBase}diy-pack.json`);
			for (const drawable of pack.drawables || []) {
				const response = await fetch(`${assetBase}${drawable.texture}`, { cache: 'no-store' });
				if (!response.ok) throw new Error(`纹理读取失败：${drawable.texture}`);
				const blob = await response.blob();
				const dataURL = await blobToDataUrl(blob);
				entries.push({ path: drawable.texture, dataURL });
			}
			return {
				format: 'feiyu-diy-skin',
				version: 1,
				entry: {
					id: item.id, name: item.name, shape: 'chibi', category: item.category,
					animated: true, fallback: 'none', qa: item.qa,
					createdAt: new Date().toISOString(),
				},
				pack,
				textures: entries,
				static: [],
			};
		}
		const pack = {
			format: 'feiyu-diy-pack', formatVersion: 1, item: item.id, name: item.name,
			shape: 'chibi', category: item.category, base: { skeletonBones: 59 },
			drawables: [], outfits: { [item.id]: { name: item.name, topBody: [], sleeve: [], bottom: [] } },
		};
		const staticFiles = [];
		for (const [slot, url] of Object.entries(item.layers.chibi || {})) {
			const response = await fetch(url, { cache: 'no-store' });
			if (!response.ok) continue;
			const blob = await response.blob();
			staticFiles.push({ path: slot === 'sleeve' ? 'static/sleeve.png' : 'static/body.png', dataURL: await blobToDataUrl(blob) });
		}
		return {
			format: 'feiyu-diy-skin', version: 1,
			entry: { id: item.id, name: item.name, shape: 'chibi', category: item.category, animated: false, fallback: 'static' },
			pack, textures: [], static: staticFiles,
		};
	}

	/** 导入 `.dshskin` 到宿主（写 registry + packs），随后刷新列表。 */
	async function importSkin(bundle) {
		const result = await postJson(`${DIY_ROOT}/import`, { bundle });
		await prepare();
		return result;
	}

	/** 删除宿主安装（registry + packs），并卸载 runtime 内同名 pack。 */
	async function remove(itemId, runtime) {
		const result = await postJson(`${DIY_ROOT}/remove`, { id: itemId });
		unload(runtime, itemId);
		await prepare();
		return result;
	}

	/** 面板 UI（挂到 stage；不影响主换装布局）。 */
	function mountUi(root, callbacks) {
		if (!root || uiRefs.length) return uiRefs;
		const fab = document.createElement('button');
		fab.type = 'button';
		fab.className = 'diy-fab';
		fab.title = '我的 DIY 套装（本地安装）';
		fab.textContent = '🧵';
		const panel = document.createElement('div');
		panel.className = 'diy-panel';
		panel.hidden = true;
		panel.innerHTML = ''
			+ '<div class="diy-panel-head"><b>我的 DIY 套装</b>'
			+ '<button type="button" data-act="refresh" title="刷新已安装列表">刷新</button>'
			+ '<button type="button" data-act="close" title="关闭">×</button></div>'
			+ '<div class="diy-panel-list"></div>'
			+ '<div class="diy-panel-foot"><label>导入 .dshskin<input type="file" accept=".dshskin,.json" hidden></label>'
			+ '<span class="diy-panel-status"></span></div>';
		root.appendChild(fab);
		root.appendChild(panel);
		const listEl = panel.querySelector('.diy-panel-list');
		const statusEl = panel.querySelector('.diy-panel-status');
		const fileInput = panel.querySelector('input[type=file]');
		const setStatus = (/** @type {string} */ text) => {
			if (statusEl) statusEl.textContent = text;
		};
		const renderList = () => {
			if (!listEl) return;
			listEl.innerHTML = '';
			if (!items.length) {
				const empty = document.createElement('div');
				empty.className = 'diy-panel-empty';
				empty.textContent = available ? '还没有安装 DIY 套装（agent 可用 /diy run 生成）' : '宿主 DIY 未开启或无 registry（默认关闭）';
				listEl.appendChild(empty);
				return;
			}
			for (const item of items) {
				const row = document.createElement('div');
				row.className = 'diy-panel-row';
				row.dataset.id = item.id;
				const thumb = document.createElement('img');
				thumb.alt = '';
				if (item.icon) thumb.src = item.icon;
				row.appendChild(thumb);
				const name = document.createElement('span');
				name.className = 'diy-panel-name';
				name.textContent = item.name;
				row.appendChild(name);
				const tag = document.createElement('i');
				tag.textContent = item.animated ? '动态' : '静态';
				row.appendChild(tag);
				const pick = document.createElement('button');
				pick.type = 'button';
				pick.textContent = '试穿';
				pick.addEventListener('click', () => callbacks && typeof callbacks.select === 'function' && callbacks.select(item.id));
				row.appendChild(pick);
				const exp = document.createElement('button');
				exp.type = 'button';
				exp.textContent = '导出';
				exp.addEventListener('click', async () => {
					try {
						setStatus('导出中…');
						const bundle = await exportSkin(item.id);
						downloadJson(`${item.id}.dshskin`, bundle);
						setStatus('已导出');
					} catch (error) {
						setStatus(`导出失败：${(error && error.message) || error}`);
					}
				});
				row.appendChild(exp);
				const del = document.createElement('button');
				del.type = 'button';
				del.textContent = '删除';
				del.addEventListener('click', async () => {
					try {
						setStatus('删除中…');
						await remove(item.id, callbacks && callbacks.runtime ? callbacks.runtime() : null);
						renderList();
						setStatus('已删除');
						if (callbacks && typeof callbacks.refresh === 'function') callbacks.refresh();
					} catch (error) {
						setStatus(`删除失败：${(error && error.message) || error}`);
					}
				});
				row.appendChild(del);
				listEl.appendChild(row);
			}
		};
		fab.addEventListener('click', () => {
			panel.hidden = !panel.hidden;
			if (!panel.hidden) {
				renderList();
				void refresh({ silent: true }).then(renderList);
			}
		});
		panel.addEventListener('click', (event) => {
			const target = /** @type {HTMLElement} */ (event.target);
			const act = target && target.dataset ? target.dataset.act : '';
			if (act === 'close') panel.hidden = true;
			if (act === 'refresh') {
				setStatus('刷新中…');
				void refresh().then(() => {
					renderList();
					setStatus('已刷新');
				});
			}
		});
		if (fileInput) {
			fileInput.addEventListener('change', async () => {
				const file = fileInput.files && fileInput.files[0];
				if (!file) return;
				try {
					setStatus('导入中…');
					const text = await file.text();
					const bundle = JSON.parse(text);
					const result = await importSkin(bundle);
					renderList();
					setStatus(`已导入 ${result && result.itemId ? result.itemId : ''}`);
					if (callbacks && typeof callbacks.refresh === 'function') callbacks.refresh();
				} catch (error) {
					setStatus(`导入失败：${(error && error.message) || error}`);
				} finally {
					fileInput.value = '';
				}
			});
		}
		let pollTimer = 0;
		const startPoll = () => {
			if (pollTimer) return;
			pollTimer = window.setInterval(() => {
				if (panel.hidden) return;
				void refresh({ silent: true }).then((changed) => {
					if (changed) {
						renderList();
						setStatus('检测到新套装');
					}
				});
			}, 5000);
		};
		startPoll();
		uiRefs = [fab, panel, renderList];
		return uiRefs;
	}

	/**
	 * 重新拉取 registry；返回是否有变化（新安装/删除）。
	 * @param {{ silent?: boolean }} [opts]
	 */
	async function refresh(opts = {}) {
		const before = items.map((item) => item.id).sort().join(',');
		await prepare();
		inject(manifest);
		const after = items.map((item) => item.id).sort().join(',');
		const changed = before !== after;
		if (changed && uiRefs[2] && typeof uiRefs[2] === 'function') uiRefs[2]();
		if (changed && !opts.silent && uiRefs.length) {
			uiRefs[2]();
		}
		return changed;
	}

	return {
		prepare,
		inject,
		find,
		findByOutfit,
		ensureLoaded,
		loaded,
		unload,
		exportSkin,
		importSkin,
		remove,
		mountUi,
		refresh,
		available: () => available,
		error: () => lastError,
		list: () => items.slice(),
	};
}

/** @param {Blob} blob */
function blobToDataUrl(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result || ''));
		reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
		reader.readAsDataURL(blob);
	});
}

/** @param {string} filename @param {unknown} value */
function downloadJson(filename, value) {
	const blob = new Blob([JSON.stringify(value)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 2000);
}
