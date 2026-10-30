// @ts-nocheck
/**
 * 大肥鱼衣橱 · 换装小游戏 —— 浏览器半区（DSH Web client plugin）
 *
 * 1. 侧边栏图标入口（sidebar.panellist）+ 主面板（main keyed slot）内嵌换装间。
 *    游戏页由宿主半区本地静态路由 `/feiyu/dress-up/` 提供，离线可用。
 * 2. 悬浮小鲸鱼（shell.overlay）：跟着当前穿搭换装，可拖动；左键互动、右键菜单里打开换装间（不直接跳转）。
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
		const GAME_BASE = '/feiyu/dress-up/';
		const OUTFIT_KEY = 'feiyu:outfit';
		const POS_KEY = 'feiyu:petPos';
		const PET_HIDDEN_KEY = 'feiyu:petHidden';
		const PET_VISIBILITY_EVENT = 'feiyu:pet-visibility-changed';
		const PET_WIDTH = 92;
		const PET_REACTIONS = [
			'嘿嘿，右键点我可以打开换装间喔～',
			'别戳啦，再戳要掉毛了。',
			'今天穿得好看吗？',
			'想换衣服的话，右键点我。',
			'拖得动我，但拖不动鱼粮。',
		];

		/* ---------------- 悬浮小鲸鱼 ---------------- */

		function readJSON(key) {
			try {
				return JSON.parse(localStorage.getItem(key) || 'null');
			} catch {
				return null;
			}
		}

		/** 换装间会把当前立绘路径写进 localStorage（art/<shape>/...webp）。 */
		function readOutfit() {
			const raw = readJSON(OUTFIT_KEY) || {};
			const image = typeof raw.image === 'string' && raw.image.startsWith('art/')
				? raw.image
				: 'art/chibi/dress-maid.webp';
			return { shape: raw.shape === 'girl' ? 'girl' : 'chibi', image };
		}

		function clamp(value, min, max) {
			return Math.min(max, Math.max(min, value));
		}

		/** 悬浮小鲸鱼：显示当前穿搭，可拖动；左键互动、右键菜单打开换装间。 */
		function PetOverlay(props) {
			const [artOk, setArtOk] = useState(true);
			const [outfit, setOutfit] = useState(readOutfit);
			const [hidden, setHidden] = useState(() => {
				try {
					return localStorage.getItem(PET_HIDDEN_KEY) === '1';
				} catch {
					return false;
				}
			});
			const [menu, setMenu] = useState(null);
			const [reacting, setReacting] = useState(false);
			const [message, setMessage] = useState('');
			const [pos, setPos] = useState(() => {
				const saved = readJSON(POS_KEY);
				return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : null;
			});
			const dragRef = useRef(null);
			const posRef = useRef(pos);
			posRef.current = pos;
			const menuRef = useRef(null);
			const sizeRef = useRef({ w: PET_WIDTH, h: Math.round((PET_WIDTH * 16) / 9) });

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
				const syncHidden = () => {
					try {
						setHidden(localStorage.getItem(PET_HIDDEN_KEY) === '1');
					} catch {
						/* 忽略 */
					}
				};
				const onStorage = (event) => {
					if (event.key === OUTFIT_KEY) setOutfit(readOutfit());
					if (event.key === PET_HIDDEN_KEY) syncHidden();
				};
				const onResize = () => {
					const current = posRef.current;
					if (!current) return;
					setPos({
						x: clamp(current.x, 4, window.innerWidth - sizeRef.current.w - 4),
						y: clamp(current.y, 4, window.innerHeight - sizeRef.current.h - 4),
					});
				};
				const onKey = (event) => {
					if (event.key === 'Escape') setMenu(null);
				};
				window.addEventListener('storage', onStorage);
				window.addEventListener('resize', onResize);
				window.addEventListener('keydown', onKey);
				window.addEventListener(PET_VISIBILITY_EVENT, syncHidden);
				return () => {
					window.removeEventListener('storage', onStorage);
					window.removeEventListener('resize', onResize);
					window.removeEventListener('keydown', onKey);
					window.removeEventListener(PET_VISIBILITY_EVENT, syncHidden);
				};
			}, []);

			useEffect(() => {
				if (!menu) return;
				const close = (event) => {
					if (menuRef.current && event.target && menuRef.current.contains(event.target)) return;
					setMenu(null);
				};
				window.addEventListener('pointerdown', close, true);
				window.addEventListener('blur', close);
				return () => {
					window.removeEventListener('pointerdown', close, true);
					window.removeEventListener('blur', close);
				};
			}, [menu]);

			useEffect(() => {
				if (!reacting) return;
				const timer = setTimeout(() => {
					setReacting(false);
					setMessage('');
				}, 2400);
				return () => clearTimeout(timer);
			}, [reacting]);

			const onPointerDown = (event) => {
				if (event.button !== undefined && event.button !== 0) return;
				if (menu) {
					setMenu(null);
					return;
				}
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
					// 左键只做互动，不跳转
					setReacting(true);
					setMessage(PET_REACTIONS[Math.floor(Math.random() * PET_REACTIONS.length)]);
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

			const openMenu = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const width = 168;
				const height = 110;
				setMenu({
					x: Math.min(event.clientX, window.innerWidth - width - 8),
					y: Math.min(event.clientY, window.innerHeight - height - 8),
				});
			};

			const hidePet = () => {
				try {
					localStorage.setItem(PET_HIDDEN_KEY, '1');
				} catch {
					/* 忽略 */
				}
				setMenu(null);
				setHidden(true);
				window.dispatchEvent(new Event(PET_VISIBILITY_EVENT));
			};

			if (!artOk || !pos || hidden) return null;
			const label = '拖动我 · 右键打开换装间';
			const height = Math.round((PET_WIDTH * 16) / 9);
			const layerStyle = {
				position: 'absolute',
				inset: 0,
				width: '100%',
				height: '100%',
				objectFit: 'contain',
				pointerEvents: 'none',
				userSelect: 'none',
			};
			const menuButton = (text, onClick) =>
				jsx('button', {
					type: 'button',
					onClick,
					style: {
						display: 'block',
						width: '100%',
						border: 0,
						background: 'transparent',
						padding: '8px 12px',
						fontSize: '12px',
						fontWeight: 700,
						color: '#4a3f78',
						cursor: 'pointer',
						textAlign: 'left',
						borderRadius: '8px',
					},
					children: text,
				});
			return jsxs('div', {
				style: {
					position: 'fixed',
					left: pos.x + 'px',
					top: pos.y + 'px',
					width: PET_WIDTH + 'px',
					zIndex: 9999,
					pointerEvents: 'none',
				},
				children: [
					message
						? jsx('div', {
								key: 'msg',
								style: {
									position: 'absolute',
									bottom: height + 8 + 'px',
									left: '50%',
									transform: 'translateX(-50%)',
									whiteSpace: 'nowrap',
									background: 'rgba(255,255,255,.96)',
									color: '#3b2f63',
									fontSize: '11px',
									fontWeight: 700,
									padding: '6px 10px',
									borderRadius: '10px',
									boxShadow: '0 8px 20px rgba(20,10,50,.22)',
									pointerEvents: 'none',
								},
								children: message,
							})
						: null,
					jsx('div', {
						key: 'pet',
						role: 'button',
						tabIndex: 0,
						title: label,
						'aria-label': label,
						onPointerDown,
						onPointerMove,
						onPointerUp,
						onPointerCancel: onPointerUp,
						onContextMenu: openMenu,
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
							animation: reacting
								? 'feiyu-pet-hop .6s ease-out'
								: 'feiyu-pet-bob 4.8s ease-in-out infinite',
							filter: 'drop-shadow(0 10px 16px rgba(20, 10, 50, .38))',
							willChange: 'transform',
						},
						children: jsx('img', {
							src: GAME_BASE + outfit.image,
							alt: '大肥鱼',
							draggable: false,
							style: layerStyle,
							onError: () => setArtOk(false),
						}),
					}),
					menu
						? jsx('div', {
								key: 'menu',
								ref: menuRef,
								style: {
									position: 'fixed',
									left: menu.x + 'px',
									top: menu.y + 'px',
									zIndex: 10000,
									minWidth: '160px',
									padding: '6px',
									borderRadius: '12px',
									background: '#fdfbff',
									border: '1px solid rgba(122,100,220,.2)',
									boxShadow: '0 12px 30px rgba(20,10,50,.28)',
									pointerEvents: 'auto',
								},
								children: [
									menuButton('🎀 打开换装间', () => {
										setMenu(null);
										props.openWardrobe();
									}),
									menuButton('🙈 隐藏小鲸鱼', hidePet),
								],
							})
						: null,
				],
			});
		}

		/** 注入悬浮小鲸鱼用的关键帧（只注入一次）。 */
		function ensurePetStyles() {
			if (document.getElementById('feiyu-pet-style')) return;
			const style = document.createElement('style');
			style.id = 'feiyu-pet-style';
			style.textContent =
				'@keyframes feiyu-pet-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }' +
				'@keyframes feiyu-pet-hop { 0% { transform: translateY(0) rotate(0); } 30% { transform: translateY(-16px) rotate(-4deg); } 60% { transform: translateY(2px) rotate(3deg); } 100% { transform: translateY(0) rotate(0); } }';
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

		/** 主面板：内嵌换装小游戏（宿主本地路由，离线可用）。 */
		function WardrobePanel() {
			const [petVisible, setPetVisible] = useState(() => {
				try {
					return localStorage.getItem(PET_HIDDEN_KEY) !== '1';
				} catch {
					return true;
				}
			});
			useEffect(() => {
				const sync = () => {
					try {
						setPetVisible(localStorage.getItem(PET_HIDDEN_KEY) !== '1');
					} catch {
						/* 忽略 */
					}
				};
				window.addEventListener('storage', sync);
				window.addEventListener(PET_VISIBILITY_EVENT, sync);
				return () => {
					window.removeEventListener('storage', sync);
					window.removeEventListener(PET_VISIBILITY_EVENT, sync);
				};
			}, []);
			const togglePet = () => {
				try {
					localStorage.setItem(PET_HIDDEN_KEY, petVisible ? '1' : '0');
				} catch {
					/* 忽略 */
				}
				setPetVisible(!petVisible);
				window.dispatchEvent(new Event(PET_VISIBILITY_EVENT));
			};
			const footStyle = {
				padding: '5px 14px',
				fontSize: '11.5px',
				color: '#8b82ad',
				display: 'flex',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: '10px',
				flex: '0 0 auto',
				background: '#fdf3ff',
			};
			const linkStyle = { color: '#6a5acd' };
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
						style: footStyle,
						children: [
							jsxs('span', {
								style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
								children: [
									'立绘 / 服装：Seedream 生成 · 非官方 · 禁止商用 · ',
									jsx('a', {
										href: 'https://github.com/GIT121995/dsh-feiyu-wardrobe',
										target: '_blank',
										rel: 'noopener noreferrer',
										style: linkStyle,
										children: 'GitHub',
									}),
								],
							}),
							jsx('button', {
								type: 'button',
								onClick: togglePet,
								title: petVisible ? '隐藏悬浮小鲸鱼' : '显示悬浮小鲸鱼',
								style: {
									border: '1px solid rgba(122,100,220,.25)',
									background: petVisible ? 'rgba(122,100,220,.12)' : 'transparent',
									color: '#6a5acd',
									fontSize: '11px',
									fontWeight: 700,
									padding: '3px 8px',
									borderRadius: '999px',
									cursor: 'pointer',
									flex: '0 0 auto',
								},
								children: petVisible ? '🐋 显示中' : '🐋 已隐藏',
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
