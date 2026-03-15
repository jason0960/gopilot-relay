# GoPilot Relay Server

WebSocket relay hub for [GoPilot](https://github.com/jason0960/vscode_ide_mobile_plug) — bridges VS Code extensions and mobile clients via room-based WebSocket routing.

## How it works

```
┌──────────────────┐        ┌─────────────────┐        ┌────────────────┐
│  Mobile App      │  WS    │  Relay Server   │  WS    │  VS Code Ext   │
│  (GoPilot)       │◄──────►│  (this server)  │◄──────►│  (GoPilot)     │
└──────────────────┘ :join  └─────────────────┘ :host  └────────────────┘
```

1. VS Code extension connects to `/relay/host` → gets a 6-char room code
2. Mobile app connects to `/relay/join?code=XXXX` → joins the room
3. All messages are forwarded bidirectionally in real-time

## Quick start

```bash
npm install
npm run build
npm start        # Listens on port 4800
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4800` | Server port |
| `ROOM_TTL_MS` | `14400000` | Room expiry (4 hours) |
| `MAX_ROOMS` | `1000` | Maximum concurrent rooms |
| `DEBUG_RELAY` | `0` | Set to `1` for verbose message logging |

## Deploy

### Fly.io (recommended)

```bash
fly launch          # First time
fly deploy          # Subsequent deploys
fly scale count 1   # Ensure always-on
```

### Docker

```bash
docker build -t gopilot-relay .
docker run -p 4800:4800 gopilot-relay
```

### Any Node.js host

```bash
npm ci
npm run build:prod
PORT=4800 node dist/index.js
```

## API

### WebSocket endpoints

| Path | Role | Description |
|------|------|-------------|
| `/relay/host` | VS Code | Creates a room, returns `{ type: 'relay.room_created', code, hostSecret }` |
| `/relay/join?code=XXXX` | Mobile | Joins a room, returns `{ type: 'relay.joined', code, hostConnected }` |
| `/relay/rejoin?code=XXXX&secret=YYY` | VS Code | Reconnects as host |

### HTTP endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/health` | GET | Returns `{ status: 'ok', rooms, uptime }` |

## Security

- Per-socket message rate limiting (60 msgs / 10s)
- Per-IP connection rate limiting (20 / 60s)
- Max message size: 1 MB
- Max clients per room: 10
- Host secret prevents room hijacking
- TTL-based room expiry

## Testing

```bash
npm test
```

## License

MIT
