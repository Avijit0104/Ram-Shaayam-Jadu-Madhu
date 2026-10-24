# RSJM — Ram · Shaayam · Jadu · Madhu

A real-time card-passing game for 1–6 people, played in the browser on Android phones or any device.

### ▶ Play now: **[ram-shaayam-jadu-madhu.onrender.com](https://ram-shaayam-jadu-madhu.onrender.com)**

> If nobody has played for a while, the first load can take up to a minute while the server wakes up.

---

## Starting a game

1. Open the [game link](https://ram-shaayam-jadu-madhu.onrender.com) and enter your name.
2. One person taps **Create a new room** and shares the 4-letter room code, or taps **Share invite link** to send it on WhatsApp or anywhere else.
3. Friends open the link, or enter the code and tap **Join**.
4. The host taps **Start game**. If fewer than 4 people have joined, bots fill the empty seats.

## Rules

- **Players:** every game has at least 4 seats. If only 1–3 people join, 🤖 bots take the rest (1 person + 3 bots, 2 + 2, 3 + 1). Up to 6 people can play.
- **Cards:** there are 4 cards of each name. With 4 players the names are **Ram**, **Shaayam**, **Jadu** and **Madhu** (16 cards). For a 5th or 6th player, the host picks one more name each, which adds 4 more cards (20 or 24 cards).
- **Dealing:** every player gets 4 random cards. You see only your own cards.
- **Passing:** on your turn, give one card to the next player. You **can't pass the card you just received** (it shows a 🔒). You can pass it on a later turn.
- **Winning:** the first player to hold **4 cards with the same name** wins the round and gets ★ 1 point. Then everyone's cards are shown, and the next round starts with the next player.

## Features

- Rooms with a 4-letter code and a shareable invite link.
- Each player's phone shows only their own cards. The server never sends anyone else's cards until the round ends.
- If your phone sleeps or you switch apps, you get your seat back automatically.
- Your phone vibrates when it's your turn, and the screen stays on during a game.
- Bots fill empty seats so you can play even when your friends aren't online.
- Scores are kept across rounds, and the host can remove players who left.

## Tech

[Node.js](https://nodejs.org) · [Express](https://expressjs.com) · [Socket.IO](https://socket.io), with a plain HTML/CSS/JavaScript frontend and no build step. Hosted on [Render](https://render.com).

```
server.js          Express + Socket.IO server
src/game.js        Card rules: deal, pass, win check
src/rooms.js       Rooms, lobby, rounds, what each player is allowed to see
src/bots.js        Bot players
public/            The game screens (index.html, client.js, style.css)
test/              Tests
```

## Run it on your own computer

```bash
git clone https://github.com/Avijit0104/Ram-Shaayam-Jadu-Madhu.git
cd Ram-Shaayam-Jadu-Madhu
npm install
npm start          # open http://localhost:3000
npm test           # run the tests
```

---

Created by **Avijit Bose** · [GitHub](https://github.com/Avijit0104)
