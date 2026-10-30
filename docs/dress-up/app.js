(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const STORAGE_KEY = 'feiyu:outfit';
  const params = new URLSearchParams(location.search);

  const els = {
    scene: $('#scene'),
    figure: $('#figure'),
    base: $('#layerBase'),
    gown: $('#layerGown'),
    coat: $('#layerCoat'),
    hat: $('#layerHat'),
    fx: $('#fx'),
    bubble: $('#bubble'),
    tip: $('#stageTip'),
    shelf: $('#shelf'),
    lookName: $('#lookName'),
    lookDesc: $('#lookDesc'),
    sheet: $('#sheet'),
    sheetBody: $('#sheetBody'),
    sheetStat: $('#sheetStat'),
    canvas: $('#exportCanvas'),
  };

  let manifest = null;
  let tab = 'gowns';
  /** 衣柜分类 → 当前穿搭字段 */
  const STATE_KEY = { gowns: 'gown', coats: 'coat', hats: 'hat', backgrounds: 'bg', effects: 'effect' };
  const state = { gown: 'classic', coat: 'none', hat: 'none', bg: 'bg-snow', effect: 'snow' };
  const cache = new Map();

  /* ---------------- 数据小工具 ---------------- */

  function category(cat) {
    return manifest[cat] || [];
  }

  function findItem(cat, id) {
    return category(cat).find((item) => item.id === id) || category(cat)[0];
  }

  function currentGown() { return findItem('gowns', state.gown); }
  function currentBg() { return findItem('backgrounds', state.bg); }
  function currentCoat() { return findItem('coats', state.coat); }
  function currentHat() { return findItem('hats', state.hat); }
  function currentEffect() { return findItem('effects', state.effect); }

  function preload(src) {
    if (!src) return Promise.resolve(null);
    if (!cache.has(src)) {
      cache.set(src, new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      }));
    }
    return cache.get(src);
  }

  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, updatedAt: Date.now() }));
    } catch { /* 隐身模式忽略 */ }
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { saved = null; }
    const pick = (cat, id) => (category(cat).some((item) => item.id === id) ? id : category(cat)[0].id);
    state.gown = pick('gowns', (saved && saved.gown) || params.get('gown') || 'classic');
    state.coat = pick('coats', (saved && saved.coat) || params.get('coat') || 'none');
    state.hat = pick('hats', (saved && saved.hat) || params.get('hat') || 'none');
    state.bg = pick('backgrounds', (saved && saved.bg) || params.get('bg') || 'bg-snow');
    state.effect = pick('effects', (saved && saved.effect) || params.get('effect') || 'snow');
  }

  /* ---------------- 舞台渲染 ---------------- */

  function swapLayer(img, file, alt) {
    img.classList.add('fading');
    const apply = () => {
      if (file) {
        img.src = file;
        img.alt = alt || '';
        img.hidden = false;
      } else {
        img.hidden = true;
        img.removeAttribute('src');
        img.alt = '';
      }
      requestAnimationFrame(() => img.classList.remove('fading'));
    };
    if (!file) { apply(); return; }
    preload(file).then(apply, apply);
  }

  function renderCharacter() {
    swapLayer(els.base, manifest.base, '大肥鱼');
    swapLayer(els.gown, currentGown().file, currentGown().name);
    swapLayer(els.coat, currentCoat().file, currentCoat().name);
    swapLayer(els.hat, currentHat().file, currentHat().name);
  }

  function renderScene() {
    const bg = currentBg();
    els.scene.classList.add('fading');
    const apply = () => {
      els.scene.src = bg.file;
      els.scene.alt = bg.name;
      requestAnimationFrame(() => els.scene.classList.remove('fading'));
    };
    preload(bg.file).then(apply, apply);
  }

  function renderMeta() {
    const gown = currentGown();
    const parts = [];
    if (gown.file) parts.push(gown.name);
    else parts.push('经典原装');
    if (currentCoat().file) parts.push(currentCoat().name);
    if (currentHat().file) parts.push(currentHat().name);
    els.lookName.textContent = parts.join(' + ');
    els.lookDesc.textContent = `${currentBg().name} · ${currentEffect().name === '无' ? '没有特效' : currentEffect().name}`;
  }

  /** 按当前穿搭内容自动定位/缩放立绘：不同裙长各自铺满舞台。 */
  function layoutFigure() {
    const stage = els.figure.parentElement;
    const H = stage.clientHeight;
    const W = stage.clientWidth;
    if (!H || !W) return;
    const gown = currentGown();
    const hat = currentHat();
    const top = Math.min(manifest.layout.baseTop, hat.file ? hat.top : 1);
    const bottom = gown.file ? gown.bottom : manifest.layout.baseBottom;
    const usable = Math.max(0.2, bottom - top);
    const TOP = 0.105;
    const BOTTOM = 0.965;
    const hf = Math.min(
      ((BOTTOM - TOP) * H) / usable,
      H * 1.85,
      W / 0.62,
    );
    els.figure.style.height = `${Math.round(hf)}px`;
    els.figure.style.top = `${Math.round(TOP * H - top * hf)}px`;
  }

  function applyState() {
    renderCharacter();
    renderScene();
    renderMeta();
    setEffect(state.effect);
    renderShelf();
    layoutFigure();
    persist();
  }

  function select(cat, id) {
    state[STATE_KEY[cat]] = id;
    applyState();
    say(`换上「${findItem(cat, id).name}」啦！`);
  }

  /* ---------------- 衣柜 ---------------- */

  function renderShelf() {
    const list = category(tab);
    els.shelf.innerHTML = '';
    list.forEach((item) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      const active = item.id === state[STATE_KEY[tab]];
      btn.className = 'item' + (tab === 'backgrounds' ? ' bg' : '') + (active ? ' active' : '');
      btn.dataset.id = item.id;
      btn.title = item.desc || item.name;
      btn.setAttribute('aria-label', item.name);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (item.thumb) {
        const img = document.createElement('img');
        img.src = item.thumb;
        img.alt = '';
        img.loading = 'lazy';
        btn.appendChild(img);
      } else {
        const span = document.createElement('span');
        span.className = 'emoji';
        span.textContent = item.emoji || '✨';
        btn.appendChild(span);
      }
      const label = document.createElement('span');
      label.textContent = item.name;
      btn.appendChild(label);
      btn.addEventListener('click', () => select(tab, item.id));
      els.shelf.appendChild(btn);
    });
  }

  function setTab(next) {
    tab = next;
    document.querySelectorAll('.tab').forEach((el) => {
      const active = el.dataset.cat === next;
      el.classList.toggle('active', active);
      el.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    renderShelf();
  }

  /* ---------------- 说话 ---------------- */

  let bubbleTimer = 0;
  function say(text) {
    els.bubble.textContent = text;
    els.bubble.hidden = false;
    els.tip.classList.add('gone');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => { els.bubble.hidden = true; }, 2800);
  }

  function speakRandom() {
    const lines = manifest.bubbles || ['嗯？'];
    say(lines[Math.floor(Math.random() * lines.length)]);
  }

  /* ---------------- 随机 & 保存 ---------------- */

  function randomLook() {
    const pickFrom = (cat) => {
      const list = category(cat).filter((item) => item.id !== state[STATE_KEY[cat]]);
      return (list.length ? list : category(cat))[Math.floor(Math.random() * (list.length || category(cat).length))].id;
    };
    state.gown = pickFrom('gowns');
    state.coat = Math.random() < 0.5 ? pickFrom('coats') : 'none';
    state.hat = Math.random() < 0.75 ? pickFrom('hats') : 'none';
    state.bg = pickFrom('backgrounds');
    state.effect = pickFrom('effects');
    applyState();
    const lines = ['这样好不好看？', '转一圈——怎么样！', '嘿嘿，随机出来的也挺配。', '换好啦，像不像新的我？'];
    say(lines[Math.floor(Math.random() * lines.length)]);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  async function saveCard() {
    const canvas = els.canvas;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const bg = currentBg();
    const gown = currentGown();
    const hat = currentHat();
    const layers = [manifest.base, gown.file, currentCoat().file, hat.file].filter(Boolean);
    let images;
    try {
      images = await Promise.all([bg.file, ...layers].map((file) => preload(file)));
    } catch {
      alert('图片还没准备好，稍等一下再试～');
      return;
    }
    const bgImg = images[0];
    const scaleBg = Math.max(W / bgImg.width, H / bgImg.height);
    const bw = bgImg.width * scaleBg;
    const bh = bgImg.height * scaleBg;
    ctx.drawImage(bgImg, (W - bw) / 2, (H - bh) / 2, bw, bh);
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(0, 0, W, H);

    const figureH = H * 0.78;
    const figureW = figureH * 0.6;
    const fx = (W - figureW) / 2;
    const fy = H * 0.055;
    for (const img of images.slice(1)) ctx.drawImage(img, fx, fy, figureW, figureH);

    const grad = ctx.createLinearGradient(0, H * 0.62, 0, H);
    grad.addColorStop(0, 'rgba(20,12,45,0)');
    grad.addColorStop(0.55, 'rgba(20,12,45,0.5)');
    grad.addColorStop(1, 'rgba(20,12,45,0.82)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, H * 0.55, W, H * 0.45);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 46px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
    ctx.fillText(gown.file ? gown.name : '经典原装', W / 2, H * 0.9);
    ctx.font = '25px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    const sub = [bg.name, currentCoat().file ? currentCoat().name : null, hat.file ? hat.name : null].filter(Boolean).join(' · ');
    ctx.fillText(sub, W / 2, H * 0.935);
    ctx.font = '20px -apple-system, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillText('大肥鱼衣橱 · github.com/GIT121995/dsh-feiyu-wardrobe', W / 2, H * 0.972);

    const a = document.createElement('a');
    a.download = `feiyu-${state.gown}-${state.bg}.png`;
    a.href = canvas.toDataURL('image/png');
    a.click();
    say('立绘卡保存好啦，发群里给朋友看看～');
  }

  /* ---------------- 图鉴 ---------------- */

  function openSheet() {
    const sections = [
      ['gowns', '大裙子'],
      ['coats', '外套'],
      ['hats', '头饰'],
      ['backgrounds', '背景'],
      ['effects', '特效'],
    ];
    els.sheetBody.innerHTML = '';
    let own = 0;
    let total = 0;
    for (const [cat, title] of sections) {
      const head = document.createElement('div');
      head.className = 'sheet-section';
      const list = category(cat);
      head.textContent = `${title} · ${list.length}`;
      els.sheetBody.appendChild(head);
      for (const item of list) {
        total += 1;
        own += 1;
        const cell = document.createElement('div');
        cell.className = 'sheet-item';
        if (item.thumb) {
          const img = document.createElement('img');
          img.src = item.thumb;
          img.alt = '';
          img.loading = 'lazy';
          cell.appendChild(img);
        } else {
          const span = document.createElement('span');
          span.textContent = item.emoji || '✨';
          span.style.fontSize = '30px';
          cell.appendChild(span);
        }
        const name = document.createElement('span');
        name.textContent = item.name;
        cell.appendChild(name);
        els.sheetBody.appendChild(cell);
      }
    }
    els.sheetStat.textContent = `已收藏 ${own} / ${total} 件（全部免费解锁，随便换）· 角色：${manifest.character}`;
    const credit = document.createElement('p');
    credit.className = 'sheet-credit';
    credit.textContent = manifest.credits || '';
    els.sheetBody.appendChild(credit);
    els.sheet.hidden = false;
  }

  /* ---------------- 特效画布 ---------------- */

  const fxCanvas = els.fx;
  const fx = { type: 'none', parts: [], raf: 0, last: 0, dpr: 1 };
  const SPEED = { snow: 26, petals: 20, stars: 0 };

  function resizeFx() {
    const stage = els.fx.parentElement;
    fx.dpr = Math.min(2, window.devicePixelRatio || 1);
    fx.w = stage.clientWidth;
    fx.h = stage.clientHeight;
    fxCanvas.width = Math.max(1, Math.round(fx.w * fx.dpr));
    fxCanvas.height = Math.max(1, Math.round(fx.h * fx.dpr));
    fxCanvas.style.width = '100%';
    fxCanvas.style.height = '100%';
  }

  function spawnParticles(type) {
    fx.parts = [];
    if (type === 'none') return;
    const count = type === 'snow' ? 70 : type === 'petals' ? 46 : 60;
    for (let i = 0; i < count; i += 1) {
      fx.parts.push({
        x: Math.random() * fx.w,
        y: Math.random() * fx.h,
        r: type === 'snow' ? 1 + Math.random() * 2.4 : 2 + Math.random() * 3.2,
        vy: type === 'snow' ? 14 + Math.random() * 26 : 12 + Math.random() * 20,
        sway: Math.random() * 2 * Math.PI,
        swaySpeed: 0.4 + Math.random() * 1.2,
        spin: Math.random() * 2 * Math.PI,
        phase: Math.random() * 2 * Math.PI,
      });
    }
  }

  function setEffect(id) {
    fx.type = id;
    spawnParticles(id);
    if (!fx.raf) startFx();
  }

  function drawFx(dt) {
    const ctx = fxCanvas.getContext('2d');
    ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
    ctx.clearRect(0, 0, fx.w, fx.h);
    const t = performance.now() / 1000;
    for (const p of fx.parts) {
      if (fx.type === 'stars') {
        p.phase += dt * 1.6;
        const a = 0.25 + 0.65 * (0.5 + 0.5 * Math.sin(p.phase));
        ctx.fillStyle = `rgba(255, 245, 200, ${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      p.y += p.vy * dt;
      if (fx.type === 'snow') {
        p.x += Math.sin(t * p.swaySpeed + p.sway) * 12 * dt;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        p.x += Math.sin(t * p.swaySpeed + p.sway) * 18 * dt;
        p.spin += dt * 1.8;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.spin);
        ctx.fillStyle = 'rgba(255, 190, 225, 0.85)';
        ctx.beginPath();
        ctx.ellipse(0, 0, p.r * 1.6, p.r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      if (p.y > fx.h + 8) { p.y = -8; p.x = Math.random() * fx.w; }
      if (p.x < -10) p.x = fx.w + 10;
      if (p.x > fx.w + 10) p.x = -10;
    }
  }

  function startFx() {
    const loop = (now) => {
      fx.raf = requestAnimationFrame(loop);
      if (document.hidden) return;
      const dt = Math.min(0.05, (now - (fx.last || now)) / 1000);
      fx.last = now;
      drawFx(dt);
    };
    fx.raf = requestAnimationFrame(loop);
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    document.querySelectorAll('.tab').forEach((el) => {
      el.addEventListener('click', () => setTab(el.dataset.cat));
    });
    $('#randomBtn').addEventListener('click', randomLook);
    $('#saveBtn').addEventListener('click', saveCard);
    $('#collectBtn').addEventListener('click', openSheet);
    $('#sheetClose').addEventListener('click', () => { els.sheet.hidden = true; });
    els.sheet.addEventListener('click', (e) => { if (e.target === els.sheet) els.sheet.hidden = true; });
    els.figure.addEventListener('click', speakRandom);
    els.figure.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); speakRandom(); }
    });
    window.addEventListener('keydown', (e) => {
      if (e.target && /INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.key === 'ArrowRight') { state.gown = cycle('gowns', 1); applyState(); }
      if (e.key === 'ArrowLeft') { state.gown = cycle('gowns', -1); applyState(); }
      if (e.key.toLowerCase() === 'r') randomLook();
      if (e.key === 'Escape') els.sheet.hidden = true;
    });
    window.addEventListener('resize', () => { resizeFx(); spawnParticles(fx.type); layoutFigure(); });
  }

  function cycle(cat, dir) {
    const list = category(cat);
    const idx = list.findIndex((item) => item.id === state[STATE_KEY[cat]]);
    return list[(idx + dir + list.length) % list.length].id;
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    if (params.has('embed')) document.body.classList.add('embed');
    const res = await fetch('manifest.json', { cache: 'no-cache' });
    manifest = await res.json();
    restore();
    document.title = `${manifest.character} · 大肥鱼衣橱`;
    renderCharacter();
    renderScene();
    renderMeta();
    setTab('gowns');
    resizeFx();
    layoutFigure();
    setEffect(state.effect);
    bind();
    persist();
    if (params.has('embed')) els.tip.classList.add('gone');
  }

  boot().catch((err) => {
    console.error(err);
    els.lookName.textContent = '加载失败';
    els.lookDesc.textContent = '素材没加载出来，刷新页面试试';
  });
})();
