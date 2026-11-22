# ChessMaster online protocol (WebSocket, JSON text frames)

The page connects to the address typed in the lobby ("Server" field). Default: `ws(s)://<page host>/ws`
when served over http(s), otherwise `ws://localhost:8080/ws` (edit `DEFAULT_SERVER` in index.html).
Use `wss://` if the page is served over https.

Invite links look like `index.html?room=ABCDE&server=wss://host/ws`.

Moves are objects: `{ "fr":6, "fc":4, "r":4, "c":4, "promo":null }`
(row 0 = rank 8, col 0 = file a; `promo` is `"q"|"r"|"b"|"n"` or null). Colors are `"w"` / `"b"`. White moves first.

## Client -> server
| type | fields | meaning |
|---|---|---|
| `create` | `name`, `color` (`w`/`b`/`random`) | new room, creator takes a seat |
| `join` | `room`, `name` | take the free seat |
| `rejoin` | `room`, `token`, `name` | sent automatically after a dropped connection |
| `move` | `ply` (1-based move number), `move`, `san` | player made a move |
| `sync` | – | ask for the full move list |
| `resign` / `draw_offer` / `draw_accept` / `draw_decline` | – | relay to opponent |
| `rematch` | – | request; when both sides sent it, swap colors and reset |
| `leave` | – | player left for good |
| `ping` | – | keep-alive every 25 s |

All messages after joining also carry `room`.

## Server -> client
| type | fields | meaning |
|---|---|---|
| `created` | `room`, `token`, `color` | reply to `create` (UI shows the waiting screen) |
| `joined` | `room`, `token`, `color`, `opponent` (name or null), `opponent_online`, `moves[]` | reply to `join` **and** `rejoin`; client rebuilds the game from `moves` |
| `opponent_joined` | `name` | second player arrived, game starts |
| `opponent_left` | – | opponent disconnected/left (UI shows a banner) |
| `opponent_back` | – | opponent reconnected |
| `move` | `move` | opponent's move (send only to the other player) |
| `sync` | `moves[]` | full move list (reply to `sync`, or when a move arrives out of order) |
| `resign`, `draw_offer`, `draw_accept`, `draw_decline` | – | relayed from opponent |
| `rematch_request` | – | opponent wants a rematch |
| `rematch` | `color` | both agreed: new game, this is your new color |
| `error` | `message`, `fatal?` | `fatal:true` sends the player back to the menu (e.g. room expired on rejoin) |
| `pong` | – | reply to `ping` |

Checkmate / stalemate / repetition etc. are detected by both clients themselves, so the server can be a pure relay
(see `server.js`). Add chess validation on the server if you want it authoritative.
