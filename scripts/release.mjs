#!/usr/bin/env node
/**
 * 发版检查清单自动化（默认 dry-run，只打印命令；`--execute` 才真正执行）。
 *
 * 流程（rc 先行 → 验证后 promote latest）：
 *   1. 工作区干净 / 分支 / package·CHANGELOG·README·资产&页面版本一致性 / tag 不冲突
 *   2. npm run verify:full（package.json 无 verify:full 时回退 npm run verify）
 *   3. git tag -a vX.Y.Z + push main + push tag
 *   4. npm publish --tag rc --registry=https://registry.npmjs.org
 *   5. gh release create vX.Y.Z（notes 从 CHANGELOG 对应版本段自动提取）
 *   6. 本机 profile 升级：~/.dsh/profiles/web `pnpm add dsh-feiyu-wardrobe@X.Y.Z`
 *   7. bash /home/ubuntu/dsh/restart-dsh.sh --deferred 240（异步重启，不杀当前会话）
 *   8. npm dist-tag add dsh-feiyu-wardrobe@X.Y.Z latest（promote）+ 打印 dist-tags 确认
 *
 * 安全约束：
 *   - 默认 **dry-run**：任何命令都不执行（只做本地只读检查并打印计划）。
 *   - `--execute` 才执行；且 publish 需要额外 `--yes-publish`、重启需要 `--yes-restart`
 *     （缺任一个直接拒绝，避免执行到一半停住）。
 *   - 只允许在 main 分支、干净工作区执行（`--branch` 可改期望分支，`--allow-branch` 仅供预演）。
 *   - 每步失败立即停止并打印回滚提示；不自动回滚、不自动 push 到非预期分支。
 *
 * 用法：
 *   node scripts/release.mjs                          # dry-run（版本取 package.json）
 *   node scripts/release.mjs 2.6.0                    # dry-run 指定版本
 *   node scripts/release.mjs 2.6.0 --execute --yes-publish --yes-restart   # 真发
 *
 * 可选参数：
 *   --branch <name>      期望分支（默认 main；execute 时当前分支必须一致）
 *   --allow-branch       预演用：允许当前分支 != 期望分支（execute 时拒绝）
 *   --notes-file <path>  gh release notes 文件（默认从 CHANGELOG 提取）
 *   --registry <url>     npm registry（默认环境变量 FEIYU_REGISTRY 或 registry.npmjs.org；
 *                        本机默认 npmmirror 滞后，**发布必须显式 official registry**）
 *   --profile-dir <dir>  DSH profile 目录（默认 ~/.dsh/profiles/web）
 *   --restart-script <p> 重启脚本（默认 <repo>/../restart-dsh.sh）
 *   --help
 *
 * 退出码：0 成功/计划打印完成；1 执行失败；2 前置检查/参数错误。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(SCRIPT_DIR, '..');
const PKG_NAME = 'dsh-feiyu-wardrobe';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const DEFAULT_BRANCH = 'main';
const RESTART_DELAY_SECONDS = 240;

/* ------------------------------------------------------------------ 工具 -- */

class ReleaseError extends Error {
	/** @param {string} message @param {number} [exitCode] */
	constructor(message, exitCode = 1) {
		super(message);
		this.exitCode = exitCode;
	}
}

