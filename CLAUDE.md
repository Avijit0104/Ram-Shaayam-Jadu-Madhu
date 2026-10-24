# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

RSJM ("Ram-Shaayam-Jadu-Madhu") is a real-time multiplayer card-passing game for 1–6 people (bots fill seats up to 4), played in the browser (mainly on Android phones). It is deployed to Render.com from the GitHub repo `Avijit0104/Ram-Shaayam-Jadu-Madhu`. See README.md for the player-facing rules.

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
- If a player leaves mid-round, the round ends and the room goes back to the lobby. A disconnect does **not** remove the player; they keep their seat and can reconnect.

## Architecture

- `src/game.js`: pure round logic (`dealRound`, `passCard`, `completedSet`). No I/O. Throws `GameError` for rule violations; those messages are shown to users.
- `src/bots.js`: bot names and `chooseBotCard` (greedy: pass a card of the rarest name, never the locked one).
- `src/rooms.js`: `RoomStore`, the in-memory room and lobby state machine (`lobby → playing → roundOver → playing/lobby`), host-only actions, and `viewFor(room, playerId)`, which builds each player's **personalized** view. Other players' hands are hidden until `roundOver`, and the locked card is shown only to the current player. **Any new state sent to clients must go through `viewFor` so hidden information doesn't leak.**
- `server.js`: Express static server plus Socket.IO wiring. Every client event is a `GameError`-safe handler that replies with an ack `{ok, error}` and then calls `broadcast(room)`, which emits a separate `state` to each human player. `broadcast` also calls `scheduleBot`: if it's a bot's turn, it sets one timer per room (about 1.2–2s) that calls `store.botPass(ticket)`. The ticket (`roundNumber` + `passCount` from `pendingBotTurn`) makes stale timers do nothing.
- `public/client.js`: a single-file vanilla JS client. It re-renders the whole screen (`renderHome` / `renderLobby` / `renderGame`) from the latest `state`, and `preserveInputs` keeps focused input text across re-renders.

### Identity and reconnection

- The browser generates a secret hex `token` and stores it in localStorage (`rsjm-token`). It's sent on the Socket.IO handshake (`auth.token`). Every socket joins the channel `t:<token>`, so all of a player's tabs and reconnects get the same view.
- Players also have a public `id` (random hex) used in views. Tokens must never appear in views (a test checks this).
- On connect, the server calls `store.setConnected(token, true)` and re-sends state, which is how a phone that slept or switched apps resumes. `socketCounts` tracks open sockets per token so the player is only marked offline when the last one closes.
- `state` with `null` sends the client back to the home screen (after leave/kick, or no room). The second argument is an optional notice.

### Socket events (client → server)

`room:create {name}`, `room:join {code,name}`, `room:leave`, `room:kick {playerId}` (host, lobby only), `room:extraNames {names}` (host, lobby only), `game:start` (host), `game:pass {cardId}`, `game:nextRound` (host), `game:toLobby` (host).

## Deployment notes

- `render.yaml` defines a free Node web service with health check `/healthz`.
- State is in memory only: a restart or redeploy wipes all rooms. Idle rooms with nobody connected are swept after 2 hours.
- The free plan sleeps after about 15 minutes idle, so the first request can take up to about a minute.
