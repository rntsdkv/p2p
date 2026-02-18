# P2P NAT Traversal Video PoC

Minimal prototype of a P2P video call where media is sent directly between two browser peers behind NAT.

## What this PoC includes

- Web client with local/remote video and connection log
- Node.js signaling server (WebSocket)
- WebRTC peer connection with ICE + STUN by default
- Optional TURN support (env-based)
- Docker setup for app + coturn

## Architecture

- Signaling server handles:
  - room creation/join for up to 2 peers
  - offer/answer/candidate forwarding
- Browser peers handle:
  - camera/microphone capture
  - ICE candidate gathering
  - direct RTP media path
- No central media relay in app layer

## Quick start (local)

1. Install dependencies:

```bash
npm install
```

2. Start server:

```bash
npm run start
```

3. Open app:

- [http://localhost:3000](http://localhost:3000)

4. For demo:

- Open on two devices/browsers
- Enter same Room ID
- Click `Start Camera`, then `Join Room` on both peers

## NAT traversal behavior

- STUN servers are enabled by default (`stun.l.google.com`)
- ICE chooses the best candidate pair:
  - host/srflx for direct path
  - relay (TURN) if direct path fails

## Enable TURN (recommended for restrictive NAT)

1. Copy env template:

```bash
cp .env.example .env
```

2. Set values in `.env`:

- `TURN_URL=turn:<PUBLIC_IP>:3478?transport=udp`
- `TURN_USERNAME=demo`
- `TURN_PASSWORD=demo123`

3. Run via Docker Compose:

```bash
docker compose up --build
```

4. Ensure UDP ports are open on server/firewall:

- `3478/udp`
- `49160-49200/udp`

## Notes and limitations

- Current PoC is intentionally limited to 2 peers in one room.
- For HTTPS deployment, use `wss://` automatically (frontend logic already handles this).
- In production, set a real TURN secret/user policy and `external-ip` in `turn/turnserver.conf`.

## Suggested next step

- Add a diagnostics panel that prints ICE candidate types (`host`, `srflx`, `relay`) to explicitly prove NAT traversal mode during defense/demo.