const log = (...args) => console.log(...args);
const quote = (value) => (/^[\w@%+./:=,-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`);
const tail = (text, lines = 40) => {
	const list = String(text || '').trimEnd().split('\n');
	return list.slice(-lines).join('\n');
};

function readJson(file) {
	return JSON.parse(readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
	/** @type {Record<string, any>} */
	const options = {
		version: '',
		execute: false,
		yesPublish: false,
		yesRestart: false,
		branch: DEFAULT_BRANCH,
		allowBranch: false,
		notesFile: '',
		registry: process.env.FEIYU_REGISTRY || DEFAULT_REGISTRY,
		profileDir: process.env.FEIYU_PROFILE_DIR || join(homedir(), '.dsh', 'profiles', 'web'),
		restartScript: process.env.FEIYU_RESTART_SCRIPT || join(REPO, '..', 'restart-dsh.sh'),
		help: false,
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const value = argv[i + 1];
			if (!value || String(value).startsWith('--')) throw new ReleaseError(`参数 ${arg} 缺少值`, 2);
			i += 1;
			return value;
		};
		switch (arg) {
			case '--execute': options.execute = true; break;
			case '--yes-publish': options.yesPublish = true; break;
			case '--yes-restart': options.yesRestart = true; break;
			case '--branch': options.branch = next(); break;
			case '--allow-branch': options.allowBranch = true; break;
			case '--notes-file': options.notesFile = resolve(next()); break;
			case '--registry': options.registry = next(); break;
			case '--profile-dir': options.profileDir = resolve(next()); break;
			case '--restart-script': options.restartScript = resolve(next()); break;
			case '--help': case '-h': options.help = true; break;
			default:
				if (arg.startsWith('-')) throw new ReleaseError(`未知参数：${arg}（--help 查看用法）`, 2);
				if (options.version) throw new ReleaseError(`多余的位置参数：${arg}`, 2);
				options.version = arg;
		}
	}
	return options;
}

function printHelp() {
	log(`用法：node scripts/release.mjs [X.Y.Z] [选项]

默认 dry-run：只打印将执行的命令。真发需要：
  node scripts/release.mjs X.Y.Z --execute --yes-publish --yes-restart

选项：
  --execute            真正执行（默认只打印）
  --yes-publish        确认执行 npm publish（危险步骤显式确认）
  --yes-restart        确认执行 deferred 重启 dsh（危险步骤显式确认）
  --branch <name>      期望分支（默认 main）
  --allow-branch       预演允许分支不一致（execute 时无效）
  --notes-file <path>  gh release notes 文件（默认从 CHANGELOG 提取对应版本段）
  --registry <url>     npm registry（默认 ${DEFAULT_REGISTRY}）
  --profile-dir <dir>  DSH profile 目录（默认 ~/.dsh/profiles/web）
  --restart-script <p> 重启脚本（默认 <repo>/../restart-dsh.sh）
  --help

步骤：检查 → verify:full → tag+push → npm publish --tag rc → gh release →
      本机 profile 升级 → deferred 重启 → promote latest。每步失败即停并给回滚提示。`);
}

/** 执行只读命令并返回 stdout（失败抛出）。 */
function capture(cmd, args, options = {}) {
	return execFileSync(cmd, args, {
		cwd: options.cwd || REPO,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: options.timeout || 120000,
	}).trim();
}

/** 执行命令（stdio 透传），失败时抛 ReleaseError。 */
function runCommand(command, dryRun) {
	const cwd = command.cwd || REPO;
	log(`$ ${quote(command.cmd)} ${command.args.map(quote).join(' ')}${cwd !== REPO ? `    # cwd ${cwd}` : ''}`);
	if (dryRun) return;
	try {
		execFileSync(command.cmd, command.args, { cwd, stdio: 'inherit', timeout: command.timeout || 15 * 60 * 1000 });
	} catch (error) {
		throw new ReleaseError(`命令失败（exit ${error.status ?? '?'}）：${command.cmd} ${command.args.join(' ')}`);
	}
}

/* ---------------------------------------------------- 版本/页面资产探测 -- */

const IGNORED_DIRS = new Set(['art', 'node_modules']);

/** 探测 docs/dress-up 页面 `?v=`（唯一）与 RUNTIME_2D5_ASSET_VERSION。 */
function detectVisualVersions(repo) {
	const docsDir = join(repo, 'docs', 'dress-up');
	const appFile = join(docsDir, 'app.js');
	if (!existsSync(appFile)) throw new ReleaseError(`找不到 ${appFile}`, 2);
	const assetMatch = readFileSync(appFile, 'utf8').match(/RUNTIME_2D5_ASSET_VERSION\s*=\s*'(\d+)'/);
	if (!assetMatch) throw new ReleaseError('app.js 缺少 RUNTIME_2D5_ASSET_VERSION', 2);
	/** @type {Set<number>} */
	const pageVersions = new Set();
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) walk(full);
				continue;
			}
			if (!entry.isFile() || !/\.(html|js|css|json)$/i.test(entry.name)) continue;
			for (const match of readFileSync(full, 'utf8').matchAll(/\?v=(\d+)/g)) pageVersions.add(Number(match[1]));
		}
	};
	walk(docsDir);
	if (pageVersions.size !== 1) {
		throw new ReleaseError(`页面模块 ?v= 不唯一（cache-bust 漏改）：${[...pageVersions].map((v) => `v${v}`).join(', ')}`, 2);
	}
	return { asset: Number(assetMatch[1]), page: [...pageVersions][0] };
}

/* ------------------------------------------------------------- 前置检查 -- */

/**
 * 本地只读检查（dry-run 也执行）。返回发版上下文。
 * @param {Record<string, any>} options
 */
function preflight(options) {
	const packageFile = join(REPO, 'package.json');
	if (!existsSync(packageFile)) throw new ReleaseError(`不是预期的仓库根（缺 package.json）：${REPO}`, 2);
	const pkg = readJson(packageFile);
	if (pkg.name !== PKG_NAME) throw new ReleaseError(`package.json name=${pkg.name}，期望 ${PKG_NAME}`, 2);
	const target = options.version || pkg.version;
	if (!/^\d+\.\d+\.\d+$/.test(target)) {
		throw new ReleaseError(`版本号须为 X.Y.Z（本流程 rc→latest 用 dist-tag，不发布 npm prerelease 版本号）：${target}`, 2);
	}
	const checks = [];
	/** @param {string} label @param {string} detail */
	const ok = (label, detail = '') => checks.push({ label, detail, status: 'ok' });

	if (pkg.version !== target) throw new ReleaseError(`package.json version=${pkg.version} ≠ 目标 ${target}（先把版本号改好再发）`, 2);
	ok('package.json 版本', target);

	const changelogFile = join(REPO, 'CHANGELOG.md');
	if (!existsSync(changelogFile)) throw new ReleaseError('缺少 CHANGELOG.md', 2);
	const changelog = readFileSync(changelogFile, 'utf8');
	const changelogVersions = [...changelog.matchAll(/^##\s+(?:\[)?v?(\d+\.\d+\.\d+)\b/gm)].map((match) => match[1]);
	if (changelogVersions.length === 0 || changelogVersions[0] !== target) {
		throw new ReleaseError(`CHANGELOG.md 首个版本段是 ${changelogVersions[0] || '（无）'}，不是目标 ${target}（请先写 CHANGELOG 条目）`, 2);
	}
	ok('CHANGELOG 首段版本', target);

	const readmeFile = join(REPO, 'README.md');
	if (!existsSync(readmeFile)) throw new ReleaseError('缺少 README.md', 2);
	const readme = readFileSync(readmeFile, 'utf8');
	const readmeVersion = readme.match(/当前版本[：:]\s*`v?(\d+\.\d+\.\d+)`/);
	if (readmeVersion && readmeVersion[1] !== target) {
		throw new ReleaseError(`README 当前版本=${readmeVersion[1]} ≠ 目标 ${target}`, 2);
	}
	if (!new RegExp(`v?${target.replace(/\./g, '\\.')}(?![\\d.])`).test(readme)) {
		throw new ReleaseError(`README 未提及目标版本 ${target}（版本号/升级说明需同步）`, 2);
	}
	ok('README 版本', readmeVersion ? readmeVersion[1] : `${target}（无「当前版本」行）`);

	const visual = detectVisualVersions(REPO);
	ok('视觉版本', `资产 v${visual.asset} / 页面 v${visual.page}`);
	const changelogSection = extractChangelogSection(changelog, target);
	const mentionAsset = new RegExp(`资产\\s*v?${visual.asset}\\b`).test(changelogSection);
	const mentionPage = new RegExp(`页面(?:模块)?\\s*v?${visual.page}\\b`).test(changelogSection);
	if (!mentionAsset || !mentionPage) {
		checks.push({ label: 'CHANGELOG 视觉版本记录', detail: `提议补充「资产 v${visual.asset}/页面 v${visual.page}」（当前${mentionAsset ? '' : '缺资产版本'}${mentionPage ? '' : '、缺页面版本'}）`, status: 'warn' });
	} else {
		ok('CHANGELOG 视觉版本记录', `资产 v${visual.asset}/页面 v${visual.page}`);
	}

	// 视觉基线版本一致性（提示，不阻塞发版；不一致说明 visual-qa 需要重生成基线）
	const baselineManifest = join(REPO, 'docs', 'qa-baseline', 'manifest.json');
	if (existsSync(baselineManifest)) {
		const baseline = readJson(baselineManifest);
		if (baseline.versions && (baseline.versions.asset !== visual.asset || baseline.versions.page !== visual.page)) {
			checks.push({ label: '视觉基线版本', detail: `基线为 资产 v${baseline.versions.asset}/页面 v${baseline.versions.page}，与当前不一致 → 发版前需 --mode baseline 重生成并提交`, status: 'warn' });
		} else {
			ok('视觉基线版本', `与当前一致（资产 v${visual.asset}/页面 v${visual.page}）`);
		}
	} else {
		checks.push({ label: '视觉基线', detail: '缺少 docs/qa-baseline/manifest.json（发版前应生成）', status: 'warn' });
	}

	// Git 状态/分支/tag
	const branch = capture('git', ['branch', '--show-current']);
	if (branch !== options.branch && !options.allowBranch) {
		throw new ReleaseError(`当前分支 ${branch} ≠ 期望 ${options.branch}（换分支或加 --allow-branch 仅预演）`, 2);
	}
	ok('当前分支', branch);
	const dirty = capture('git', ['status', '--porcelain']);
	if (dirty) throw new ReleaseError(`工作区不干净，发版前必须提交/清理：\n${tail(dirty, 15)}`, 2);
	ok('工作区', '干净');
	const tagName = `v${target}`;
	const existingTags = new Set(capture('git', ['tag', '--list', tagName]).split('\n').filter(Boolean));
	if (existingTags.has(tagName)) throw new ReleaseError(`tag ${tagName} 已存在（本地），拒绝重复发版`, 2);
	ok('git tag', `${tagName} 可用`);

	// 工具/路径存在性
	if (!existsSync(join(REPO, 'node_modules'))) throw new ReleaseError('缺少 node_modules（先 npm install）', 2);
	if (!existsSync(options.restartScript)) {
		checks.push({ label: '重启脚本', detail: `${options.restartScript} 不存在（execute 前必须就位，或用 --restart-script 指定）`, status: 'warn' });
	} else {
		ok('重启脚本', options.restartScript);
	}
	if (!existsSync(join(options.profileDir, 'package.json'))) {
		checks.push({ label: 'DSH profile', detail: `${options.profileDir} 不存在（execute 前需确认）`, status: 'warn' });
	} else {
		const profilePkg = readJson(join(options.profileDir, 'package.json'));
		const installed = (profilePkg.dependencies && profilePkg.dependencies[PKG_NAME]) || '';
		ok('DSH profile', `${options.profileDir}（当前 ${installed || '未安装'}）`);
	}

	// 验证脚本（verify:full 优先，w0 前回退 verify）
	const verifyScript = pkg.scripts && pkg.scripts['verify:full'] ? 'verify:full' : (pkg.scripts && pkg.scripts.verify ? 'verify' : '');
	if (!verifyScript) throw new ReleaseError('package.json 既无 verify:full 也无 verify 脚本', 2);
	if (verifyScript !== 'verify:full') {
		checks.push({ label: '验证脚本', detail: 'package.json 尚无 verify:full，回退 npm run verify（W0 合入后应改为 verify:full）', status: 'warn' });
	} else {
		ok('验证脚本', 'npm run verify:full');
	}

	return { pkg, target, visual, checks, branch, tagName, verifyScript, changelogSection };
}

/** 从 CHANGELOG 提取某版本段落（到下一个 `## ` 为止）。 */
function extractChangelogSection(changelog, version) {
	const lines = changelog.split('\n');
	const start = lines.findIndex((line) => new RegExp(`^##\\s+(?:\\[)?v?${version.replace(/\./g, '\\.')}\\b`).test(line));
	if (start < 0) return '';
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (/^##\s+/.test(lines[i])) { end = i; break; }
	}
	return lines.slice(start, end).join('\n').trim();
}

/* ------------------------------------------------------------------ 计划 -- */

/**
 * 生成发版计划（步骤数组）。每步：{ name, commands, rollback, requires? }
 * @param {Record<string, any>} options
 * @param {ReturnType<typeof preflight>} context
 */
function buildPlan(options, context) {
	const { target, tagName, verifyScript, branch } = context;
	const { registry } = options;
	const tarball = `${registry.replace(/\/$/, '')}/${PKG_NAME}/-/${PKG_NAME}-${target}.tgz`;
	const profilePkg = existsSync(join(options.profileDir, 'package.json')) ? readJson(join(options.profileDir, 'package.json')) : null;
	const prevProfile = (profilePkg && profilePkg.dependencies && profilePkg.dependencies[PKG_NAME]) || '<profile 当前版本>';
	const notesFile = options.notesFile || `/tmp/feiyu-release-notes-v${target}.md`;
	const command = (cmd, args, extra = {}) => ({ cmd, args, ...extra });

	return [
		{
			name: '1/8 前置检查（工作区/分支/版本一致性/tag 冲突）',
			kind: 'checks',
			summary: context.checks,
			rollback: '无副作用：修正 package.json / CHANGELOG / README / 版本号后重跑。',
		},
		{
			name: `2/8 验证：npm run ${verifyScript}`,
			commands: [command('npm', ['run', verifyScript])],
			rollback: '无外部副作用；修复失败测试/类型错误后重跑。**不得跳过验证发版**。',
		},
		{
			name: `3/8 Git tag + 推送（${tagName} → origin/${branch}）`,
			commands: [
				command('git', ['tag', '-a', tagName, '-m', tagName]),
				command('git', ['push', 'origin', branch]),
				command('git', ['push', 'origin', tagName]),
			],
			rollback: `未发布 npm，可撤回：git tag -d ${tagName}；git push origin :refs/tags/${tagName}；若 main 已推送需人工处理（git revert/回退前先确认）。`,
		},
		{
			name: '4/8 npm publish --tag rc（official registry，rc 不立即影响 latest）',
			requires: 'publish',
			commands: [
				command('npm', ['publish', '--tag', 'rc', `--registry=${registry}`]),
				// publish 后轮询 tarball 可达（registry 传播延迟，最多 ~60s）
				command('bash', ['-lc', `for i in $(seq 1 20); do code=$(curl -s -o /dev/null -w '%{http_code}' '${tarball}'); echo "tarball HTTP $code (try $i/20)"; [ "$code" = 200 ] && exit 0; sleep 3; done; exit 1`]),
			],
			rollback: `72h 内可撤回：npm unpublish ${PKG_NAME}@${target} --force --registry=${registry}；并撤销 tag（见上一步）。先确认 latest 未被 promote。`,
		},
		{
			name: `5/8 GitHub Release（${tagName}，notes=${options.notesFile ? options.notesFile : 'CHANGELOG 自动提取'}）`,
			commands: [
				command('gh', ['release', 'create', tagName, '--title', tagName, '--notes-file', notesFile]),
			],
			rollback: `gh release delete ${tagName} --yes；npm 包不用撤（rc 已发布，可继续修复后重发更高版本）。`,
		},
		{
			name: '6/8 本机 DSH profile 升级（pnpm add）',
			commands: [
				command('pnpm', ['add', `${PKG_NAME}@${target}`, `--registry=${registry}`], { cwd: options.profileDir }),
			],
			rollback: `pnpm add ${PKG_NAME}@${prevProfile} --registry=${registry}（cwd ${options.profileDir}）回退 profile；未重启前线上仍跑旧版。`,
		},
		{
			name: '7/8 deferred 重启 dsh（异步，不杀当前会话）',
			requires: 'restart',
			commands: [
				command('bash', [options.restartScript, '--deferred', String(RESTART_DELAY_SECONDS)]),
			],
			rollback: `重启已排队但未执行前可取消（systemd-run 单元）；若已重启：profile 回退到 ${prevProfile} 后再执行 restart-dsh.sh --deferred 120。`,
		},
		{
			name: '8/8 promote latest + 确认 dist-tags',
			commands: [
				command('npm', ['dist-tag', 'add', `${PKG_NAME}@${target}`, 'latest', `--registry=${registry}`]),
				command('npm', ['view', PKG_NAME, 'dist-tags', `--registry=${registry}`]),
			],
			rollback: `latest 指错时改回上一版：npm dist-tag add ${PKG_NAME}@<上一 latest> latest --registry=${registry}；用户 npm i 兜底靠 dist-tag，务必确认输出。`,
		},
	];
}

/* ------------------------------------------------------------------ 执行 -- */

function printChecks(checks) {
	for (const check of checks) {
		const icon = check.status === 'ok' ? '✓' : '⚠';
		log(`  ${icon} ${check.label}${check.detail ? `：${check.detail}` : ''}`);
	}
}

function printPlan(plan, options, context) {
	log('');
	log('发版计划（dry-run：以下命令都不会执行）');
	for (const step of plan) {
		log('');
		log(`[${step.name}]${step.requires ? `（需要 --yes-${step.requires}）` : ''}`);
		if (step.kind === 'checks') printChecks(step.summary);
		for (const command of step.commands || []) {
			log(`  $ ${quote(command.cmd)} ${command.args.map(quote).join(' ')}${command.cwd ? `    # cwd ${command.cwd}` : ''}`);
		}
		log(`  回滚提示：${step.rollback}`);
	}
	log('');
	log(`确认无误后执行：node scripts/release.mjs ${context.target} --execute --yes-publish --yes-restart`);
}

async function executePlan(plan, options, context) {
	log('');
	log('开始执行发版（每步失败即停）');
	for (const step of plan) {
		log('');
		log(`▶ [${step.name}]`);
		if (step.kind === 'checks') { printChecks(step.summary); continue; }
		if (step.requires === 'publish' && !options.yesPublish) throw new ReleaseError('拒绝执行 npm publish：缺少 --yes-publish', 2);
		if (step.requires === 'restart' && !options.yesRestart) throw new ReleaseError('拒绝执行 deferred 重启：缺少 --yes-restart', 2);
		if (step.name.startsWith('5/8')) {
			// gh release notes：优先 --notes-file，其次从 CHANGELOG 自动提取
			const notesFile = options.notesFile || `/tmp/feiyu-release-notes-v${context.target}.md`;
			if (!options.notesFile) writeFileSync(notesFile, `${context.changelogSection}\n`, 'utf8');
			if (!existsSync(notesFile)) throw new ReleaseError(`release notes 文件不存在：${notesFile}`, 2);
		}
		try {
			for (const command of step.commands || []) runCommand(command, false);
		} catch (error) {
			log('');
			log(`✗ 步骤失败：${step.name}`);
			log(`  ${error.message}`);
			log('  回滚提示：');
			log(`  ${String(step.rollback).replace(/\n/g, '\n  ')}`);
			throw new ReleaseError(`发版中止于「${step.name}」`, 1);
		}
	}
	log('');
	log(`✓ 发版完成：${PKG_NAME}@${context.target} 已发布 rc 并 promote 为 latest；dsh 已排队重启（${RESTART_DELAY_SECONDS}s 后）。`);
	log('  发版后自查：npm view dist-tags / gh release view / :3080 页面版本与资产版本 / 重启日志。');
}

/* ------------------------------------------------------------------ main -- */

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) { printHelp(); return; }
	log(`发版检查清单 · ${options.execute ? 'EXECUTE（真实执行）' : 'DRY-RUN（只打印，不执行）'}`);
	log(`  repo=${REPO} · registry=${options.registry}`);

	if (options.execute) {
		if (!options.yesPublish) throw new ReleaseError('--execute 需要同时给出 --yes-publish（publish 是危险步骤）', 2);
		if (!options.yesRestart) throw new ReleaseError('--execute 需要同时给出 --yes-restart（重启是危险步骤）', 2);
		if (options.allowBranch) throw new ReleaseError('--allow-branch 只能用于 dry-run 预演，--execute 时请切到期望分支', 2);
	} else if (process.env.FEIYU_RELEASE_EXECUTE === '1') {
		throw new ReleaseError('FEIYU_RELEASE_EXECUTE 不再是有效开关，请显式使用 --execute --yes-publish --yes-restart', 2);
	}

	const context = preflight(options);
	const plan = buildPlan(options, context);

	if (!options.execute) {
		printPlan(plan, options, context);
		return;
	}

	// execute：本地检查在计划第 1 步输出；这里补网络只读确认（账号/版本占用），再真正执行
	log('');
	log('执行前置检查（网络只读）');
	try {
		const whoami = capture('npm', ['whoami', `--registry=${options.registry}`], { timeout: 60000 });
		log(`  ✓ npm 账号：${whoami}（${options.registry}）`);
	} catch {
		throw new ReleaseError(`npm 未登录或 registry 不可达：${options.registry}（先 npm login --registry=${options.registry}）`, 2);
	}
	// 目标版本不得已存在于 registry
	try {
		const published = capture('npm', ['view', `${PKG_NAME}@${context.target}`, 'version', `--registry=${options.registry}`], { timeout: 60000 });
		if (published) throw new ReleaseError(`版本 ${context.target} 已存在于 registry（${published}），拒绝重复发布`, 2);
	} catch (error) {
		if (error instanceof ReleaseError) throw error;
		// npm view 对不存在版本返回非 0 / 空输出 = 可以发布
	}

	await executePlan(plan, options, context);
}

main().catch((error) => {
	const exitCode = Number.isInteger(error && error.exitCode) ? error.exitCode : 1;
	log('');
	log(`✗ ${error && error.message ? error.message : error}`);
	process.exitCode = exitCode;
});
