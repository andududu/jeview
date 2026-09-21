# Working on Jeview

Jeview is a local gateway for Jev (TypeSafe System One) with a live viewer. To *use* a running Jeview, read
[llms.txt](llms.txt), or `/llms.txt` on the Jeview itself. This file is for changing the code.

## The lie of the land

- `src/jeview.ts`: the whole server. The proxy, the SQLite store, the read API, and the text of llms.txt.
- `jeview.ts`: the command line. `launch.sh` finds a Node and runs it.
- `ui/`: the viewer, plain JavaScript with no build step, served from disk on every request.
- `demo/`: Pixel Knight and Support Desk, each a small server and a page. They play through a running Jeview.
- `test/jeview.test.ts`: every promise the server makes, against a stand-in for Jev.

## Check your work

```sh
npm install          # only the type checker
npm run typecheck
npm run check:pages  # the browser scripts parse
npm test
```

Tests never call TypeSafe. The demos do: every call is real and costs money, so do not run them in CI or leave them
running. They play only while a page is open.

## Rules of the house

- **No dependencies at run time.** Node 24 and its standard library are all Jeview needs. Keep it so.
- **Node runs the TypeScript as it is**, by stripping the types. Use only syntax that can be stripped: no enums, no
  namespaces, no parameter properties. Imports name the file, `.ts` included.
- **The body goes to Jev byte for byte**, and Jev's answer comes back as sent, plus `events`. Jeview's own headers
  (`Jeview-*`) never reach Jev.
- **The key is never shown**, logged or returned: only whether it is set, and its last four characters.
- **Loopback only.** Jeview answers to local host names, refuses requests from web pages on other sites, and has no
  login. Each of these has a test; a change that needs one of them loosened is probably the wrong change.
- **Nothing leaves the machine but calls to Jev.** No telemetry, no fonts or scripts from elsewhere: the viewer's
  content security policy allows only its own origin.
- **Pages are built from nodes and text**, never from HTML strings that carry data: recorded calls hold whatever a
  caller sent. See `h()` in `ui/app.js`.
- **The viewer must work with an older server**, and the server with an older viewer's requests: the pages are read
  from disk while an older process may still be running.
- After changing `llmsText`, run `npm run llms` to write `llms.txt` again. A test compares the two.

## Writing

Comments say why, in plain words, and only where the code cannot. Commit messages are one sentence about what
changed for the person using Jeview, then the details. Match the code around you: it is dense on purpose.
