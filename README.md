# Jeview

A small local proxy for Jev (TypeSafe System One), with a live view of every call.

Point your Jev client at Jeview instead of TypeSafe. Jeview calls Jev with your key, returns Jev's answer, keeps every
call in a local SQLite database, and draws the calls on a live map as they happen.

## Run it

Needs Node 24 or later.

```sh
npm install
npm start
```

Open http://127.0.0.1:4777/ and add your TypeSafe API key in settings (the sliders icon, top right).

To see it working, run `npm run demo` in a second terminal: Jev plays Pixel Knight, a made-up side-scroller, choosing
every move through Jeview (about ten cents an hour). Ctrl-C stops it.

## Send requests to it

Send Jev requests to `http://127.0.0.1:4777/v1/systemone` instead of `https://api.typesafe.ai/v1/systemone`: the same
requests and the same answers, with no key needed from the caller.

- **Name a run** with a label in the path: `http://127.0.0.1:4777/my-run/v1/systemone`.
- **Link calls.** Every answer comes back with an event id in `events`. When a later request follows from one of
  those answers, send its event id in a `Jeview-Trigger` header, and the map grows that request off the answer.
  Jeview drops its own headers before calling Jev and sends the body on unchanged.

Agents can read `http://127.0.0.1:4777/llms.txt`.

## Options

- `--port 4777`
- `--dir ~/.local/share/jeview`: where the database lives
- `--jev-endpoint URL`: another Jev endpoint, such as a local mock

## Your data

Calls and your key stay on your machine, in `jeview.sqlite` in the data folder, readable only by you. Jeview listens on
127.0.0.1 only.

## Develop

```sh
npm test
npm run typecheck
```

## License

MIT
