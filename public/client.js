'use strict';

(function () {
  // ---- session token (secret, identifies this browser to the server) ----

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* private mode etc. */ }
  }

  function randomHex(bytes) {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  let token = storageGet('rsjm-token');
  if (!token || !/^[a-f0-9]{32,64}$/.test(token)) {
    token = randomHex(16);
    storageSet('rsjm-token', token);
  }

  const socket = io({ auth: { token } });

  // ---- local UI state ----

  let state = null; // last view from the server, null = home screen
  let homeNotice = null;
  let selectedCardId = null;
  let wasMyTurn = false;
  let busy = false;
  let wakeLock = null;
  let clockOffset = 0; // server clock minus ours, for turn countdowns
  let overlayShownForRound = 0; // round whose result popup has already animated in
  let lastTickSecond = null;

  const reducedMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const app = document.getElementById('app');
  const connBanner = document.getElementById('conn');
  const toastEl = document.getElementById('toast');
  const urlRoom = new URLSearchParams(location.search).get('room');

  // ---- helpers ----

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 2800);
  }

  function send(event, payload) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        toast('Not connected yet — try again in a moment');
        resolve(false);
        return;
      }
      socket.timeout(8000).emit(event, payload || {}, (err, res) => {
        if (err) { toast('Server did not respond'); resolve(false); return; }
        if (!res.ok) { toast(res.error); resolve(false); return; }
        resolve(true);
      });
    });
  }

  // ---- sounds (synthesised with Web Audio, no files to download) ----

  const sound = (() => {
    let ctx = null;
    let muted = storageGet('rsjm-muted') === '1';

    // Browsers only allow audio after a tap, so create/resume the context on any tap.
    function unlock() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!ctx) ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
    }
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);

    function tone(t, freq, dur, type, vol) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.05);
    }

    // A short burst of filtered noise sounds like a card sliding across a table.
    function swish(t, len) {
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.setValueAtTime(700, t);
      f.frequency.exponentialRampToValueAtTime(3200, t + len);
      const g = ctx.createGain();
      g.gain.value = 0.35;
      src.connect(f).connect(g).connect(ctx.destination);
      src.start(t);
    }

    const sounds = {
      pass: (t) => swish(t, 0.18),
      deal: (t) => { for (let i = 0; i < 5; i++) swish(t + i * 0.07, 0.06); },
      yourTurn: (t) => { tone(t, 660, 0.15, 'triangle', 0.2); tone(t + 0.12, 990, 0.25, 'triangle', 0.2); },
      tick: (t) => tone(t, 1250, 0.05, 'square', 0.05),
      timeout: (t) => tone(t, 220, 0.3, 'sawtooth', 0.08),
      alert: (t) => [880, 660, 880].forEach((f, i) => tone(t + i * 0.13, f, 0.12, 'square', 0.07)),
      win: (t) => [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.12, f, 0.35, 'triangle', 0.2)),
      lose: (t) => [392, 330, 262].forEach((f, i) => tone(t + i * 0.16, f, 0.3, 'sine', 0.15)),
    };

    return {
      play(name) {
        if (muted || !ctx || ctx.state !== 'running') return;
        try { sounds[name](ctx.currentTime + 0.01); } catch (e) { /* ignore audio errors */ }
      },
      toggle() {
        muted = !muted;
        storageSet('rsjm-muted', muted ? '1' : '0');
        if (!muted) { unlock(); this.play('yourTurn'); }
      },
      get muted() { return muted; },
    };
  })();

  function muteButton() {
    return `<button id="mute" class="ghost tiny" aria-label="${sound.muted ? 'Turn sound on' : 'Turn sound off'}">${sound.muted ? '🔇' : '🔊'}</button>`;
  }
  function bindMute() {
    const b = document.getElementById('mute');
    if (b) b.onclick = () => { sound.toggle(); render(); };
  }

  // ---- animations ----

  // A card back flies from one seat to another.
  function animatePass(fromId, toId) {
    if (reducedMotion) return;
    const a = app.querySelector(`[data-seat="${fromId}"]`);
    const b = app.querySelector(`[data-seat="${toId}"]`);
    if (!a || !b || !a.animate) return;
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const dx = (rb.left + rb.width / 2) - (ra.left + ra.width / 2);
    const dy = (rb.top + rb.height / 2) - (ra.top + ra.height / 2);
    const el = document.createElement('div');
    el.className = 'flying-card';
    el.style.left = `${ra.left + ra.width / 2}px`;
    el.style.top = `${ra.top + ra.height / 2}px`;
    document.body.appendChild(el);
    el.animate([
      { transform: 'translate(-50%, -50%) scale(0.7) rotate(0deg)', opacity: 0 },
      { transform: `translate(calc(-50% + ${dx / 2}px), calc(-50% + ${dy / 2 - 40}px)) scale(1.2) rotate(160deg)`, opacity: 1, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.8) rotate(360deg)`, opacity: 0.3 },
    ], { duration: 650, easing: 'ease-in-out' }).onfinish = () => el.remove();
    b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }],
      { duration: 300, delay: 600 });
  }

  function confetti() {
    if (reducedMotion || !document.body.animate) return;
    const colors = ['#ea8a0c', '#2f7de1', '#8b5cf6', '#16a34a', '#e11d48', '#fbbf24'];
    for (let i = 0; i < 70; i++) {
      const el = document.createElement('div');
      el.className = 'confetti';
      el.style.left = `${Math.random() * 100}vw`;
      el.style.background = colors[i % colors.length];
      document.body.appendChild(el);
      const drift = (Math.random() - 0.5) * 200;
      el.animate([
        { transform: 'translate(0, -20px) rotate(0deg)', opacity: 1 },
        { transform: `translate(${drift}px, 105vh) rotate(${Math.random() * 900}deg)`, opacity: 0.9 },
      ], { duration: 1800 + Math.random() * 1400, delay: Math.random() * 400, easing: 'cubic-bezier(.2,.6,.4,1)' })
        .onfinish = () => el.remove();
    }
  }

  // Sounds and animations for what changed between two views (runs after render).
  function effects(prev, next) {
    if (!next || !next.round || next.phase === 'lobby') return;
    const r = next.round;
    const me = next.youId;
    const sameRound = prev && prev.round && prev.roundNumber === next.roundNumber;

    if (!sameRound) {
      if (prev) { // a fresh deal, not a page load or reconnect
        sound.play('deal');
        if (r.turnPlayerId === me) setTimeout(() => sound.play('yourTurn'), 450);
      }
      return;
    }

    const pr = prev.round;

    const v = next.vote;
    if (v && (!prev.vote || prev.vote.id !== v.id)) {
      sound.play('alert');
      if (v.canVote && navigator.vibrate) navigator.vibrate([80, 60, 80]);
    }
    const result = next.voteResult;
    if (result && (!prev.voteResult || prev.voteResult.id !== result.id)) {
      if (result.passed) {
        sound.play('deal');
        toast('🔀 Vote passed! Everyone gets fresh cards.');
        app.querySelectorAll('.hand .card').forEach((c) => c.classList.add('arrive'));
      } else {
        toast('Vote failed. Playing on.');
      }
    }

    if (r.passCount > pr.passCount && r.lastPass) {
      animatePass(r.lastPass.from, r.lastPass.to);
      if (r.lastPass.auto && r.lastPass.from === me) {
        sound.play('timeout');
        toast("⏱ Time's up! A card was passed for you");
      } else if (r.lastPass.to === me && !r.winner) {
        sound.play('yourTurn');
      } else {
        sound.play('pass');
      }
      if (r.lastPass.to === me && r.lockedCardId) {
        const card = app.querySelector(`[data-card="${r.lockedCardId}"]`);
        if (card) card.classList.add('arrive');
      }
    }

    if (r.winner && !pr.winner) {
      const won = r.winner.playerId === me;
      setTimeout(() => {
        sound.play(won ? 'win' : 'lose');
        if (won) confetti();
      }, 650);
    }
  }

  // ---- turn countdown (updates in place, no re-render) ----

  function serverNow() {
    return Date.now() + clockOffset;
  }

  function updateTimer() {
    const v = state && state.vote;
    const voteBar = document.getElementById('vote-bar');
    if (v && voteBar) {
      const left = Math.max(0, v.endsAt - serverNow());
      voteBar.style.width = `${(left / Math.max(1, v.endsAt - v.startedAt)) * 100}%`;
      voteBar.classList.toggle('low', left <= 5000);
      const vs = document.getElementById('vote-secs');
      if (vs) vs.textContent = ` · ${Math.ceil(left / 1000)}s`;
    }

    const bar = document.getElementById('timer-bar');
    const secs = document.getElementById('timer-secs');
    const r = state && state.round;
    if (!bar || !r || !r.turnDueAt) return;
    const total = Math.max(1, r.turnDueAt - r.turnStartedAt);
    const left = Math.max(0, r.turnDueAt - serverNow());
    const s = Math.ceil(left / 1000);
    bar.style.width = `${(left / total) * 100}%`;
    bar.classList.toggle('low', left <= 10000);
    if (secs) secs.textContent = `${s}s`;
    if (r.turnPlayerId === state.youId && s <= 5 && s > 0 && s !== lastTickSecond) {
      lastTickSecond = s;
      sound.play('tick');
      if (s === 5 && navigator.vibrate) navigator.vibrate([60, 60, 60]);
    }
  }
  setInterval(updateTimer, 200);

  function player(id) {
    return state.players.find((p) => p.id === id);
  }
  function playerName(id) {
    const p = player(id);
    if (!p) return '?';
    return p.bot ? '🤖 ' + p.name : p.name;
  }
  function nameIndex(name) {
    const i = state.round.names.indexOf(name);
    return i < 0 ? 0 : i;
  }
  function isHost() {
    return state && state.hostId === state.youId;
  }

  function cardHtml(card, opts) {
    const o = opts || {};
    const i = nameIndex(card.name);
    const cls = ['card', 'n' + i];
    if (o.mini) cls.push('mini');
    if (o.selected) cls.push('selected');
    if (o.locked) cls.push('locked');
    const tag = o.button ? 'button' : 'div';
    const attrs = o.button
      ? ` type="button" data-card="${esc(card.id)}"${o.disabled ? ' disabled' : ''} aria-pressed="${o.selected ? 'true' : 'false'}"`
      : '';
    if (o.mini) return `<div class="${cls.join(' ')}"><span class="label">${esc(card.name)}</span></div>`;
    return `<${tag} class="${cls.join(' ')}"${attrs}>
      <span class="corner">${esc(card.name.charAt(0).toUpperCase())}</span>
      <span class="big">${esc(card.name.charAt(0).toUpperCase())}</span>
      <span class="label">${esc(card.name)}</span>
      ${o.locked ? '<span class="lock">🔒 Just received</span>' : ''}
    </${tag}>`;
  }

  function nameChips(names) {
    return names.map((n, i) => `<span class="chip n${i}">${esc(n)}</span>`).join(' ');
  }

  // Keep focus + typed text in inputs across re-renders.
  function preserveInputs(fn) {
    const active = document.activeElement;
    const keep = active && active.id && active.tagName === 'INPUT'
      ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd }
      : null;
    fn();
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) {
        el.value = keep.value;
        el.focus();
        try { el.setSelectionRange(keep.start, keep.end); } catch (e) { /* not a text input */ }
      }
    }
  }

  async function requestWakeLock() {
    if (wakeLock || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* not allowed, fine */ }
  }

  // ---- screens ----

  function renderHome() {
    const savedName = storageGet('rsjm-name') || '';
    app.innerHTML = `
      <div class="brand">
        <h1>RSJM</h1>
        <p>Ram · Shaayam · Jadu · Madhu</p>
        <div class="names">${nameChips(['Ram', 'Shaayam', 'Jadu', 'Madhu'])}</div>
      </div>
      <div class="stack">
        ${homeNotice ? `<div class="notice">${esc(homeNotice)}</div>` : ''}
        <div class="panel stack">
          <div>
            <label for="name">Your name</label>
            <input id="name" maxlength="16" autocomplete="nickname" placeholder="e.g. Avijit" value="${esc(savedName)}" />
          </div>
          <button id="create" class="primary block">Create a new room</button>
          <div class="divider">or join friends</div>
          <div class="row">
            <input id="code" class="code grow" maxlength="4" placeholder="CODE" autocapitalize="characters" autocomplete="off" value="${esc(urlRoom || '')}" />
            <button id="join">Join</button>
          </div>
        </div>
        <details class="panel rules">
          <summary>How to play</summary>
          <ol>
            <li>1 to 6 players. If fewer than 4 people join, bots fill the empty seats.</li>
            <li>Each player gets 4 cards. There are 4 cards of each name: Ram, Shaayam, Jadu, Madhu (the host adds one more name for each player beyond 4).</li>
            <li>You only see your own cards.</li>
            <li>On your turn, pass one card to the next player. You have 30 seconds, or a card is passed for you.</li>
            <li>You can't pass the card you just received. You can pass it on a later turn.</li>
            <li>First to hold 4 cards of the same name wins the round.</li>
            <li>Game stuck? After 15 passes anyone can ask to reshuffle all cards; everyone must agree.</li>
            <li>If someone keeps blocking (holding one of each name and passing on what they get), a vote starts automatically. Majority wins, and the blocker can't vote.</li>
            <li>Joined late? Watch the round, then take a bot's seat in the next one.</li>
          </ol>
        </details>
      </div>`;

    const nameEl = document.getElementById('name');
    const codeEl = document.getElementById('code');
    const getName = () => {
      const n = nameEl.value.trim();
      if (!n) { toast('Enter your name first'); nameEl.focus(); return null; }
      storageSet('rsjm-name', n);
      return n;
    };
    document.getElementById('create').onclick = async () => {
      const name = getName();
      if (!name || busy) return;
      busy = true;
      await send('room:create', { name });
      busy = false;
    };
    const join = async () => {
      const name = getName();
      if (!name || busy) return;
      const code = codeEl.value.trim().toUpperCase();
      if (code.length !== 4) { toast('Enter the 4-letter room code'); codeEl.focus(); return; }
      busy = true;
      await send('room:join', { code, name });
      busy = false;
    };
    document.getElementById('join').onclick = join;
    codeEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  }

  let extraNamesTimer = null;

  function renderLobby() {
    const n = state.players.length;
    const needed = state.neededExtraNames;
    const host = isHost();
    const names = state.baseNames;

    let extraInputs = '';
    for (let i = 0; i < needed; i++) {
      const v = state.extraNames[i] || '';
      extraInputs += `
        <div>
          <label for="extra${i}">Card name ${names.length + i + 1}</label>
          <input id="extra${i}" data-extra="${i}" maxlength="12" placeholder="${host ? 'Type a name…' : 'Host is choosing…'}" value="${esc(v)}" ${host ? '' : 'readonly'} />
        </div>`;
    }

    const bots = state.botsNeeded;
    const botWord = `${bots} bot${bots > 1 ? 's' : ''}`;
    let startHint = '';
    if (needed && state.extraNames.slice(0, needed).filter((x) => x).length < needed) {
      startHint = host ? `Choose ${needed} extra card name${needed > 1 ? 's' : ''} above` : 'Host is choosing extra card names…';
    }
    const startLabel = bots
      ? `Start with ${botWord}`
      : (state.roundNumber ? 'Start next game' : 'Start game');

    app.innerHTML = `
      <div class="stack">
        <div class="topbar"><h2>RSJM</h2><div class="row">${muteButton()}<button id="leave" class="ghost tiny">Leave</button></div></div>
        ${state.notice ? `<div class="notice">${esc(state.notice)}</div>` : ''}
        <div class="panel center stack">
          <div class="muted small">Room code</div>
          <div class="room-code">${esc(state.code)}</div>
          <button id="share" class="block">Share invite link</button>
        </div>
        <div class="panel">
          <div class="row" style="justify-content:space-between;margin-bottom:6px">
            <h3>Players</h3><span class="muted small">${n} / ${state.maxPlayers}</span>
          </div>
          <ul class="player-list">
            ${state.players.map((p) => `
              <li>
                <span class="dot ${p.connected ? '' : 'off'}" title="${p.connected ? 'online' : 'offline'}"></span>
                <span class="name">${esc(p.name)}${p.id === state.youId ? ' <span class="muted">(you)</span>' : ''}</span>
                ${p.id === state.hostId ? '<span class="tag host">host</span>' : ''}
                ${state.roundNumber ? `<span class="tag">★ ${p.score}</span>` : ''}
                ${host && p.id !== state.youId ? `<button class="danger tiny" data-kick="${esc(p.id)}">Remove</button>` : ''}
              </li>`).join('')}
          </ul>
          ${bots ? `<p class="muted small" style="margin:10px 0 0">🤖 ${botWord} will fill the empty seat${bots > 1 ? 's' : ''}. Wait for friends or start now.</p>` : ''}
        </div>
        <div class="panel stack">
          <h3>Cards in play</h3>
          <div>${nameChips(names)}</div>
          ${needed ? `<p class="muted small" style="margin:0">${n} players, so ${needed} more name${needed > 1 ? 's are' : ' is'} needed. 4 cards of each name are added.</p>${extraInputs}` : `<p class="muted small" style="margin:0">With 5 or 6 players, the host adds a new card name for each extra player.</p>`}
        </div>
      </div>
      <div class="actionbar"><div>
        ${host
          ? `<button id="start" class="primary block" ${startHint ? 'disabled' : ''}>${startLabel}</button>`
          : `<div class="status">Waiting for the host to start…</div>`}
        ${startHint ? `<div class="center muted small" style="margin-top:6px">${esc(startHint)}</div>` : ''}
      </div></div>`;

    document.getElementById('leave').onclick = () => send('room:leave');
    document.getElementById('share').onclick = shareInvite;
    bindMute();
    const startBtn = document.getElementById('start');
    if (startBtn) startBtn.onclick = () => send('game:start');

    app.querySelectorAll('[data-kick]').forEach((b) => {
      b.onclick = () => send('room:kick', { playerId: b.dataset.kick });
    });

    if (host) {
      app.querySelectorAll('[data-extra]').forEach((input) => {
        input.addEventListener('input', () => {
          clearTimeout(extraNamesTimer);
          extraNamesTimer = setTimeout(() => {
            const vals = state.extraNames.slice();
            app.querySelectorAll('[data-extra]').forEach((el) => { vals[Number(el.dataset.extra)] = el.value; });
            send('room:extraNames', { names: vals });
          }, 350);
        });
      });
    }
  }

  async function shareInvite() {
    const url = `${location.origin}/?room=${state.code}`;
    const text = `Join my RSJM game! Room code: ${state.code}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'RSJM', text, url }); return; } catch (e) { /* cancelled */ return; }
    }
    try {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      toast('Invite link copied');
    } catch (e) {
      toast(url);
    }
  }

  function renderGame() {
    const r = state.round;
    const me = state.youId;
    const watching = state.spectating;
    const myTurn = r.turnPlayerId === me;
    const order = r.order;
    const after = (id) => order[(order.indexOf(id) + 1) % order.length];
    const myNextId = after(me);

    // Sort hand by card-name order so sets are easy to spot.
    const hand = r.yourHand.slice().sort((a, b) => nameIndex(a.name) - nameIndex(b.name) || a.id.localeCompare(b.id));
    if (!hand.some((c) => c.id === selectedCardId) || selectedCardId === r.lockedCardId) selectedCardId = null;

    // Countdown for people's turns; bots move within a couple of seconds.
    const turnPlayer = r.turnPlayerId ? player(r.turnPlayerId) : null;
    const showTimer = !!(turnPlayer && !turnPlayer.bot && r.turnDueAt);
    const secs = showTimer ? ' <span id="timer-secs" class="secs"></span>' : '';
    const timer = showTimer ? '<div class="timer"><div id="timer-bar" class="timer-bar"></div></div>' : '';

    let status;
    if (r.winner) status = '<div class="status">Round over</div>';
    else if (myTurn) status = `<div class="status mine">Your turn: pass a card to ${esc(playerName(myNextId))}${secs}${timer}</div>`;
    else if (showTimer && !turnPlayer.connected) {
      status = `<div class="status">${esc(playerName(r.turnPlayerId))} is offline. Passing for them in${secs}${timer}</div>`;
    } else {
      status = `<div class="status">${esc(playerName(r.turnPlayerId))} is passing a card to ${esc(playerName(after(r.turnPlayerId)))}…${secs}${timer}</div>`;
    }

    let lastPass = '';
    if (r.lastPass) {
      const from = r.lastPass.from === me ? 'You' : esc(playerName(r.lastPass.from));
      const to = r.lastPass.to === me ? 'you' : esc(playerName(r.lastPass.to));
      lastPass = r.lastPass.auto
        ? `⏱ Time's up for ${r.lastPass.from === me ? 'you' : from}. A card was passed to ${to}.`
        : `${from} passed a card to ${to}`;
    } else if (r.reshuffles) {
      lastPass = `🔀 Cards were reshuffled. ${r.turnPlayerId === me ? 'You go' : esc(playerName(r.turnPlayerId)) + ' goes'} first.`;
    } else {
      lastPass = `${r.starterId === me ? 'You start' : esc(playerName(r.starterId)) + ' starts'} this round`;
    }

    // Reshuffle vote: a banner while one runs, otherwise a button once it's allowed.
    let voteHtml = '';
    const v = state.vote;
    if (v && !r.winner) {
      const title = v.kind === 'blocking'
        ? '🧱 Someone is blocking the game'
        : `🔀 ${v.startedBy === me ? 'You asked' : esc(playerName(v.startedBy)) + ' wants'} to reshuffle`;
      const rule = v.kind === 'blocking' ? 'Reshuffle all cards? Majority wins.' : 'Reshuffle all cards? Everyone must agree.';
      let action;
      if (v.canVote) {
        action = `<div class="row">
          <button id="vote-yes" class="primary grow">✅ Yes</button>
          <button id="vote-no" class="grow">❌ No</button>
        </div>`;
      } else if (v.yourVote !== null) {
        action = `<div class="muted small">You voted ${v.yourVote ? 'Yes' : 'No'}</div>`;
      } else {
        action = `<div class="muted small">${watching ? "Watchers don't vote." : "You can't vote on this one."}</div>`;
      }
      voteHtml = `<div class="panel vote stack">
        <div class="vote-title">${title}</div>
        <div class="muted small">${rule} ✅ ${v.yes} · ❌ ${v.no} of ${v.total}<span id="vote-secs" class="secs"></span></div>
        <div class="timer"><div id="vote-bar" class="timer-bar"></div></div>
        ${action}
      </div>`;
    } else if (state.canRequestVote && !r.winner) {
      voteHtml = '<button id="vote-start" class="ghost tiny block vote-start">🔀 Game stuck? Vote to reshuffle</button>';
    }

    const seats = order.map((id, i) => {
      const p = player(id) || { name: '?', connected: false, score: 0, cardCount: 0 };
      const cls = ['seat'];
      if (id === r.turnPlayerId) cls.push('turn');
      if (id === me) cls.push('you');
      if (!p.connected) cls.push('offline');
      return `<div class="${cls.join(' ')}" data-seat="${esc(id)}">
        <div class="seat-order">${i + 1}</div>
        <div class="seat-name">${esc(playerName(id))}</div>
        <div class="backs">${'<span class="back"></span>'.repeat(p.cardCount)}</div>
        <div class="seat-meta">★ ${p.score}${p.connected ? '' : ' · offline'}</div>
      </div>`;
    }).join('');

    const watchers = state.players.filter((p) => p.spectator);
    const watchersLine = watchers.length
      ? `<div class="muted small center watchers">👀 Watching: ${watchers.map((p) => esc(p.name) + (p.id === me ? ' (you)' : '')).join(', ')}</div>`
      : '';

    const selected = hand.find((c) => c.id === selectedCardId);
    const passLabel = selected
      ? `Pass ${esc(selected.name)} to ${esc(playerName(myNextId))}`
      : 'Tap a card to select it';

    const handSection = watching
      ? `<div class="panel center stack watching">
          <div class="watching-icon">👀</div>
          <div><b>You're watching this round</b></div>
          <div class="muted small">${state.seatNextRound
            ? "You'll take a bot's seat when the next round starts."
            : "All seats are taken. You'll get one when the host goes back to the lobby."}</div>
        </div>`
      : `<div class="hand-title"><h3>Your cards</h3><span class="muted small">${nameChips(r.names)}</span></div>
        <div class="hand">
          ${hand.map((c) => cardHtml(c, {
            button: true,
            selected: c.id === selectedCardId,
            locked: c.id === r.lockedCardId,
            disabled: !myTurn || c.id === r.lockedCardId || !!r.winner,
          })).join('')}
        </div>`;

    // The result popup fades in once, after the last card has landed.
    const overlayEnter = !!r.winner && overlayShownForRound !== state.roundNumber;
    if (r.winner) overlayShownForRound = state.roundNumber;

    app.innerHTML = `
      <div class="topbar">
        <h2>RSJM</h2>
        <div class="row"><span class="muted small">Room ${esc(state.code)} · Round ${state.roundNumber}</span>
        ${muteButton()}
        ${isHost() ? '<button id="tolobby" class="ghost tiny">Lobby</button>' : ''}</div>
      </div>
      <div class="seats">${seats}</div>
      <div class="muted small center" style="margin-top:6px">Cards go 1 → 2 → 3 … → 1</div>
      ${watchersLine}
      ${status}
      <div class="lastpass">${lastPass}</div>
      ${voteHtml}
      ${handSection}
      ${myTurn && !r.winner ? `<div class="actionbar"><div>
        <button id="pass" class="primary block" ${selected ? '' : 'disabled'}>${passLabel}</button>
      </div></div>` : ''}
      ${r.winner ? renderRoundOver(overlayEnter) : ''}`;

    app.querySelectorAll('[data-card]').forEach((b) => {
      b.onclick = () => {
        selectedCardId = selectedCardId === b.dataset.card ? null : b.dataset.card;
        render();
      };
    });
    const passBtn = document.getElementById('pass');
    if (passBtn) {
      passBtn.onclick = async () => {
        if (!selectedCardId || busy) return;
        busy = true;
        passBtn.disabled = true;
        const ok = await send('game:pass', { cardId: selectedCardId });
        busy = false;
        if (ok) selectedCardId = null;
        render();
      };
    }
    const lobbyBtn = document.getElementById('tolobby');
    if (lobbyBtn) lobbyBtn.onclick = () => send('game:toLobby');
    const voteStart = document.getElementById('vote-start');
    if (voteStart) voteStart.onclick = () => send('vote:start');
    const voteYes = document.getElementById('vote-yes');
    if (voteYes) voteYes.onclick = () => send('vote:cast', { yes: true });
    const voteNo = document.getElementById('vote-no');
    if (voteNo) voteNo.onclick = () => send('vote:cast', { yes: false });
    bindMute();
    bindRoundOver();
    updateTimer();

    if (myTurn && !wasMyTurn && !r.winner && navigator.vibrate) navigator.vibrate(120);
    wasMyTurn = myTurn && !r.winner;
    requestWakeLock();
  }

  function renderRoundOver(enter) {
    const r = state.round;
    const w = r.winner;
    const youWon = w.playerId === state.youId;
    const ranked = state.players.filter((p) => !p.spectator).sort((a, b) => b.score - a.score);
    return `
      <div class="overlay${enter ? ' enter' : ''}"><div class="panel stack">
        <div class="win-title">${youWon ? '🎉 <span class="who">You win!</span>' : `🎉 <span class="who">${esc(playerName(w.playerId))}</span> wins!`}</div>
        <div class="center muted">4 × <span class="chip n${nameIndex(w.name)}">${esc(w.name)}</span></div>
        <div class="reveal">
          ${r.order.map((id) => `
            <div class="reveal-row ${id === w.playerId ? 'winner' : ''}">
              <div class="who">${esc(playerName(id))}${id === state.youId ? ' (you)' : ''}</div>
              <div class="reveal-cards">
                ${(r.revealedHands[id] || []).slice().sort((a, b) => nameIndex(a.name) - nameIndex(b.name))
                  .map((c) => cardHtml(c, { mini: true })).join('')}
              </div>
            </div>`).join('')}
        </div>
        <table class="scores">
          ${ranked.map((p) => `<tr><td>${esc(playerName(p.id))}</td><td>★ ${p.score}</td></tr>`).join('')}
        </table>
        ${state.spectating && state.seatNextRound ? `<div class="notice">You'll take a bot's seat in the next round.</div>` : ''}
        ${isHost()
          ? `<button id="next" class="primary block">Next round</button>
             <button id="lobby2" class="ghost block">Back to lobby</button>`
          : '<div class="center muted">Waiting for the host to start the next round…</div>'}
      </div></div>`;
  }

  function bindRoundOver() {
    const next = document.getElementById('next');
    if (next) next.onclick = () => send('game:nextRound');
    const lobby = document.getElementById('lobby2');
    if (lobby) lobby.onclick = () => send('game:toLobby');
  }

  function render() {
    preserveInputs(() => {
      if (!state) renderHome();
      else if (state.phase === 'lobby') renderLobby();
      else renderGame();
    });
    if (!state || state.phase === 'lobby') wasMyTurn = false;
  }

  // ---- socket events ----

  let lastScreen = 'home'; // the initial render() below draws home
  socket.on('state', (view, notice) => {
    const screen = view ? (view.phase === 'lobby' ? 'lobby' : 'game:' + view.roundNumber) : 'home';
    const prev = state;
    state = view;
    if (view) clockOffset = view.serverNow - Date.now();
    const prevDue = prev && prev.round && prev.round.turnDueAt;
    if (!view || !view.round || view.round.turnDueAt !== prevDue) lastTickSecond = null;
    if (prev && prev.round && view && view.round && view.round.reshuffles !== prev.round.reshuffles) {
      selectedCardId = null; // a fresh hand
    }
    if (!view) homeNotice = notice || null;
    if (view && view.code && location.search) history.replaceState(null, '', location.pathname);
    // Only rebuild the home screen when arriving there, so typed text survives reconnects.
    if (screen === 'home' && lastScreen === 'home' && !notice) return;
    lastScreen = screen;
    render();
    effects(prev, view);
  });

  socket.on('connect', () => connBanner.classList.add('hidden'));
  socket.on('disconnect', () => connBanner.classList.remove('hidden'));
  socket.on('connect_error', () => connBanner.classList.remove('hidden'));
  socket.on('fatal', (msg) => toast(msg));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (!socket.connected) socket.connect();
      if (state && state.phase !== 'lobby') requestWakeLock();
    }
  });

  render();
})();
