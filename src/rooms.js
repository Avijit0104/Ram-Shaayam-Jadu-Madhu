'use strict';

// In-memory room store: lobby management, round lifecycle and per-player views.
// Players are identified by a secret `token` (kept in the browser's localStorage,
// sent on the socket handshake) and a public `id` that is safe to show to others.

const crypto = require('crypto');
const {
  BASE_NAMES,
  MIN_PLAYERS,
  MAX_PLAYERS,
  GameError,
  dealRound,
  currentPlayerId,
  passCard,
} = require('./game');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O to avoid confusion with 1/0
const MAX_PLAYER_NAME = 16;
const MAX_CARD_NAME = 12;
const MAX_EXTRA_NAMES = MAX_PLAYERS - BASE_NAMES.length;
const ROOM_IDLE_MS = 2 * 60 * 60 * 1000;

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
    return room.players.find((p) => p.token === token) || null;
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

  newPlayer(token, name) {
    return {
      id: crypto.randomBytes(6).toString('hex'),
      token,
      name,
      connected: true,
      score: 0,
    };
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
      notice: null,
      lastActivity: this.now(),
    };
    this.rooms.set(room.code, room);
    this.tokens.set(token, room.code);
    return room;
  }

  joinRoom(token, rawCode, rawName) {
    const code = String(rawCode ?? '').trim().toUpperCase();
    const room = this.rooms.get(code);
    if (!room) throw new GameError('Room not found. Check the code.');

    const existing = this.playerForToken(room, token);
    if (existing) {
      existing.connected = true;
      this.touch(room);
      return room;
    }

    const name = cleanName(rawName, MAX_PLAYER_NAME, 'Name');
    if (room.phase !== 'lobby') throw new GameError('That game has already started');
    if (room.players.length >= MAX_PLAYERS) throw new GameError(`Room is full (max ${MAX_PLAYERS})`);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError('Someone in the room already has that name');
    }

    this.leave(token);
    room.players.push(this.newPlayer(token, name));
    room.notice = null;
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
    room.players = room.players.filter((p) => p !== player);
    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return null;
    }
    if (room.hostId === player.id) room.hostId = room.players[0].id;
    if (room.phase !== 'lobby') {
      // A round can't continue with a missing hand.
      room.phase = 'lobby';
      room.round = null;
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
    const n = room.players.length;
    if (n < MIN_PLAYERS) throw new GameError(`Need at least ${MIN_PLAYERS} players`);
    if (n > MAX_PLAYERS) throw new GameError(`At most ${MAX_PLAYERS} players`);
    this.deal(room, this.cardNamesFor(room));
    return room;
  }

  nextRound(token) {
    const { room } = this.requireHost(token);
    if (room.phase !== 'roundOver') throw new GameError('The round is still going');
    this.deal(room, room.round.names);
    return room;
  }

  toLobby(token) {
    const { room } = this.requireHost(token);
    room.phase = 'lobby';
    room.round = null;
    room.notice = null;
    this.touch(room);
    return room;
  }

  deal(room, names) {
    const order = room.players.map((p) => p.id);
    const starter = room.nextStarterIndex % order.length;
    room.round = dealRound(order, names, starter, this.rng);
    room.nextStarterIndex = (starter + 1) % order.length;
    room.roundNumber++;
    room.phase = 'playing';
    room.notice = null;
    this.touch(room);
  }

  pass(token, cardId) {
    const { room, player } = this.requireMembership(token);
    if (room.phase !== 'playing') throw new GameError('No round in progress');
    passCard(room.round, player.id, cardId);
    if (room.round.winner) {
      const winner = room.players.find((p) => p.id === room.round.winner.playerId);
      if (winner) winner.score++;
      room.phase = 'roundOver';
    }
    this.touch(room);
    return room;
  }

  // ---- connection tracking ------------------------------------------------

  setConnected(token, connected) {
    const room = this.roomForToken(token);
    const player = room && this.playerForToken(room, token);
    if (!player) return null;
    player.connected = connected;
    this.touch(room);
    return room;
  }

  // Drops rooms where nobody is connected and nothing happened for a while.
  sweep() {
    const cutoff = this.now() - ROOM_IDLE_MS;
    for (const room of this.rooms.values()) {
      if (room.lastActivity < cutoff && room.players.every((p) => !p.connected)) {
        for (const p of room.players) this.tokens.delete(p.token);
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
    const view = {
      code: room.code,
      phase: room.phase,
      youId: playerId,
      hostId: room.hostId,
      roundNumber: room.roundNumber,
      notice: room.notice,
      baseNames: BASE_NAMES,
      extraNames: room.extraNames,
      neededExtraNames: Math.max(0, room.players.length - BASE_NAMES.length),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
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
        yourHand: round.hands[playerId] || [],
        lockedCardId: turnId === playerId ? round.receivedCardId : null,
        lastPass: round.lastPass,
        passCount: round.passCount,
        winner: round.winner,
        revealedHands: room.phase === 'roundOver' ? round.hands : null,
      };
    }
    return view;
  }
}

module.exports = { RoomStore, MAX_PLAYER_NAME, MAX_CARD_NAME };
