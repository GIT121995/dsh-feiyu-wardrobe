(() => {
  const $ = (sel) => document.querySelector(sel);
  const dressA = $('#dressA');
  const dressB = $('#dressB');
  const chipsEl = $('#chips');
  const nameEl = $('#dressName');
  const descEl = $('#dressDesc');
  const counterEl = $('#counter');
  const sparklesEl = $('#sparkles');
  const canvas = $('#exportCanvas');

  let manifest = null;
  let index = 0;
  let front = dressA;
  let back = dressB;

  async function load() {
    guard(dressA);
    guard(dressB);
    const res = await fetch('manifest.json');
    manifest = await res.json();
    renderChips();
    makeSparkles(22);
    const start = Number(new URLSearchParams(location.search).get('dress'));
    show(Number.isInteger(start) && start >= 0 && start < manifest.dresses.length ? start : 0, true);
    bind();
  }

  function preload(dress) {
    const img = new Image();
    img.src = dress.file;
    return img;
  }

  function renderChips() {
    chipsEl.innerHTML = '';
    manifest.dresses.forEach((dress, i) => {
      const chip = document.createElement('button');
      chip.className = 'chip';
      chip.type = 'button';
      chip.dataset.index = String(i);
      chip.innerHTML = `<img src="${dress.file}" alt=""><span>${dress.name}</span>`;
      chip.addEventListener('click', () => show(i));
      chipsEl.appendChild(chip);
    });
  }

  function show(next, instant = false) {
    index = (next + manifest.dresses.length) % manifest.dresses.length;
    const dress = manifest.dresses[index];
    nameEl.textContent = dress.name;
    descEl.textContent = dress.desc;
    counterEl.textContent = `${index + 1} / ${manifest.dresses.length}`;
    [...chipsEl.children].forEach((chip, i) => chip.classList.toggle('active', i === index));

    if (instant) {
      dressB.classList.add('hidden');
      dressA.classList.remove('hidden');
      dressA.src = dress.file;
      dressA.alt = dress.name;
      dressB.src = dress.file;
      front = dressA;
      back = dressB;
      return;
    }
    const incoming = back;
    const outgoing = front;
    incoming.src = dress.file;
    incoming.alt = dress.name;
    incoming.classList.remove('hidden');
    requestAnimationFrame(() => {
      outgoing.classList.add('hidden');
      incoming.classList.remove('hidden');
      front = incoming;
      back = outgoing;
    });
  }

  function guard(img) {
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    img.addEventListener('load', () => { img.style.visibility = ''; });
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
    const img = preload(dress);
    img.onload = () => {
      const ctx = canvas.getContext('2d');
      const W = canvas.width;
      const H = canvas.height;
      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, '#fdf3ff');
      bg.addColorStop(0.5, '#eef4ff');
      bg.addColorStop(1, '#eaf8ff');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      // soft glow
      const glow = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H * 0.42, W * 0.6);
      glow.addColorStop(0, 'rgba(255,255,255,0.95)');
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      // figure fitted
      const maxW = W * 0.78;
      const maxH = H * 0.68;
      const scale = Math.min(maxW / img.width, maxH / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      ctx.drawImage(img, (W - dw) / 2, H * 0.10, dw, dh);
      // title
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
    };
    img.onerror = () => {
      // graceful fallback when the dress image is missing
      alert('图片还没准备好，稍后再试～');
    };
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
    // swipe on mobile
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
