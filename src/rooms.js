'use strict';

// In-memory room store: lobby management, round lifecycle and per-player views.
// Players are identified by a secret `token` (kept in the browser's localStorage,
// sent on the socket handshake) and a public `id` that is safe to show to others.
// Bots (`bot: true`, `token: null`) exist only while a game runs: they are added on
// start to fill seats up to MIN_PLAYERS and removed when the room returns to the lobby.
// People who join mid-game are spectators (`spectator: true`) until a bot seat frees
// up at the next round, or until the room returns to the lobby.

const crypto = require('crypto');
const {
  BASE_NAMES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  GameError,
  dealRound,
  currentPlayerId,
  passCard,
  reshuffle,
} = require('./game');
const { BOT_NAMES, chooseBotCard } = require('./bots');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
const MAX_PLAYER_NAME = 16;
const MAX_CARD_NAME = 12;
const MAX_EXTRA_NAMES = MAX_PLAYERS - BASE_NAMES.length;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;

// Turn timing. Every turn has a deadline; when it passes, the server plays a card
// for that seat (see pendingTurn / autoPass).
const TURN_MS = 30 * 1000; // a human's time to pick a card
const OFFLINE_GRACE_MS = 10 * 1000; // how long to wait for an offline player to come back
const BOT_MIN_MS = 1200; // bots pause so people can follow the cards
const BOT_JITTER_MS = 800;

// Reshuffle votes. Anyone seated can ask after MIN_PASSES_FOR_VOTE passes (everyone
// must agree). A player who blocks for BLOCK_STREAK turns in a row triggers a vote
// automatically (majority, and the blocker can't vote).
const MIN_PASSES_FOR_VOTE = 60;
const BLOCK_STREAK = 4;
const VOTE_MS = 20 * 1000;
const VOTE_COOLDOWN_PASSES = 8; // after a failed vote

function cleanName(raw, max, label) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) throw new GameError(`${label} can't be empty`);
  if (name.length > max) throw new GameError(`${label} must be at most ${max} characters`);
  return name;
}

class RoomStore {
  constructor({ rng = Math.random, now = Date.now } = {}) {
    this.rng = rng;
    this.now = now;
    this.rooms = new Map(); // code -> room
    this.tokens = new Map(); // token -> code
  }

  // ---- lookup -------------------------------------------------------------

  roomForToken(token) {
    const code = this.tokens.get(token);
    return code ? this.rooms.get(code) || null : null;
  }

  playerForToken(room, token) {
    return (token && room.players.find((p) => p.token === token)) || null;
  }

  requireMembership(token) {
    const room = this.roomForToken(token);
    const player = room && this.playerForToken(room, token);
    if (!player) throw new GameError("You're not in a room");
    return { room, player };
  }

  requireHost(token) {
    const ctx = this.requireMembership(token);
    if (ctx.room.hostId !== ctx.player.id) throw new GameError('Only the host can do that');
    return ctx;
  }

  touch(room) {
    room.lastActivity = this.now();
  }

  newCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < 4; i++) code += CODE_ALPHABET[Math.floor(this.rng() * CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }

  newPlayer(token, name, bot = false) {
    return {
      id: crypto.randomBytes(6).toString('hex'),
      token,
      name,
      bot,
      spectator: false,
      connected: true,
      offlineSince: null,
      score: 0,
    };
  }

  // Real people, seated or watching.
  humans(room) {
    return room.players.filter((p) => !p.bot);
  }

  // Everyone who holds cards (or will, at the next deal).
  seated(room) {
    return room.players.filter((p) => !p.spectator);
  }

  botsNeeded(room) {
    return Math.max(0, MIN_PLAYERS - this.humans(room).length);
  }

  addBots(room) {
    const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
    const free = BOT_NAMES.filter((n) => !taken.has(n.toLowerCase()));
    for (let i = this.botsNeeded(room); i > 0; i--) {
      room.players.push(this.newPlayer(null, free.shift() || `Bot ${i}`, true));
    }
  }

  // Spectators take over bot seats in place, so the seating order stays the same.
  seatSpectators(room) {
    for (const s of room.players.filter((p) => p.spectator)) {
      if (!room.players.some((p) => p.bot)) break;
      room.players = room.players.filter((p) => p !== s);
      const botIndex = room.players.findIndex((p) => p.bot);
      s.spectator = false;
      room.players[botIndex] = s;
    }
  }

  returnToLobby(room) {
    room.phase = 'lobby';
    room.round = null;
    room.vote = null;
    room.players = this.humans(room);
    for (const p of room.players) p.spectator = false;
  }

  currentPlayer(room) {
    return room.players.find((p) => p.id === currentPlayerId(room.round)) || null;
  }

  // ---- lobby --------------------------------------------------------------

  createRoom(token, rawName) {
    const name = cleanName(rawName, MAX_PLAYER_NAME, 'Name');
    this.leave(token);
    const player = this.newPlayer(token, name);
    const room = {
      code: this.newCode(),
      hostId: player.id,
      players: [player],
      extraNames: [],
      phase: 'lobby', // lobby | playing | roundOver
      round: null,
      roundNumber: 0,
      nextStarterIndex: 0,
      vote: null, // the reshuffle vote in progress, if any
      voteSeq: 0,
      voteResult: null, // { id, kind, passed } of the last finished vote
      notice: null,
      lastActivity: this.now(),
    };
    this.rooms.set(room.code, room);
    this.tokens.set(token, room.code);
    return room;
  }

  // In the lobby you get a seat; once a game is running you watch until a seat frees up.
  joinRoom(token, rawCode, rawName) {
    const code = String(rawCode ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('Room not found. Check the code.');

    const existing = this.playerForToken(room, token);
    if (existing) {
      existing.connected = true;
      existing.offlineSince = null;
      this.touch(room);
      return room;
    }

    const name = cleanName(rawName, MAX_PLAYER_NAME, 'Name');
    if (this.humans(room).length >= MAX_PLAYERS) throw new GameError(`Room is full (max ${MAX_PLAYERS})`);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('Someone in the room already has that name');
    }

    this.leave(token);
    const player = this.newPlayer(token, name);
    player.spectator = room.phase !== 'lobby';
    room.players.push(player);
    if (room.phase === 'lobby') room.notice = null;
    this.tokens.set(token, room.code);
    this.touch(room);
    return room;
  }

  // Removes the player. Returns the room (or null if it was deleted / not found).
  leave(token) {
    const room = this.roomForToken(token);
    this.tokens.delete(token);
    if (!room) return null;
    const player = this.playerForToken(room, token);
    if (!player) return room;
    return this.removePlayer(room, player, `${player.name} left`);
  }

  kick(token, playerId) {
    const { room, player: host } = this.requireHost(token);
    if (room.phase !== 'lobby') throw new GameError('You can only remove players in the lobby');
    const target = room.players.find((p) => p.id === playerId);
    if (!target) throw new GameError('Player not found');
    if (target.id === host.id) throw new GameError("You can't remove yourself");
    this.tokens.delete(target.token);
    this.removePlayer(room, target, `${target.name} was removed`);
    return { room, kickedToken: target.token };
  }

  removePlayer(room, player, notice) {
    const heldCards = room.phase !== 'lobby' && room.round && room.round.order.includes(player.id);
    room.players = room.players.filter((p) => p !== player);
    const humans = this.humans(room);
    if (humans.length === 0) {
      this.rooms.delete(room.code);
      return null;
    }
    if (room.hostId === player.id) room.hostId = (humans.find((p) => !p.spectator) || humans[0]).id;
    if (heldCards) {
      // A round can't continue with a missing hand. Spectators leaving don't matter.
      this.returnToLobby(room);
      notice += ' — back to the lobby';
    }
    room.notice = notice;
    this.touch(room);
    return room;
  }

  setExtraNames(token, names) {
    const { room } = this.requireHost(token);
    if (room.phase !== 'lobby') throw new GameError('Card names can only be changed in the lobby');
    if (!Array.isArray(names)) throw new GameError('Invalid card names');
    room.extraNames = names
      .slice(0, MAX_EXTRA_NAMES)
      .map((n) => String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CARD_NAME));
    this.touch(room);
    return room;
  }

  // Base names plus as many host-chosen names as there are players beyond 4.
  // Called before bots are added, so bots never require extra names.
  cardNamesFor(room) {
    const needed = room.players.length - BASE_NAMES.length;
    const extras = room.extraNames.slice(0, Math.max(0, needed));
    const names = [...BASE_NAMES];
    for (let i = 0; i < needed; i++) {
      const name = extras[i] ? cleanName(extras[i], MAX_CARD_NAME, 'Card name') : '';
      if (!name) {
        throw new GameError(`Host needs to choose ${needed} extra card name${needed > 1 ? 's' : ''}`);
      }
      if (names.some((n) => n.toLowerCase() === name.toLowerCase())) {
        throw new GameError(`Card name "${name}" is already used`);
      }
      names.push(name);
    }
    return names;
  }

  // ---- rounds -------------------------------------------------------------

  startGame(token) {
    const { room } = this.requireHost(token);
    if (room.phase !== 'lobby') throw new GameError('Game already running');
    if (room.players.length > MAX_PLAYERS) throw new GameError(`At most ${MAX_PLAYERS} players`);
    const names = this.cardNamesFor(room);
    this.addBots(room);
    this.deal(room, names);
    return room;
  }

  nextRound(token) {
    const { room } = this.requireHost(token);
    if (room.phase !== 'roundOver') throw new GameError('The round is still going');
    this.seatSpectators(room);
    this.deal(room, room.round.names);
    return room;
  }

  toLobby(token) {
    const { room } = this.requireHost(token);
    this.returnToLobby(room);
    room.notice = null;
    this.touch(room);
    return room;
  }

  deal(room, names) {
    const order = this.seated(room).map((p) => p.id);
    const starter = room.nextStarterIndex % order.length;
    room.round = dealRound(order, names, starter, this.rng);
    room.nextStarterIndex = (starter + 1) % order.length;
    room.roundNumber++;
    room.phase = 'playing';
    room.notice = null;
    room.vote = null;
    this.startTurn(room);
    this.touch(room);
  }

  pass(token, cardId) {
    const { room, player } = this.requireMembership(token);
    if (room.phase !== 'playing') throw new GameError('No round in progress');
    this.applyPass(room, player.id, cardId, false);
    return room;
  }

  applyPass(room, playerId, cardId, timedOut) {
    passCard(room.round, playerId, cardId);
    if (timedOut) room.round.lastPass.auto = true;
    if (room.round.winner) {
      const winner = room.players.find((p) => p.id === room.round.winner.playerId);
      if (winner) winner.score++;
      room.phase = 'roundOver';
      room.vote = null;
    } else {
      this.startTurn(room);
      const r = room.round;
      if (!room.vote && r.blockStreak[playerId] >= BLOCK_STREAK && r.passesSinceDeal >= this.voteAllowedAt(r)) {
        this.startVote(room, 'blocking', { blockerId: playerId });
      }
    }
    this.touch(room);
  }

  // ---- reshuffle votes ----------------------------------------------------

  voteAllowedAt(round) {
    return Math.max(MIN_PASSES_FOR_VOTE, round.voteAllowedAt || 0);
  }

  // 'manual': someone asked; everyone seated votes and all must agree.
  // 'blocking': triggered by a blocker; everyone else votes and a majority wins.
  // Bots always vote yes; whoever asked for a manual vote has voted yes.
  startVote(room, kind, { startedBy = null, blockerId = null } = {}) {
    const eligible = this.seated(room).filter((p) => p.id !== blockerId);
    const now = this.now();
    room.vote = {
      id: ++room.voteSeq,
      kind,
      startedBy,
      blockerId,
      eligible: eligible.map((p) => p.id),
      votes: {}, // playerId -> true/false
      startedAt: now,
      endsAt: now + VOTE_MS,
    };
    for (const p of eligible) if (p.bot) room.vote.votes[p.id] = true;
    if (startedBy) room.vote.votes[startedBy] = true;
    this.settleVote(room, false);
  }

  requestReshuffle(token) {
    const { room, player } = this.requireMembership(token);
    if (room.phase !== 'playing') throw new GameError('No round in progress');
    if (player.spectator) throw new GameError("You're watching this round");
    if (room.vote) throw new GameError('A vote is already running');
    const at = this.voteAllowedAt(room.round);
    if (room.round.passesSinceDeal < at) {
      throw new GameError(`You can ask for a reshuffle after ${at} passes`);
    }
    this.startVote(room, 'manual', { startedBy: player.id });
    this.touch(room);
    return room;
  }

  castVote(token, yes) {
    const { room, player } = this.requireMembership(token);
    const v = room.vote;
    if (!v || room.phase !== 'playing') throw new GameError('No vote is running');
    if (!v.eligible.includes(player.id)) throw new GameError("You can't vote on this one");
    if (player.id in v.votes) throw new GameError('You already voted');
    v.votes[player.id] = !!yes;
    this.settleVote(room, false);
    this.touch(room);
    return room;
  }

  // Ends the vote if the result is decided. Missing votes only count once time is up:
  // then they're Yes for a blocking vote (so a stuck table can move on), and for a
  // manual vote only offline people count as Yes (everyone else must actually agree).
  settleVote(room, expired) {
    const v = room.vote;
    if (!v) return;
    let yes = 0;
    let no = 0;
    let pendingOnline = 0;
    let pendingOffline = 0;
    for (const id of v.eligible) {
      if (v.votes[id] === true) yes++;
      else if (v.votes[id] === false) no++;
      else if ((room.players.find((p) => p.id === id) || {}).connected) pendingOnline++;
      else pendingOffline++;
    }
    const total = v.eligible.length;
    const pending = pendingOnline + pendingOffline;
    let passed = null;
    if (v.kind === 'manual') {
      if (no > 0) passed = false;
      else if (pending === 0) passed = true;
      else if (expired) passed = pendingOnline === 0;
    } else if (yes * 2 > total) passed = true;
    else if ((yes + pending) * 2 <= total) passed = false;
    else if (expired) passed = true; // pending votes count as yes, and that's a majority

    if (passed === null) return;
    room.vote = null;
    room.voteResult = { id: v.id, kind: v.kind, passed };
    const r = room.round;
    if (passed) {
      reshuffle(r, this.rng);
      this.startTurn(room);
    } else {
      r.voteAllowedAt = r.passesSinceDeal + VOTE_COOLDOWN_PASSES;
      if (v.blockerId) r.blockStreak[v.blockerId] = 0;
    }
  }

  // A ticket for the running vote's deadline, or null.
  pendingVote(room) {
    if (!room || room.phase !== 'playing' || !room.vote) return null;
    return { code: room.code, voteId: room.vote.id, endsAt: room.vote.endsAt };
  }

  expireVote(ticket) {
    const room = this.rooms.get(ticket.code);
    if (!room || !room.vote || room.vote.id !== ticket.voteId) return null;
    if (this.now() < room.vote.endsAt) return null;
    this.settleVote(room, true);
    this.touch(room);
    return room;
  }

  // ---- turn timing --------------------------------------------------------

  startTurn(room) {
    const round = room.round;
    const current = this.currentPlayer(room);
    const now = this.now();
    round.turnStartedAt = now;
    round.turnDeadline = now + (current && current.bot ? BOT_MIN_MS + this.rng() * BOT_JITTER_MS : TURN_MS);
  }

  // When the current turn gets played automatically: bots after a short pause, people
  // when their time runs out, or sooner if they've been offline for OFFLINE_GRACE_MS.
  turnDueAt(room) {
    const round = room.round;
    const current = this.currentPlayer(room);
    if (current && !current.bot && !current.connected) {
      const since = Math.max(round.turnStartedAt, current.offlineSince || 0);
      return Math.min(round.turnDeadline, since + OFFLINE_GRACE_MS);
    }
    return round.turnDeadline;
  }

  // A ticket identifying the current turn and when it's due, or null if no round is running.
  pendingTurn(room) {
    if (!room || room.phase !== 'playing' || room.round.winner) return null;
    return {
      code: room.code,
      roundNumber: room.roundNumber,
      passCount: room.round.passCount,
      reshuffles: room.round.reshuffles,
      dueAt: this.turnDueAt(room),
    };
  }

  // Plays a card for whoever's turn it is, if the ticket's turn is still current and due.
  // Bots and timed-out people use the same strategy.
  autoPass(ticket) {
    const room = this.rooms.get(ticket.code);
    const now = this.pendingTurn(room);
    if (!now || now.roundNumber !== ticket.roundNumber || now.passCount !== ticket.passCount
      || now.reshuffles !== ticket.reshuffles) {
      return null;
    }
    if (this.now() < now.dueAt) return null; // e.g. the player came back online
    const current = this.currentPlayer(room);
    const card = chooseBotCard(room.round.hands[current.id], room.round.receivedCardId, this.rng);
    this.applyPass(room, current.id, card.id, !current.bot);
    return room;
  }

  // ---- connection tracking ------------------------------------------------

  setConnected(token, connected) {
    const room = this.roomForToken(token);
    const player = room && this.playerForToken(room, token);
    if (!player) return null;
    player.connected = connected;
    player.offlineSince = connected ? null : this.now();
    this.touch(room);
    return room;
  }

  // Drops rooms where nobody is connected and nothing happened for a while.
  sweep() {
    const cutoff = this.now() - ROOM_IDLE_MS;
    for (const room of this.rooms.values()) {
      if (room.lastActivity < cutoff && this.humans(room).every((p) => !p.connected)) {
        for (const p of this.humans(room)) this.tokens.delete(p.token);
        this.rooms.delete(room.code);
      }
    }
  }

  // ---- views --------------------------------------------------------------

  // What one player is allowed to see. Never includes tokens or other players' cards
  // (except all hands once the round is over).
  viewFor(room, playerId) {
    const round = room.round;
    const turnId = round && !round.winner ? currentPlayerId(round) : null;
    const me = room.players.find((p) => p.id === playerId);
    const spectating = !!(me && me.spectator);
    const view = {
      code: room.code,
      phase: room.phase,
      youId: playerId,
      hostId: room.hostId,
      serverNow: this.now(),
      roundNumber: room.roundNumber,
      notice: room.notice,
      baseNames: BASE_NAMES,
      extraNames: room.extraNames,
      neededExtraNames: Math.max(0, room.players.length - BASE_NAMES.length),
      botsNeeded: room.phase === 'lobby' ? this.botsNeeded(room) : 0,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      spectating,
      // Spectators are seated in join order, one per bot.
      seatNextRound: spectating
        && room.players.filter((p) => p.spectator).indexOf(me) < room.players.filter((p) => p.bot).length,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        bot: p.bot,
        spectator: p.spectator,
        connected: p.connected,
        score: p.score,
        cardCount: round && round.hands[p.id] ? round.hands[p.id].length : 0,
      })),
      round: null,
    };
    if (round && room.phase !== 'lobby') {
      view.round = {
        names: round.names,
        order: round.order,
        starterId: round.order[round.starterIndex],
        turnPlayerId: turnId,
        turnStartedAt: round.turnStartedAt,
        turnDueAt: turnId ? this.turnDueAt(room) : null,
        yourHand: round.hands[playerId] || [],
        lockedCardId: turnId === playerId ? round.receivedCardId : null,
        lastPass: round.lastPass,
        passCount: round.passCount,
        winner: round.winner,
        revealedHands: room.phase === 'roundOver' ? round.hands : null,
        passesSinceDeal: round.passesSinceDeal,
        reshuffles: round.reshuffles,
        voteAt: this.voteAllowedAt(round),
      };
    }
    view.voteResult = room.voteResult;
    view.canRequestVote = !!(room.phase === 'playing' && !room.vote && me && !me.spectator
      && round.passesSinceDeal >= this.voteAllowedAt(round));
    view.vote = null;
    const v = room.vote;
    if (v && room.phase === 'playing') {
      // Never reveals who the blocker is.
      const cast = Object.values(v.votes);
      view.vote = {
        id: v.id,
        kind: v.kind,
        startedBy: v.startedBy,
        startedAt: v.startedAt,
        endsAt: v.endsAt,
        total: v.eligible.length,
        yes: cast.filter((x) => x).length,
        no: cast.filter((x) => !x).length,
        canVote: v.eligible.includes(playerId) && !(playerId in v.votes),
        yourVote: playerId in v.votes ? v.votes[playerId] : null,
      };
    }
    return view;
  }
}

module.exports = {
  RoomStore,
  MAX_PLAYER_NAME,
  MAX_CARD_NAME,
  TURN_MS,
  OFFLINE_GRACE_MS,
  BOT_MIN_MS,
  BOT_JITTER_MS,
  MIN_PASSES_FOR_VOTE,
  BLOCK_STREAK,
  VOTE_MS,
  VOTE_COOLDOWN_PASSES,
};
