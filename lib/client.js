// @ts-nocheck
/**
 * 大肥鱼衣橱 · 换装小游戏 —— 浏览器半区（DSH Web client plugin）
 *
 * 1. 侧边栏图标入口（sidebar.panellist）+ 主面板（main keyed slot）内嵌换装间。
 *    游戏页由宿主半区本地静态路由 `/feiyu/dress-up/` 提供，离线可用。
 * 2. 悬浮小鲸鱼（shell.overlay）：跟着当前穿搭换装，可拖动，点击打开换装间。
 */
window.__ModuleLoader__.load({
	id: 'dsh-feiyu-wardrobe',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const { jsx, jsxs } = require('react/jsx-runtime');
		const React = require('react');
		const { useEffect, useRef, useState } = React;

		const PANEL_ID = 'feiyu-dressup';
		const GAME_URL = '/feiyu/dress-up/?embed=1';
		const ART_URL = '/feiyu/dress-up/art/';
		const OUTFIT_KEY = 'feiyu:outfit';
		const POS_KEY = 'feiyu:petPos';
		const PET_WIDTH = 92;

		/* ---------------- 悬浮小鲸鱼 ---------------- */

		function readJSON(key) {
			try {
				return JSON.parse(localStorage.getItem(key) || 'null');
			} catch {
				return null;
			}
		}

		function readOutfit() {
			const raw = readJSON(OUTFIT_KEY) || {};
			return {
				gown: typeof raw.gown === 'string' ? raw.gown : 'classic',
				coat: typeof raw.coat === 'string' ? raw.coat : 'none',
				hat: typeof raw.hat === 'string' ? raw.hat : 'none',
			};
		}

		function artFor(outfit) {
			const art = {
				base: ART_URL + 'base.webp',
				gown: null,
				coat: null,
				hat: null,
			};
			if (outfit.gown && outfit.gown !== 'classic') art.gown = `${ART_URL}gown-${outfit.gown}.webp`;
			if (outfit.coat && outfit.coat !== 'none') art.coat = `${ART_URL}coat-${outfit.coat}.webp`;
			if (outfit.hat && outfit.hat !== 'none') art.hat = `${ART_URL}hat-${outfit.hat}.webp`;
			return art;
		}

		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}

		/** 悬浮小鲸鱼：显示当前穿搭，拖动移动，点击打开换装间。 */
		function PetOverlay(props) {
			const [artOk, setArtOk] = useState(true);
			const [outfit, setOutfit] = useState(readOutfit);
			const [pos, setPos] = useState(() => {
				const saved = readJSON(POS_KEY);
				return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
			});
			const dragRef = useRef(null);
			const posRef = useRef(pos);
			posRef.current = pos;
			const sizeRef = useRef({ w: PET_WIDTH, h: Math.round((PET_WIDTH * 5) / 3) });

			useEffect(() => {
				if (pos) return;
				const saved = readJSON(POS_KEY);
				if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
					setPos(saved);
					return;
				}
				setPos({
					x: Math.max(8, window.innerWidth - sizeRef.current.w - 22),
					y: Math.max(8, window.innerHeight - sizeRef.current.h - 150),
				});
			}, [pos]);

			useEffect(() => {
				const onStorage = (event) => {
					if (event.key === OUTFIT_KEY) setOutfit(readOutfit());
				};
				const onResize = () => {
					const current = posRef.current;
					if (!current) return;
					setPos({
						x: clamp(current.x, 4, window.innerWidth - sizeRef.current.w - 4),
						y: clamp(current.y, 4, window.innerHeight - sizeRef.current.h - 4),
					});
				};
				window.addEventListener('storage', onStorage);
				window.addEventListener('resize', onResize);
				return () => {
					window.removeEventListener('storage', onStorage);
					window.removeEventListener('resize', onResize);
				};
			}, []);

			const onPointerDown = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				dragRef.current = {
					startX: event.clientX,
					startY: event.clientY,
					baseX: (posRef.current && posRef.current.x) || 0,
					baseY: (posRef.current && posRef.current.y) || 0,
					moved: false,
				};
				try {
					event.currentTarget.setPointerCapture(event.pointerId);
				} catch {
					/* 某些环境不支持 pointer capture，忽略 */
				}
				event.currentTarget.style.cursor = 'grabbing';
			};

			const onPointerMove = (event) => {
				const drag = dragRef.current;
				if (!drag) return;
				const dx = event.clientX - drag.startX;
				const dy = event.clientY - drag.startY;
				if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
				if (!drag.moved) return;
				setPos({
					x: clamp(drag.baseX + dx, 4, window.innerWidth - sizeRef.current.w - 4),
					y: clamp(drag.baseY + dy, 4, window.innerHeight - sizeRef.current.h - 4),
				});
			};

			const onPointerUp = (event) => {
				const drag = dragRef.current;
				dragRef.current = null;
				if (event.currentTarget) event.currentTarget.style.cursor = 'grab';
				if (!drag) return;
				if (!drag.moved) {
					props.openWardrobe();
					return;
				}
				const current = posRef.current;
				if (!current) return;
				try {
					localStorage.setItem(POS_KEY, JSON.stringify(current));
				} catch {
					/* 隐身模式忽略 */
				}
			};

			if (!artOk || !pos) return null;
			const art = artFor(outfit);
			const label = '点我打开换装间 · 拖着我走';
			const height = Math.round((PET_WIDTH * 5) / 3);
			const layerStyle = {
				position: 'absolute',
				inset: 0,
				width: '100%',
				height: '100%',
				objectFit: 'contain',
				pointerEvents: 'none',
				userSelect: 'none',
			};
			return jsx('div', {
				style: {
					position: 'fixed',
					left: pos.x + 'px',
					top: pos.y + 'px',
					width: PET_WIDTH + 'px',
					zIndex: 9999,
					pointerEvents: 'none',
				},
				children: jsx('div', {
					role: 'button',
					tabIndex: 0,
					title: label,
					'aria-label': label,
					onPointerDown,
					onPointerMove,
					onPointerUp,
					onPointerCancel: onPointerUp,
					onKeyDown: (event) => {
						if (event.key === 'Enter' || event.key === ' ') {
							event.preventDefault();
							props.openWardrobe();
						}
					},
					style: {
						position: 'relative',
						width: PET_WIDTH + 'px',
						height: height + 'px',
						cursor: 'grab',
						pointerEvents: 'auto',
						touchAction: 'none',
						userSelect: 'none',
						animation: 'feiyu-pet-bob 4.8s ease-in-out infinite',
						filter: 'drop-shadow(0 10px 16px rgba(20, 10, 50, .38))',
					},
					children: [
						jsx('img', {
							key: 'base',
							src: art.base,
							alt: '大肥鱼',
							draggable: false,
							style: layerStyle,
							onError: () => setArtOk(false),
						}),
						art.gown
							? jsx('img', { key: 'gown', src: art.gown, alt: '', draggable: false, style: layerStyle })
							: null,
						art.coat
							? jsx('img', { key: 'coat', src: art.coat, alt: '', draggable: false, style: layerStyle })
							: null,
						art.hat
							? jsx('img', { key: 'hat', src: art.hat, alt: '', draggable: false, style: layerStyle })
							: null,
					],
				}),
			});
		}

		/** 注入悬浮小鲸鱼用的关键帧（只注入一次）。 */
		function ensurePetStyles() {
			if (document.getElementById('feiyu-pet-style')) return;
			const style = document.createElement('style');
			style.id = 'feiyu-pet-style';
			style.textContent =
				'@keyframes feiyu-pet-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }';
			document.head.appendChild(style);
		}

		/* ---------------- 侧边栏入口 & 主面板 ---------------- */

		/** 侧边栏图标：小裙子 */
		function WardrobeIcon(props) {
			const size = (props && props.size) || 16;
			return jsx('span', {
				style: { fontSize: size + 'px', lineHeight: 1, display: 'inline-flex' },
				children: '🎀',
			});
		}

		/** 主面板：内嵌换装小游戏（宿主本地路由，离线可用） */
		function WardrobePanel() {
			return jsxs('div', {
				style: {
					display: 'flex',
					flexDirection: 'column',
					width: '100%',
					height: '100%',
					minHeight: 0,
					background: '#1c1533',
				},
				children: [
					jsx('iframe', {
						src: GAME_URL,
						title: '大肥鱼换装小游戏',
						style: { flex: 1, width: '100%', border: 0, minHeight: 0 },
						allow: 'fullscreen',
					}),
					jsxs('div', {
						style: {
							padding: '5px 14px',
							fontSize: '11.5px',
							color: '#8b82ad',
							textAlign: 'center',
							flex: '0 0 auto',
							background: '#fdf3ff',
						},
						children: [
							'高清立绘：YunYueSama · AI 服装：Moss · 非官方 · 禁止商用 · CC BY-NC-SA 4.0 · ',
							jsx('a', {
								href: 'https://github.com/GIT121995/dsh-feiyu-wardrobe',
								target: '_blank',
								rel: 'noopener noreferrer',
								style: { color: '#6a5acd' },
								children: 'GitHub',
							}),
						],
					}),
				],
			});
		}

		/** 依赖的客户端服务 */
		const inject = ['slots', 'layout'];

		function apply(ctx) {
			// 侧边栏入口
			ctx.slots.inject('sidebar.panellist', () =>
				ctx.slots.register(
					{
						name: 'sidebar.panellist',
						id: PANEL_ID,
						order: 20,
						label: () => '换装间',
					},
					WardrobeIcon,
				),
			);
			// 主面板
			ctx.slots.inject('main', () =>
				ctx.slots.register(
					{
						name: 'main',
						key: PANEL_ID,
					},
					WardrobePanel,
				),
			);
			// 悬浮小鲸鱼
			ensurePetStyles();
			ctx.slots.inject('shell.overlay', () =>
				ctx.slots.register(
					{
						name: 'shell.overlay',
						id: 'feiyu-dressup.pet',
						order: 40,
						inject: () => ({
							openWardrobe: () => {
								try {
									ctx.layout.selectPanel(PANEL_ID);
								} catch {
									/* 面板未注册时忽略 */
								}
							},
						}),
					},
					PetOverlay,
				),
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		return module.exports;
	},
});
