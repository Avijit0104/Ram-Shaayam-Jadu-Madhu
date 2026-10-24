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
            <li>On your turn, pass one card to the next player.</li>
            <li>You can't pass the card you just received. You can pass it on a later turn.</li>
            <li>First to hold 4 cards of the same name wins the round.</li>
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
        <div class="topbar"><h2>RSJM</h2><button id="leave" class="ghost tiny">Leave</button></div>
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
    const myTurn = r.turnPlayerId === me;
    const order = r.order;
    const nextId = order[(order.indexOf(r.turnPlayerId) + 1) % order.length];
    const myNextId = order[(order.indexOf(me) + 1) % order.length];

    // Sort hand by card-name order so sets are easy to spot.
    const hand = r.yourHand.slice().sort((a, b) => nameIndex(a.name) - nameIndex(b.name) || a.id.localeCompare(b.id));
    if (!hand.some((c) => c.id === selectedCardId) || selectedCardId === r.lockedCardId) selectedCardId = null;

    let status;
    if (r.winner) status = `<div class="status">Round over</div>`;
    else if (myTurn) status = `<div class="status mine">Your turn: pick a card to pass to ${esc(playerName(myNextId))}</div>`;
    else status = `<div class="status">${esc(playerName(r.turnPlayerId))} is passing a card to ${esc(playerName(nextId))}…</div>`;

    let lastPass = '';
    if (r.lastPass) {
      const from = r.lastPass.from === me ? 'You' : esc(playerName(r.lastPass.from));
      const to = r.lastPass.to === me ? 'you' : esc(playerName(r.lastPass.to));
      lastPass = `${from} passed a card to ${to}`;
    } else {
      lastPass = `${r.starterId === me ? 'You start' : esc(playerName(r.starterId)) + ' starts'} this round`;
    }

    const seats = order.map((id, i) => {
      const p = player(id) || { name: '?', connected: false, score: 0, cardCount: 0 };
      const cls = ['seat'];
      if (id === r.turnPlayerId) cls.push('turn');
      if (id === me) cls.push('you');
      if (!p.connected) cls.push('offline');
      return `<div class="${cls.join(' ')}">
        <div class="seat-order">${i + 1}</div>
        <div class="seat-name">${esc(playerName(id))}</div>
        <div class="backs">${'<span class="back"></span>'.repeat(p.cardCount)}</div>
        <div class="seat-meta">★ ${p.score}${p.connected ? '' : ' · offline'}</div>
      </div>`;
    }).join('');

    const selected = hand.find((c) => c.id === selectedCardId);
    const passLabel = selected
      ? `Pass ${esc(selected.name)} to ${esc(playerName(myNextId))}`
      : 'Tap a card to select it';

    app.innerHTML = `
      <div class="topbar">
        <h2>RSJM</h2>
        <div class="row"><span class="muted small">Room ${esc(state.code)} · Round ${state.roundNumber}</span>
        ${isHost() ? '<button id="tolobby" class="ghost tiny">Lobby</button>' : ''}</div>
      </div>
      <div class="seats">${seats}</div>
      <div class="muted small center" style="margin-top:6px">Cards go 1 → 2 → 3 … → 1</div>
      ${status}
      <div class="lastpass">${lastPass}</div>
      <div class="hand-title"><h3>Your cards</h3><span class="muted small">${nameChips(r.names)}</span></div>
      <div class="hand">
        ${hand.map((c) => cardHtml(c, {
          button: true,
          selected: c.id === selectedCardId,
          locked: c.id === r.lockedCardId,
          disabled: !myTurn || c.id === r.lockedCardId || !!r.winner,
        })).join('')}
      </div>
      ${myTurn && !r.winner ? `<div class="actionbar"><div>
        <button id="pass" class="primary block" ${selected ? '' : 'disabled'}>${passLabel}</button>
      </div></div>` : ''}
      ${r.winner ? renderRoundOver() : ''}`;

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
    bindRoundOver();

    if (myTurn && !wasMyTurn && !r.winner && navigator.vibrate) navigator.vibrate(120);
    wasMyTurn = myTurn && !r.winner;
    requestWakeLock();
  }

  function renderRoundOver() {
    const r = state.round;
    const w = r.winner;
    const youWon = w.playerId === state.youId;
    const ranked = state.players.slice().sort((a, b) => b.score - a.score);
    return `
      <div class="overlay"><div class="panel stack">
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
    state = view;
    if (!view) homeNotice = notice || null;
    if (view && view.code && location.search) history.replaceState(null, '', location.pathname);
    // Only rebuild the home screen when arriving there, so typed text survives reconnects.
    if (screen === 'home' && lastScreen === 'home' && !notice) return;
    lastScreen = screen;
    render();
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
