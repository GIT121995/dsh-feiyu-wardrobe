(() => {
  const $ = (sel) => document.querySelector(sel);
  const dressEl = $('#dress');
  const chipsEl = $('#chips');
  const nameEl = $('#dressName');
  const descEl = $('#dressDesc');
  const counterEl = $('#counter');
  const sparklesEl = $('#sparkles');
  const canvas = $('#exportCanvas');

  let manifest = null;
  let index = 0;
  const cache = new Map();

  function loadImage(file) {
    if (!cache.has(file)) {
      const promise = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = file;
      });
      cache.set(file, promise);
    }
    return cache.get(file);
  }

  async function load() {
    if (new URLSearchParams(location.search).has('embed')) document.body.classList.add('embed');
    const res = await fetch('manifest.json');
    manifest = await res.json();
    // warm cache for all dresses
    manifest.dresses.forEach((dress) => loadImage(dress.file).catch(() => {}));
    renderChips();
    makeSparkles(22);
    const start = Number(new URLSearchParams(location.search).get('dress'));
    show(Number.isInteger(start) && start >= 0 && start < manifest.dresses.length ? start : 0, true);
    bind();
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    manifest.dresses.forEach((dress, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.innerHTML = `<img src="${dress.file}" alt=""><span>${dress.name}</span>`;
      chip.addEventListener('click', () => show(i));
      chipsEl.appendChild(chip);
    });
  }

  async function show(next, instant = false) {
    index = (next + manifest.dresses.length) % manifest.dresses.length;
    const dress = manifest.dresses[index];
    nameEl.textContent = dress.name;
    descEl.textContent = dress.desc;
    counterEl.textContent = `${index + 1} / ${manifest.dresses.length}`;
    [...chipsEl.children].forEach((chip, i) => chip.classList.toggle('active', i === index));

    if (instant) {
      dressEl.src = dress.file;
      dressEl.alt = dress.name;
      return;
    }
    dressEl.classList.add('fading');
    try {
      const img = await loadImage(dress.file);
      // Swap only after the new image decoded — no blank frames, no old-image mismatch.
      dressEl.src = img.src;
      dressEl.alt = dress.name;
    } finally {
      requestAnimationFrame(() => dressEl.classList.remove('fading'));
    }
  }

  function next() { show(index + 1); }

  function makeSparkles(count) {
    sparklesEl.innerHTML = '';
    for (let i = 0; i < count; i += 1) {
      const s = document.createElement('span');
      s.className = 'sparkle';
      s.style.left = `${5 + Math.random() * 90}%`;
      s.style.top = `${8 + Math.random() * 84}%`;
      s.style.setProperty('--dur', `${2.4 + Math.random() * 3.2}s`);
      s.style.setProperty('--delay', `${Math.random() * 3}s`);
      sparklesEl.appendChild(s);
    }
  }

  function saveCard() {
    const dress = manifest.dresses[index];
    loadImage(dress.file).then((img) => {
      const ctx = canvas.getContext('2d');
      const W = canvas.width;
      const H = canvas.height;
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#fdf3ff');
      bg.addColorStop(0.5, '#eef4ff');
      bg.addColorStop(1, '#eaf8ff');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, W * 0.6);
      glow.addColorStop(0, 'rgba(255,255,255,0.95)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      const maxW = W * 0.78;
      const maxH = H * 0.68;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, H * 0.10, dw, dh);
      ctx.fillStyle = '#2b2350';
      ctx.font = '800 64px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(dress.name, W / 2, H * 0.88);
      ctx.font = '28px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
      ctx.fillStyle = '#7a6ea6';
      ctx.fillText(dress.desc, W / 2, H * 0.92);
      ctx.fillStyle = '#9a8fc0';
      ctx.font = '22px -apple-system, sans-serif';
      ctx.fillText('大肥鱼衣橱 · github.com/GIT121995/dsh-feiyu-wardrobe', W / 2, H * 0.965);
      const a = document.createElement('a');
      a.download = `feiyu-${dress.id}.png`;
      a.href = canvas.toDataURL('image/png');
      a.click();
    }).catch(() => alert('图片还没准备好，稍后再试～'));
  }

  function bind() {
    $('#randomBtn').addEventListener('click', () => {
      if (manifest.dresses.length < 2) return;
      let target = index;
      while (target === index) target = Math.floor(Math.random() * manifest.dresses.length);
      show(target);
    });
    $('#saveBtn').addEventListener('click', saveCard);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); show(index - 1); }
    });
    let startX = null;
    $('.showcase').addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
    $('.showcase').addEventListener('touchend', (e) => {
      if (startX == null) return;
      const dx = e.changedTouches[0].clientX - startX;
      if (Math.abs(dx) > 40) { if (dx < 0) next(); else show(index - 1); }
      startX = null;
    }, { passive: true });
  }

  load().catch((err) => {
    console.error(err);
    nameEl.textContent = '加载失败';
    descEl.textContent = '请通过 http:// 或 GitHub Pages 打开这个页面';
  });
})();
