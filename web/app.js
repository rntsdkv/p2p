const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

const state = {
  ws: null,
  pc: null,
  localStream: null,
  remotePeerId: null,
  selfPeerId: null,
  iceServers: [],
  manualDisconnect: false
};

const roomIdInput = document.getElementById("roomId");
const randomRoomButton = document.getElementById("randomRoomButton");
const startMediaButton = document.getElementById("startMediaButton");
const joinButton = document.getElementById("joinButton");
const leaveButton = document.getElementById("leaveButton");
const signalState = document.getElementById("signalState");
const selfId = document.getElementById("selfId");
const peerId = document.getElementById("peerId");
const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");
const logBox = document.getElementById("log");

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8);
}

function log(message) {
  const timestamp = new Date().toLocaleTimeString();
  logBox.textContent += `[${timestamp}] ${message}\n`;
  logBox.scrollTop = logBox.scrollHeight;
}

function setSignalState(text, mode) {
  signalState.textContent = text;
  signalState.dataset.state = mode;
}

function resetPeerInfo() {
  state.remotePeerId = null;
  peerId.textContent = "-";
  remoteVideo.srcObject = null;
}

async function loadIceConfig() {
  try {
    const response = await fetch("/config");
    if (!response.ok) {
      throw new Error(`config status: ${response.status}`);
    }
    const config = await response.json();
    state.iceServers = config.iceServers || [{ urls: "stun:stun.l.google.com:19302" }];
    log(`ICE config loaded (${state.iceServers.length} server entries).`);
  } catch (error) {
    state.iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    log(`ICE config fallback due to error: ${error.message}`);
  }
}

async function ensureLocalMedia() {
  if (state.localStream) {
    return state.localStream;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
  });

  state.localStream = stream;
  localVideo.srcObject = stream;
  setSignalState("local media ready", "local");
  log("Local camera/mic started.");
  return stream;
}

function cleanupPeerConnection() {
  if (state.pc) {
    state.pc.ontrack = null;
    state.pc.onicecandidate = null;
    state.pc.onconnectionstatechange = null;
    state.pc.close();
    state.pc = null;
  }

  resetPeerInfo();
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    setSignalState("signaling connected", "signaling");
  } else if (state.localStream) {
    setSignalState("local media ready", "local");
  } else {
    setSignalState("offline", "offline");
  }
}

function createPeerConnection() {
  if (state.pc) {
    return state.pc;
  }

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.pc = pc;

  for (const track of state.localStream.getTracks()) {
    pc.addTrack(track, state.localStream);
  }

  pc.onicecandidate = (event) => {
    if (!event.candidate || !state.remotePeerId) {
      return;
    }
    sendSignal({
      type: "candidate",
      target: state.remotePeerId,
      candidate: event.candidate
    });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    if (stream) {
      remoteVideo.srcObject = stream;
    }
  };

  pc.onconnectionstatechange = () => {
    const status = pc.connectionState;
    log(`Peer state: ${status}`);

    if (status === "connected") {
      setSignalState("p2p connected", "connected");
      return;
    }

    if (["failed", "disconnected", "closed"].includes(status)) {
      cleanupPeerConnection();
    }
  };

  return pc;
}

function sendSignal(payload) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  state.ws.send(JSON.stringify(payload));
}

async function sendOffer() {
  if (!state.remotePeerId) {
    return;
  }

  const pc = createPeerConnection();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  sendSignal({
    type: "offer",
    target: state.remotePeerId,
    sdp: pc.localDescription
  });

  log("Offer sent.");
}

async function handleOffer(message) {
  state.remotePeerId = message.from;
  peerId.textContent = message.from.slice(0, 8);

  const pc = createPeerConnection();
  await pc.setRemoteDescription(new RTCSessionDescription(message.sdp));

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({
    type: "answer",
    target: state.remotePeerId,
    sdp: pc.localDescription
  });

  log("Answer sent.");
}

async function handleAnswer(message) {
  if (!state.pc) {
    return;
  }
  await state.pc.setRemoteDescription(new RTCSessionDescription(message.sdp));
  log("Answer applied.");
}

async function handleCandidate(message) {
  if (!state.pc || !message.candidate) {
    return;
  }
  await state.pc.addIceCandidate(new RTCIceCandidate(message.candidate));
}

