# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RSJM ("Ram-Shaayam-Jadu-Madhu") is a real-time multiplayer card-passing game for 1–6 people (bots fill seats up to 4), played in the browser (mainly on Android phones). It's live at https://ram-shaayam-jadu-madhu.onrender.com, and Render auto-deploys every push to `main` on GitHub `Avijit0104/Ram-Shaayam-Jadu-Madhu`. See README.md for the player-facing rules.

The author is Avijit Bose (git: `Avijit0104 <avibose000@gmail.com>`). Every screen must show "Created by Avijit Bose": the fixed `footer.credit` in `public/index.html`. Fixed-bottom UI (`.actionbar`, `.overlay`, `.toast`) is offset by `--credit-h` so it sits above the footer.

## Commands

```bash
npm install
npm start                                  # server on $PORT (default 3000)
npm run dev                                # node --watch
npm test                                   # all tests (node:test, auto-discovers test/*.test.js)
node --test --test-name-pattern="wraps"    # single test by name
node --test test/game.test.js              # single file
```

No build step, bundler, linter or framework. The frontend is plain HTML/CSS/JS served statically.

## Game rules as implemented (decisions the code depends on)

- One card name per player, 4 cards per name, 4 cards dealt to each player. So 4 players use 16 cards, 5 use 20, 6 use 24. Base names are `Ram, Shaayam, Jadu, Madhu`. For 5 or 6 players the host types the extra names in the lobby (`room.extraNames`), and the game can't start until they're filled in and unique (case-insensitive).
- Turns are sequential in seat order. The current player passes one card to the next seat. The receiver now holds 5 cards and may not pass the card they just received (`round.receivedCardId`). The starter's first pass has no lock.
- A player wins when they *receive* a card that gives them 4 of one name. Only the receiver is checked, because the passer would already have won when they received. Deals are reshuffled if anyone is dealt 4 of a kind.
- A win gives +1 score. The host starts the next round, and the starter rotates (`room.nextStarterIndex`).
- Bots: if fewer than 4 humans start, server-side bots (`bot: true`, `token: null`) are added on `startGame` to make 4 seats. They exist only during `playing`/`roundOver`; `toLobby` and a mid-round leave remove them. Bots never need extra card names (`cardNamesFor` runs before `addBots`). A room with no humans left is deleted.
- Turn timer: every turn has a deadline (`round.turnStartedAt` / `round.turnDeadline`, set by `RoomStore.startTurn`). People get `TURN_MS` (30s); bots get 1.2–2s. A human who is offline on their turn is due `OFFLINE_GRACE_MS` (10s) after the later of turn start and `offlineSince` (`turnDueAt`). When a turn is due, `autoPass` plays a card with `chooseBotCard`; a timed-out human's pass is marked `lastPass.auto`.
- Late joiners: joining while a game runs adds a `spectator: true` player who holds no cards and isn't in `round.order`. `nextRound` → `seatSpectators` swaps spectators into bot seats in place (join order, first bot first). If no bot seat is free they keep watching until `returnToLobby`, which clears `spectator`. Spectators count toward `MAX_PLAYERS`; a spectator leaving does **not** end the round.
- Reshuffle votes (`room.vote`, one at a time; logic in `rooms.js` → `startVote` / `castVote` / `settleVote` / `expireVote`):
  - **Blocking** is detected in `passCard`: passing a card with the same *name* as the one just received while keeping a full hand of all-different names. `round.blockStreak[id]` counts consecutive blocking turns.
  - `kind: 'manual'`: any seated human, once `round.passesSinceDeal >= voteAllowedAt` (15, or later after a failed vote: +`VOTE_COOLDOWN_PASSES`). Every seated player votes and all must say Yes.
  - `kind: 'blocking'`: auto-started when someone's streak reaches `BLOCK_STREAK` (4) after the same 15-pass threshold. The blocker is excluded and a majority wins.
  - Bots always vote Yes, and the asker of a manual vote counts as Yes. At the 20s expiry, missing votes count as Yes for blocking votes; for manual votes only offline people's missing votes count as Yes.
  - Views never reveal the blocker (the message is "someone is blocking", by the user's choice).
  - A passed vote calls `reshuffle(round)`: same round and turn, fresh hands, no lock, `passesSinceDeal`/`blockStreak` reset, `reshuffles++`. `passCount` is never reset, and turn tickets include `reshuffles`. A win, a new deal, or returning to the lobby cancels a vote.
- If a seated player leaves mid-round, the round ends and the room goes back to the lobby. A disconnect does **not** remove the player; they keep their seat and can reconnect.

## Architecture

- `src/game.js`: pure round logic (`dealRound`, `passCard`, `completedSet`). No I/O. Throws `GameError` for rule violations; those messages are shown to users.
- `src/bots.js`: bot names and `chooseBotCard` (greedy: pass a card of the rarest name, never the locked one).
- `src/rooms.js`: `RoomStore`, the in-memory room and lobby state machine (`lobby → playing → roundOver → playing/lobby`), host-only actions, and `viewFor(room, playerId)`, which builds each player's **personalized** view. Other players' hands are hidden until `roundOver`, and the locked card is shown only to the current player. **Any new state sent to clients must go through `viewFor` so hidden information doesn't leak.**
- `server.js`: Express static server plus Socket.IO wiring. Every client event is a `GameError`-safe handler that replies with an ack `{ok, error}` and then calls `broadcast(room)`, which emits a separate `state` to each human player. `broadcast` also calls `scheduleTurn`, which clears the room's single timer and re-arms it for `store.pendingTurn(room).dueAt`. When it fires, it calls `store.autoPass(ticket)`. The ticket (`roundNumber` + `passCount` + `reshuffles`) plus a "not due yet" check make stale or early timers do nothing, and the timer is re-armed instead. `scheduleVote` does the same for a running vote's deadline (`pendingVote` / `expireVote`). All timing rules live in `rooms.js` (injectable `now`/`rng` for tests); `server.js` only sets timers.
- `public/client.js`: a single-file vanilla JS client. It re-renders the whole screen (`renderHome` / `renderLobby` / `renderGame`) from the latest `state`, and `preserveInputs` keeps focused input text across re-renders. After each render, `effects(prev, next)` diffs the two views to play sounds (Web Audio, synthesized, mute stored in localStorage `rsjm-muted`) and animations (`animatePass` flies a card between `[data-seat]` elements, the `.arrive` card, confetti, `.overlay.enter`). The countdown (`updateTimer`, every 200ms) updates `#timer-bar` / `#timer-secs` in place using `serverNow - Date.now()` as clock offset. Effects must not depend on re-render count: they run only on state changes, never in render functions (except `overlayShownForRound`, which keeps the popup animation one-shot).
- UI design (`public/style.css` + render functions in `client.js`):
  - Theme is a felt card table with gold accents. Fonts are Baloo 2 (display) and Nunito (body) from Google Fonts. Card colours are `--c0..--c5`, and `ICONS` gives one emoji per name index (🏹 🦚 🔮 🍯 ⭐ 🌙).
  - Seats sit around an oval `.table`, positioned by angle in `tableHtml`: you at the bottom, then clockwise in pass order. The current seat's `.seat-ring` shows the turn timer as a conic gradient via `--p`, set in `updateTimer`.
  - The hand is a fan: `--i`/`--n` per card, and `--cw`/`--ov` (card width and overlap) are computed in `renderGame` from the screen width. Fan layout uses the individual `rotate`/`translate` properties so `transform` keyframe animations (`.deal`, `.arrive`) compose with it.
  - Because every state update rebuilds `#app`'s innerHTML, CSS entrance animations inside it replay on every update. Only add them behind one-shot classes set from `effects` or tracked sets (`knownLobbyPlayers`, `overlayShownForRound`). The screen-change fade on `main` uses **opacity only**, because a transform there would break the `position: fixed` action bar and popup.

### Identity and reconnection

- The browser generates a secret hex `token` and stores it in localStorage (`rsjm-token`). It's sent on the Socket.IO handshake (`auth.token`). Every socket joins the channel `t:<token>`, so all of a player's tabs and reconnects get the same view.
- Players also have a public `id` (random hex) used in views. Tokens must never appear in views (a test checks this).
- On connect, the server calls `store.setConnected(token, true)` and re-sends state, which is how a phone that slept or switched apps resumes. `socketCounts` tracks open sockets per token so the player is only marked offline when the last one closes.
- `state` with `null` sends the client back to the home screen (after leave/kick, or no room). The second argument is an optional notice.

### Socket events (client → server)

`room:create {name}`, `room:join {code,name}`, `room:leave`, `room:kick {playerId}` (host, lobby only), `room:extraNames {names}` (host, lobby only), `game:start` (host), `game:pass {cardId}`, `game:nextRound` (host), `game:toLobby` (host), `vote:start`, `vote:cast {yes}`.

## Deployment notes

- `render.yaml` defines a free Node web service with health check `/healthz`.
- State is in memory only: a restart or redeploy wipes all rooms. Idle rooms with nobody connected are swept after 2 hours.
- The free plan sleeps after about 15 minutes idle, so the first request can take up to about a minute.
