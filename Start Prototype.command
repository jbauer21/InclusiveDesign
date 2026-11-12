#!/bin/zsh
cd -- "${0:A:h}"
if ! command -v node >/dev/null 2>&1; then
  print 'Node.js 18 or newer is required. Install it from https://nodejs.org, then try again.'
  read 'reply?Press Return to close.'
  exit 1
fi
print 'Open http://localhost:5173 in your browser. Keep this window open while using the prototype.'
node server.mjs
read 'reply?Server stopped. Press Return to close.'