function closeSocketOnly() {
  if (!state.ws) {
    return;
  }

  try {
    state.manualDisconnect = true;
    if (state.remotePeerId) {
      sendSignal({ type: "bye", target: state.remotePeerId, reason: "Peer left room." });
    }
    state.ws.close();
  } finally {
    state.ws = null;
  }
}

function leaveRoom() {
  closeSocketOnly();
  cleanupPeerConnection();
  state.selfPeerId = null;
  selfId.textContent = "-";
  joinButton.disabled = false;
  leaveButton.disabled = true;
  log("Left room.");
}

function stopLocalMedia() {
  if (!state.localStream) {
    return;
  }
  for (const track of state.localStream.getTracks()) {
    track.stop();
  }
  state.localStream = null;
  localVideo.srcObject = null;
  setSignalState("offline", "offline");
  log("Local media stopped.");
}

async function joinRoom() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    log("Already connected to signaling.");
    return;
  }

  const roomId = roomIdInput.value.trim();
  if (!ROOM_ID_PATTERN.test(roomId)) {
    log("Room id must match: 3-32 chars [A-Za-z0-9_-]");
    return;
  }

  await ensureLocalMedia();
  if (state.iceServers.length === 0) {
    await loadIceConfig();
  }

  joinButton.disabled = true;
  leaveButton.disabled = false;
  location.hash = roomId;

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socketUrl = `${protocol}://${window.location.host}/ws?room=${encodeURIComponent(roomId)}`;
  const socket = new WebSocket(socketUrl);
  state.ws = socket;

  socket.onopen = () => {
    setSignalState("signaling connected", "signaling");
    log(`Connected to room: ${roomId}`);
  };

  socket.onmessage = async (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    try {
      if (message.type === "welcome") {
        state.selfPeerId = message.peerId;
        selfId.textContent = message.peerId.slice(0, 8);
        log(`Your peer id: ${message.peerId}. Peers in room: ${message.peers.length}`);

        if (message.peers.length > 0) {
          state.remotePeerId = message.peers[0];
          peerId.textContent = state.remotePeerId.slice(0, 8);
          await sendOffer();
        }
        return;
      }

      if (message.type === "peer-joined") {
        state.remotePeerId = message.peerId;
        peerId.textContent = message.peerId.slice(0, 8);
        log(`Peer joined: ${message.peerId}`);
        return;
      }

      if (message.type === "offer") {
        await handleOffer(message);
        return;
      }

      if (message.type === "answer") {
        await handleAnswer(message);
        return;
      }

      if (message.type === "candidate") {
        await handleCandidate(message);
        return;
      }

      if (message.type === "peer-left" || message.type === "bye") {
        log(`Peer left: ${message.peerId || message.from || "unknown"}`);
        cleanupPeerConnection();
        return;
      }

      if (message.type === "error") {
        log(`Server error: ${message.message}`);
      }
    } catch (error) {
      log(`Signaling handling failed: ${error.message}`);
    }
  };

  socket.onerror = () => {
    log("WebSocket transport error.");
  };

  socket.onclose = () => {
    const isManualDisconnect = state.manualDisconnect;
    state.manualDisconnect = false;
    const neverJoined = !state.selfPeerId;
    state.ws = null;
    cleanupPeerConnection();
    state.selfPeerId = null;
    selfId.textContent = "-";
    joinButton.disabled = false;
    leaveButton.disabled = true;

    if (isManualDisconnect) {
      return;
    }

    if (neverJoined) {
      log("Failed to join room (check room id and room capacity).");
    } else {
      log("Signaling disconnected.");
    }
  };
}

function initUi() {
  const roomFromHash = window.location.hash.replace("#", "").trim();
  roomIdInput.value = ROOM_ID_PATTERN.test(roomFromHash) ? roomFromHash : makeRoomId();
  setSignalState("offline", "offline");

  randomRoomButton.addEventListener("click", () => {
    roomIdInput.value = makeRoomId();
  });

  startMediaButton.addEventListener("click", async () => {
    try {
      await ensureLocalMedia();
    } catch (error) {
      log(`Cannot access camera/mic: ${error.message}`);
    }
  });

  joinButton.addEventListener("click", async () => {
    try {
      await joinRoom();
    } catch (error) {
      joinButton.disabled = false;
      leaveButton.disabled = true;
      log(`Join failed: ${error.message}`);
    }
  });

  leaveButton.addEventListener("click", () => {
    leaveRoom();
  });

  window.addEventListener("beforeunload", () => {
    closeSocketOnly();
    stopLocalMedia();
  });
}

initUi();
