# RSJM — Ram · Shaayam · Jadu · Madhu

A 4–6 player card-passing game you play in the browser. It works on Android phones.

## How to play

- With 4 players there are 16 cards: 4 each of **Ram**, **Shaayam**, **Jadu** and **Madhu**. Every player is dealt 4 cards.
- With 5 or 6 players the host types one extra card name per extra player. Each new name adds 4 cards, so 5 players use 20 cards and 6 players use 24.
- You only see your own cards.
- On your turn, pass one card to the next player. You **can't pass the card you just received**. You can pass it on a later turn.
- The first player to hold **4 cards with the same name** wins the round and gets a point. The starting player rotates each round.

## Run locally

```bash
npm install
npm start          # http://localhost:3000
npm test           # unit tests (node:test)
```

To try it with friends on the same Wi-Fi, open `http://<your-PC-ip>:3000` on each phone.

## Deploy on Render (free)

1. Push this repo to GitHub.
2. On https://render.com choose **New → Blueprint** and pick this repo. `render.yaml` sets everything up. You can also use **New → Web Service** with build command `npm install` and start command `npm start`.
3. Open the `https://<name>.onrender.com` URL on your phones. One person creates a room and shares the 4-letter code or the invite link.

The free Render plan sleeps after about 15 minutes with no visitors, so the first load can take up to a minute. Rooms are kept in memory, so a restart or redeploy ends any games in progress.
