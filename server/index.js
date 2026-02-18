const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { WebSocket, WebSocketServer } = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const WEB_DIR = path.resolve(__dirname, "..", "web");
const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const MAX_PEERS_PER_ROOM = 2;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

const rooms = new Map();
const peerBySocket = new Map();

function getIceServers() {
  const iceServers = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ];

  const turnUrl = process.env.TURN_URL;
  if (!turnUrl) {
    return iceServers;
  }

  const turnServer = { urls: turnUrl };
  if (process.env.TURN_USERNAME) {
    turnServer.username = process.env.TURN_USERNAME;
  }
  if (process.env.TURN_PASSWORD) {
    turnServer.credential = process.env.TURN_PASSWORD;
  }

  iceServers.push(turnServer);
  return iceServers;
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function parseRequestUrl(request) {
  const host = request.headers.host || "localhost";
  return new URL(request.url || "/", `http://${host}`);
}

function parseRoomId(request) {
  const url = parseRequestUrl(request);
  const roomId = (url.searchParams.get("room") || "").trim();
  if (!ROOM_ID_PATTERN.test(roomId)) {
    return null;
  }
  return roomId;
}

function broadcast(roomId, payload, exceptPeerId = null) {
  const room = rooms.get(roomId);
  if (!room) {
    return;
  }

  for (const [peerId, socket] of room.entries()) {
    if (peerId === exceptPeerId) {
      continue;
    }
    sendJson(socket, payload);
  }
}

function cleanupSocket(socket) {
  const peerMeta = peerBySocket.get(socket);
  if (!peerMeta) {
    return;
  }

  peerBySocket.delete(socket);

  const room = rooms.get(peerMeta.roomId);
  if (!room) {
    return;
  }

  room.delete(peerMeta.peerId);
  broadcast(peerMeta.roomId, { type: "peer-left", peerId: peerMeta.peerId }, peerMeta.peerId);

  if (room.size === 0) {
    rooms.delete(peerMeta.roomId);
  }
}

function forwardSignal(senderSocket, message) {
  const senderMeta = peerBySocket.get(senderSocket);
  if (!senderMeta) {
    return;
  }

  const room = rooms.get(senderMeta.roomId);
  if (!room) {
    return;
  }

  const payload = {
    type: message.type,
    from: senderMeta.peerId
  };

  if (message.sdp) {
    payload.sdp = message.sdp;
  }
  if (message.candidate) {
    payload.candidate = message.candidate;
  }
  if (message.reason) {
    payload.reason = message.reason;
  }

  if (message.target) {
    const targetSocket = room.get(message.target);
    if (!targetSocket) {
      sendJson(senderSocket, { type: "error", message: "Target peer is not in this room." });
      return;
    }
    sendJson(targetSocket, payload);
    return;
  }

  broadcast(senderMeta.roomId, payload, senderMeta.peerId);
}

function handleWsMessage(socket, rawData) {
  let message;
  try {
    message = JSON.parse(rawData.toString());
  } catch {
    sendJson(socket, { type: "error", message: "Invalid JSON payload." });
    return;
  }

  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    sendJson(socket, { type: "error", message: "Invalid signaling format." });
    return;
  }

  if (["offer", "answer", "candidate", "bye"].includes(message.type)) {
    forwardSignal(socket, message);
    return;
  }

  if (message.type === "ping") {
    sendJson(socket, { type: "pong", ts: Date.now() });
    return;
  }

  sendJson(socket, { type: "error", message: `Unsupported message type: ${message.type}` });
}

function serveStaticFile(request, response) {
  if (request.method !== "GET") {
    response.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    response.end("Method Not Allowed");
    return;
  }

  const url = parseRequestUrl(request);

  if (url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === "/config") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(
      JSON.stringify({
        maxPeersPerRoom: MAX_PEERS_PER_ROOM,
        iceServers: getIceServers()
      })
    );
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") {
    pathname = "/index.html";
  }

  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const relativePath = safePath.replace(/^[/\\]+/, "");
  const filePath = path.join(WEB_DIR, relativePath);

  if (!filePath.startsWith(WEB_DIR)) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not Found");
      return;
    }

    const ext = path.extname(filePath);
    response.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
    response.end(data);
  });
}

const httpServer = http.createServer(serveStaticFile);
const wsServer = new WebSocketServer({ noServer: true });

wsServer.on("connection", (socket, request, roomId) => {
  const peerId = crypto.randomUUID();
  const room = rooms.get(roomId) || new Map();
  rooms.set(roomId, room);
  room.set(peerId, socket);
  peerBySocket.set(socket, { roomId, peerId });

  const peers = [...room.keys()].filter((id) => id !== peerId);
  sendJson(socket, {
    type: "welcome",
    peerId,
    roomId,
    peers,
    maxPeersPerRoom: MAX_PEERS_PER_ROOM
  });

  broadcast(roomId, { type: "peer-joined", peerId }, peerId);

  socket.on("message", (rawData) => handleWsMessage(socket, rawData));
  socket.on("close", () => cleanupSocket(socket));
  socket.on("error", () => cleanupSocket(socket));
});

httpServer.on("upgrade", (request, socket, head) => {
  const url = parseRequestUrl(request);
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const roomId = parseRoomId(request);
  if (!roomId) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\nInvalid room id.\r\n");
    socket.destroy();
    return;
  }

  const room = rooms.get(roomId);
  if (room && room.size >= MAX_PEERS_PER_ROOM) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\nRoom is full.\r\n");
    socket.destroy();
    return;
  }

  wsServer.handleUpgrade(request, socket, head, (wsSocket) => {
    wsServer.emit("connection", wsSocket, request, roomId);
  });
});

httpServer.listen(PORT, HOST, () => {
  const turnState = process.env.TURN_URL ? "enabled" : "disabled";
  // eslint-disable-next-line no-console
  console.log(`P2P signaling server listening on http://${HOST}:${PORT} (TURN: ${turnState})`);
});
