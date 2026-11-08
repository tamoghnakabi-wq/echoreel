// Echoreel website: platform glyphs, the download buttons, the routing panel and the monitor wall.
(() => {
  const P = ['youtube', 'instagram', 'tiktok'];
  const NAMES = { youtube: 'YouTube', instagram: 'Instagram', tiktok: 'TikTok' };
  const GLYPH = {
    youtube: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.5 7.8v8.4l7-4.2z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="5"/><circle cx="12" cy="12" r="3.6"/><circle cx="17" cy="7" r="0.6" fill="currentColor"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.5 3h2.6c.3 2 1.6 3.4 3.4 3.7v2.7c-1.3 0-2.5-.4-3.5-1v6.3a5.4 5.4 0 1 1-5.4-5.4c.3 0 .6 0 .9.1v2.8a2.6 2.6 0 1 0 2 2.5z"/></svg>',
  };
  const CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
  const pf = (p, sm) => `<span class="pf ${p}${sm ? ' sm' : ''}">${GLYPH[p]}</span>`;
  const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  for (const el of document.querySelectorAll('.pf')) {
    const p = P.find((x) => el.classList.contains(x));
    if (p && !el.innerHTML) el.innerHTML = GLYPH[p];
  }

  // ---------- downloads ----------
  const base = 'https://github.com/tamoghnakabi-wq/echoreel/releases/latest/download/';
  const FILES = { arm: 'Echoreel-mac-arm64.dmg', intel: 'Echoreel-mac-x64.dmg', win: 'Echoreel-win-x64-setup.exe' };
  const main = document.getElementById('dl-main');
  const alt = document.getElementById('dl-alt');
  const ua = navigator.userAgent;
  function appleSilicon() {
    // Every Mac browser says "Intel" in its user agent, so ask the graphics chip instead.
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      const r = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
      if (/Intel|AMD|Radeon|NVIDIA/i.test(r)) return false;
    } catch {}
    return true;
  }
  let mine = null;
  if (/Windows/.test(ua)) {
    mine = FILES.win;
    main.textContent = 'Download for Windows';
    alt.textContent = 'Mac downloads';
  } else if (/Macintosh|Mac OS X/.test(ua) && !/iPhone|iPad/.test(ua) && navigator.maxTouchPoints < 2) {
    const arm = appleSilicon();
    mine = arm ? FILES.arm : FILES.intel;
    main.textContent = 'Download for Mac';
    alt.href = base + (arm ? FILES.intel : FILES.arm);
    alt.textContent = arm ? 'Intel Mac?' : 'Apple silicon Mac?';
  } else {
    main.href = '#download';
    main.textContent = 'Get it for Mac or Windows';
    alt.href = 'https://github.com/tamoghnakabi-wq/echoreel';
    alt.textContent = 'See the source';
  }
  if (mine) {
    main.href = base + mine;
    document.querySelector(`.bigkey[data-file="${mine}"]`)?.classList.add('mine');
  }
  fetch('https://api.github.com/repos/tamoghnakabi-wq/echoreel/releases/latest')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j?.tag_name) document.getElementById('ver').textContent = `Latest version ${j.tag_name.replace(/^v/, '')}.`;
    })
    .catch(() => {});

  // ---------- routing panel ----------
  const routes = { youtube: { instagram: true, tiktok: true }, instagram: { youtube: true, tiktok: true }, tiktok: { youtube: true, instagram: true } };
  const tbody = document.querySelector('#panel tbody');
  const readout = document.getElementById('readout');
  function drawPanel() {
    tbody.innerHTML = P.map(
      (from) =>
        `<tr><td class="src">${pf(from)}${NAMES[from]}</td>${P.map((to) =>
          from === to
            ? '<td><div class="blank"></div></td>'
            : `<td><button class="xpt" type="button" data-from="${from}" data-to="${to}" aria-pressed="${routes[from][to]}" aria-label="Post ${NAMES[from]} videos to ${NAMES[to]}">${routes[from][to] ? `${CHECK}On` : 'Off'}</button></td>`,
        ).join('')}</tr>`,
    ).join('');
    readout.innerHTML = P.map((from) => {
      const to = P.filter((t) => t !== from && routes[from][t]).map((t) => NAMES[t]);
      return `<div>${pf(from, true)}<span>New ${NAMES[from]} videos ${to.length ? `go to <b>${list(to)}</b>.` : `<b>stay on ${NAMES[from]}</b>.`}</span></div>`;
    }).join('');
  }
  tbody.addEventListener('click', (e) => {
    const b = e.target.closest('.xpt');
    if (!b) return;
    routes[b.dataset.from][b.dataset.to] = !routes[b.dataset.from][b.dataset.to];
    drawPanel();
    tbody.querySelector(`.xpt[data-from="${b.dataset.from}"][data-to="${b.dataset.to}"]`)?.focus();
  });
  drawPanel();

  // ---------- the monitor wall ----------
  // Three made-up videos, drawn live, one for each platform's turn.
  function fractal(c, w, h, t) {
    const g = c.createRadialGradient(w / 2, h * 0.44, 0, w / 2, h * 0.44, h * 0.75);
    g.addColorStop(0, '#2c1458');
    g.addColorStop(1, '#06040e');
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    c.save();
    c.translate(w / 2, h * 0.44);
    const speed = 0.34;
    const z = (t * speed) % 1;
    const turn = Math.floor(t * speed);
    for (let j = 0; j < 24; j++) {
      const s = w * 1.7 * Math.pow(0.8, j - z);
      if (s < 1.5) break;
      const n = j + turn;
      c.save();
      c.rotate((j - z) * 0.26 + t * 0.08);
      c.strokeStyle = `hsl(${(250 + n * 23) % 360} 92% ${58 + (n % 2) * 10}%)`;
      c.lineWidth = Math.max(1, s * 0.035);
      c.strokeRect(-s / 2, -s / 2, s, s);
      c.restore();
    }
    c.restore();
  }
  function sunset(c, w, h, t) {
    const hz = h * 0.6;
    const sky = c.createLinearGradient(0, 0, 0, hz);
    sky.addColorStop(0, '#1b1440');
    sky.addColorStop(0.45, '#6a2c70');
    sky.addColorStop(0.8, '#f0544f');
    sky.addColorStop(1, '#fdb36b');
    c.fillStyle = sky;
    c.fillRect(0, 0, w, hz);
    const r = w * 0.24;
    const sy = hz - r * 0.35 + Math.sin(t * 0.45) * w * 0.05;
    const sun = c.createLinearGradient(0, sy - r, 0, sy + r);
    sun.addColorStop(0, '#fff1bf');
    sun.addColorStop(1, '#ff7a3a');
    c.fillStyle = sun;
    c.beginPath();
    c.arc(w / 2, sy, r, 0, Math.PI * 2);
    c.fill();
    const sea = c.createLinearGradient(0, hz, 0, h);
    sea.addColorStop(0, '#2c1a48');
    sea.addColorStop(1, '#08071a');
    c.fillStyle = sea;
    c.fillRect(0, hz, w, h - hz);
    for (let k = 0; k < 16; k++) {
      const y = hz + Math.pow(k + 1, 1.45) * h * 0.011;
      const bw = w * 0.46 * (1 - k / 17) * (0.75 + 0.25 * Math.sin(t * 2.1 + k));
      const x = w / 2 - bw / 2 + Math.sin(t * 1.3 + k * 0.7) * w * 0.035;
      c.fillStyle = `rgba(255, 176, 96, ${0.6 * (1 - k / 16)})`;
      c.fillRect(x, y, bw, Math.max(1, h * 0.006));
    }
    ['#1b1440', '#f0544f', '#fdb36b'].forEach((col, i) => {
      c.fillStyle = col;
      c.strokeStyle = 'rgba(255,255,255,.7)';
      c.lineWidth = Math.max(1, w * 0.008);
      c.beginPath();
      c.arc(w * 0.14 + i * w * 0.12, h * 0.075, w * 0.045, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    });
  }
  function render3am(c, w, h, t) {
    c.fillStyle = '#0b0e14';
    c.fillRect(0, 0, w, h);
    // A floor grid in perspective.
    c.strokeStyle = '#1c2533';
    c.lineWidth = Math.max(1, w * 0.004);
    const fy = h * 0.6;
    for (let i = -6; i <= 6; i++) {
      c.beginPath();
      c.moveTo(w / 2 + i * w * 0.05, fy);
      c.lineTo(w / 2 + i * w * 0.32, h);
      c.stroke();
    }
    for (let k = 0; k < 7; k++) {
      const y = fy + Math.pow(k / 6, 1.8) * (h - fy);
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(w, y);
      c.stroke();
    }
    // The model: a slowly turning cube.
    const V = [];
    for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) V.push([x, y, z]);
    const a = t * 0.7;
    const b = 0.5 + Math.sin(t * 0.4) * 0.2;
    const pts = V.map(([x, y, z]) => {
      const x1 = x * Math.cos(a) - z * Math.sin(a);
      const z1 = x * Math.sin(a) + z * Math.cos(a);
      const y1 = y * Math.cos(b) - z1 * Math.sin(b);
      const z2 = y * Math.sin(b) + z1 * Math.cos(b);
      const f = (w * 0.95) / (z2 + 4.2);
      return [w / 2 + x1 * f, h * 0.38 + y1 * f];
    });
    const E = [[0, 1], [0, 2], [0, 4], [1, 3], [1, 5], [2, 3], [2, 6], [3, 7], [4, 5], [4, 6], [5, 7], [6, 7]];
    c.strokeStyle = '#72c1ff';
    c.lineWidth = Math.max(1, w * 0.012);
    c.beginPath();
    for (const [i, j] of E) {
      c.moveTo(...pts[i]);
      c.lineTo(...pts[j]);
    }
    c.stroke();
    c.fillStyle = '#ffb224';
    for (const p of pts) {
      c.beginPath();
      c.arc(p[0], p[1], Math.max(1.5, w * 0.014), 0, Math.PI * 2);
      c.fill();
    }
    // The render bar fills up, then says done.
    const p = Math.min(1, (t % 7) / 4.5);
    const bx = w * 0.12;
    const by = h * 0.69;
    const bw = w * 0.76;
    c.fillStyle = 'rgba(255,255,255,.12)';
    c.fillRect(bx, by, bw, h * 0.012);
    c.fillStyle = p < 1 ? '#ffb224' : '#43d17f';
    c.fillRect(bx, by, bw * p, h * 0.012);
    c.font = `600 ${Math.round(w * 0.065)}px Saira, system-ui, sans-serif`;
    c.fillStyle = p < 1 ? 'rgba(255,255,255,.75)' : '#9de6bd';
    c.fillText(p < 1 ? `Rendering frame ${Math.floor(p * 240)} of 240` : 'Render finished', bx, by - h * 0.018);
  }
  const VIDEOS = [
    { draw: fractal, caption: 'Into the fractal: 60 seconds of infinite zoom' },
    { draw: sunset, caption: 'Sunset colour study. Which palette wins?' },
    { draw: render3am, caption: 'POV: your render finishes at 3am' },
  ];

  const wall = document.getElementById('wall');
  const says = document.getElementById('wall-says');
  const bus = wall.querySelector('.bus');
  const cable = wall.querySelector('.cable');
  const mons = [...wall.querySelectorAll('.mon')].map((el) => ({
    el,
    p: el.dataset.p,
    glass: el.querySelector('.glass'),
    canvas: el.querySelector('canvas'),
    ctx: el.querySelector('canvas').getContext('2d'),
    tally: el.querySelector('.tally span'),
    cap: el.querySelector('.cap span'),
    video: null,
    t0: 0,
  }));
  function size() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const m of mons) {
      const r = m.canvas.getBoundingClientRect();
      m.canvas.width = Math.max(1, Math.round(r.width * dpr));
      m.canvas.height = Math.max(1, Math.round(r.height * dpr));
    }
    // Run the cable between the centres of the outer screens.
    const b = bus.getBoundingClientRect();
    const xs = mons.map((m) => {
      const r = m.glass.getBoundingClientRect();
      return r.left + r.width / 2 - b.left;
    });
    cable.style.left = `${xs[0]}px`;
    cable.style.right = `${b.width - xs[2]}px`;
    return xs;
  }
  let centres = size();
  addEventListener('resize', () => {
    centres = size();
    if (still) paint(performance.now());
  });

  function show(m, video, t0, state, label) {
    if (video != null) {
      m.video = video;
      m.t0 = t0;
      m.cap.textContent = VIDEOS[video].caption;
      m.glass.classList.add('has-video');
    }
    m.el.dataset.state = state;
    m.tally.textContent = label;
  }
  function paint(now) {
    for (const m of mons) {
      if (m.video == null) continue;
      VIDEOS[m.video].draw(m.ctx, m.canvas.width, m.canvas.height, still ? 2.2 : (now - m.t0) / 1000);
    }
  }
  function pulse(fromX, toX) {
    const d = document.createElement('div');
    d.className = 'pulse';
    bus.appendChild(d);
    const y = 17;
    d.animate(
      [
        { transform: `translate(${fromX}px, 0px)`, opacity: 0 },
        { transform: `translate(${fromX}px, ${y}px)`, opacity: 1, offset: 0.15 },
        { transform: `translate(${toX}px, ${y}px)`, opacity: 1, offset: 0.85 },
        { transform: `translate(${toX}px, 0px)`, opacity: 0 },
      ],
      { duration: 1000, easing: 'cubic-bezier(.45,0,.3,1)' },
    ).onfinish = () => d.remove();
  }

  for (const m of mons) show(m, null, 0, 'idle', 'Watching');
  if (still) {
    const t0 = performance.now();
    show(mons[0], 0, t0, 'source', 'Original');
    show(mons[1], 0, t0, 'posted', 'Posted');
    show(mons[2], 0, t0, 'posted', 'Posted');
    says.textContent = 'A new YouTube video, posted to Instagram and TikTok.';
    paint(t0);
    return;
  }

  // One turn per platform: it gets a new video, the signal runs down the cable, the others post it.
  let turn = 0;
  const timers = [];
  function cycle() {
    const i = turn++ % 3;
    const src = mons[i];
    const dests = mons.filter((m) => m !== src);
    const t0 = performance.now();
    show(src, i, t0, 'source', 'New upload');
    for (const m of dests) show(m, null, 0, 'idle', 'Watching');
    says.textContent = `You post a new video on ${NAMES[src.p]}.`;
    timers.push(
      setTimeout(() => {
        for (const m of dests) pulse(centres[i], centres[mons.indexOf(m)]);
        says.textContent = 'Echoreel copies it and fits it to each platform.';
      }, 1200),
      setTimeout(() => {
        for (const m of dests) show(m, i, t0, 'incoming', 'Posting');
      }, 2150),
      setTimeout(() => {
        for (const m of dests) show(m, null, 0, 'posted', 'Posted');
        src.tally.textContent = 'Original';
        says.textContent = `Posted to ${list(dests.map((m) => NAMES[m.p]))}.`;
      }, 3500),
      setTimeout(cycle, 6600),
    );
  }

  // Only animate while the wall is on screen and the tab is visible.
  let raf = 0;
  let running = false;
  const frame = (now) => {
    paint(now);
    raf = requestAnimationFrame(frame);
  };
  function start() {
    if (running) return;
    running = true;
    raf = requestAnimationFrame(frame);
    cycle();
  }
  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(raf);
    timers.splice(0).forEach(clearTimeout);
  }
  let visible = true;
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    visible && !document.hidden ? start() : stop();
  }).observe(wall);
  document.addEventListener('visibilitychange', () => (visible && !document.hidden ? start() : stop()));
})();
