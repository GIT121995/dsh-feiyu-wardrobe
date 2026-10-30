// @ts-nocheck
/**
 * 大肥鱼衣橱 · 换装小游戏 —— 浏览器半区（DSH Web client plugin）
 *
 * 侧边栏图标入口（sidebar.panellist）+ 主面板（main keyed slot）内嵌换装小游戏。
 * 页面本体暂由 GitHub Pages 托管，后续可切到宿主本地静态路由。
 */
window.__ModuleLoader__.load({
	id: 'dsh-feiyu-wardrobe',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
		const { jsx, jsxs } = require('react/jsx-runtime');

		const PANEL_ID = 'feiyu-dressup';
		const GAME_URL = 'https://git121995.github.io/dsh-feiyu-wardrobe/dress-up/?embed=1';

		/** 侧边栏图标：小裙子 */
		function WardrobeIcon(props) {
			const size = (props && props.size) || 16;
			return jsx('span', {
				style: { fontSize: size + 'px', lineHeight: 1, display: 'inline-flex' },
				children: '🎀',
			});
		}

		/** 主面板：内嵌换装小游戏 */
		function WardrobePanel() {
			return jsxs('div', {
				style: {
					display: 'flex',
					flexDirection: 'column',
					width: '100%',
					height: '100%',
					minHeight: 0,
					background: '#fdf3ff',
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
							padding: '6px 14px',
							fontSize: '12px',
							color: '#8b82ad',
							textAlign: 'center',
							flex: '0 0 auto',
						},
						children: ['经典二创形象 + AI 裙子 · 非官方 · CC BY-NC-SA 4.0 · ',
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
		const inject = ['slots'];

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
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		return module.exports;
	},
});
