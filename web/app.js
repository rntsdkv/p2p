const ROOM_ID_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;
const STATS_POLL_INTERVAL_MS = 1000;

const state = {
  ws: null,
  pc: null,
  localStream: null,
  remotePeerId: null,
  selfPeerId: null,
  iceServers: [],
  manualDisconnect: false,
  lastIcePathSummary: "",
  iceReportTimer: null,
  statsPollTimer: null,
  lastStatsSample: null,
  lastRuntimeRoute: ""
};

const roomIdInput = document.getElementById("roomId");
const randomRoomButton = document.getElementById("randomRoomButton");
const startMediaButton = document.getElementById("startMediaButton");
const joinButton = document.getElementById("joinButton");
const leaveButton = document.getElementById("leaveButton");
const signalState = document.getElementById("signalState");
const selfId = document.getElementById("selfId");
const peerId = document.getElementById("peerId");
const natRoute = document.getElementById("natRoute");
const trafficRate = document.getElementById("trafficRate");
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

function setRuntimeInfo(routeText, trafficText) {
  natRoute.textContent = routeText;
  trafficRate.textContent = trafficText;
}

function resetRuntimeInfo() {
  setRuntimeInfo("-", "-");
}

function normalizeCandidateType(value) {
  if (!value) {
    return "unknown";
  }
  return String(value).toLowerCase();
}

function parseCandidateLine(candidateLine) {
  if (!candidateLine || typeof candidateLine !== "string") {
    return { type: "unknown", protocol: "unknown" };
  }

  const parts = candidateLine.trim().split(/\s+/);
  const protocol = parts[2] ? parts[2].toLowerCase() : "unknown";
  const typeIndex = parts.indexOf("typ");
  const type = typeIndex > -1 && parts[typeIndex + 1] ? parts[typeIndex + 1].toLowerCase() : "unknown";
  return { type, protocol };
}

function getCandidateInfo(candidate) {
  if (!candidate) {
    return { type: "unknown", protocol: "unknown" };
  }

  const parsed = parseCandidateLine(candidate.candidate);
  return {
    type: normalizeCandidateType(candidate.type || parsed.type),
    protocol: normalizeCandidateType(candidate.protocol || parsed.protocol)
  };
}

function formatCandidateEndpoint(candidate) {
  const address = candidate?.address || candidate?.ip || candidate?.ipAddress || "hidden";
  const portRaw = candidate?.port ?? candidate?.candidatePort;
  const port = portRaw === undefined || portRaw === null ? "?" : String(portRaw);
  return `${address}:${port}`;
}

function classifyPath(localType, remoteType) {
  if (localType === "relay" || remoteType === "relay") {
    return "TURN relay path (media goes through relay server)";
  }

  if (
    ["srflx", "prflx"].includes(localType) ||
    ["srflx", "prflx"].includes(remoteType)
  ) {
    return "Direct P2P via NAT traversal (STUN/hole punching)";
  }

  if (localType === "host" && remoteType === "host") {
    return "Direct host-to-host path (same LAN/public reachability)";
  }

  return "ICE path established (candidate types are non-standard/unknown)";
}

function findSelectedCandidatePair(stats) {
  for (const report of stats.values()) {
    if (report.type === "transport" && report.selectedCandidatePairId) {
      const selected = stats.get(report.selectedCandidatePairId);
      if (selected) {
        return selected;
      }
    }
  }

  for (const report of stats.values()) {
    if (
      report.type === "candidate-pair" &&
      report.state === "succeeded" &&
      (report.selected || report.nominated)
    ) {
      return report;
    }
  }

  return null;
}

function buildPathSnapshot(stats, selectedPair) {
  if (!selectedPair) {
    return null;
  }

  const localCandidate = stats.get(selectedPair.localCandidateId);
  const remoteCandidate = stats.get(selectedPair.remoteCandidateId);
  const localType = normalizeCandidateType(localCandidate?.candidateType);
  const remoteType = normalizeCandidateType(remoteCandidate?.candidateType);
  const localProtocol = normalizeCandidateType(localCandidate?.protocol);
  const remoteProtocol = normalizeCandidateType(remoteCandidate?.protocol);
  const localEndpoint = formatCandidateEndpoint(localCandidate);
  const remoteEndpoint = formatCandidateEndpoint(remoteCandidate);

  return {
    localType,
    remoteType,
    localProtocol,
    remoteProtocol,
    compactSummary: `local=${localType}/${localProtocol}, remote=${remoteType}/${remoteProtocol}`,
    routeSummary: `${localType}/${localProtocol} ${localEndpoint} -> ${remoteType}/${remoteProtocol} ${remoteEndpoint}`
  };
}

function extractRtpTotals(stats) {
  let outPackets = 0;
  let inPackets = 0;
  let outBytes = 0;
  let inBytes = 0;

  for (const report of stats.values()) {
    if (report.type === "outbound-rtp" && !report.isRemote) {
      outPackets += Number(report.packetsSent || 0);
      outBytes += Number(report.bytesSent || 0);
      continue;
    }

    if (report.type === "inbound-rtp" && !report.isRemote) {
      inPackets += Number(report.packetsReceived || 0);
      inBytes += Number(report.bytesReceived || 0);
    }
  }

  return { outPackets, inPackets, outBytes, inBytes };
}

function formatBytesPerSecond(bytesPerSecond) {
  if (bytesPerSecond < 1024) {
    return `${Math.round(bytesPerSecond)} B/s`;
  }
  return `${(bytesPerSecond / 1024).toFixed(1)} KiB/s`;
}

function scheduleIcePathReport(pc, delayMs = 0) {
  if (state.iceReportTimer) {
    clearTimeout(state.iceReportTimer);
  }

  state.iceReportTimer = setTimeout(() => {
    void logSelectedIcePath(pc);
  }, delayMs);
}

async function logSelectedIcePath(pc) {
  if (!pc) {
    return;
  }

  try {
    const stats = await pc.getStats();
    const selectedPair = findSelectedCandidatePair(stats);
    const path = buildPathSnapshot(stats, selectedPair);

    if (!path) {
      log("ICE diagnostics: selected candidate pair not available yet.");
      return;
    }

    if (path.compactSummary === state.lastIcePathSummary) {
      return;
    }

    state.lastIcePathSummary = path.compactSummary;
    log(`ICE selected pair: ${path.compactSummary}`);
    log(`NAT traversal result: ${classifyPath(path.localType, path.remoteType)}`);
  } catch (error) {
    log(`ICE diagnostics failed: ${error.message}`);
  }
}

async function pollRuntimeDiagnostics(pc) {
  if (!pc || pc.connectionState === "closed") {
    return;
  }

  try {
    const stats = await pc.getStats();
    const selectedPair = findSelectedCandidatePair(stats);
    const path = buildPathSnapshot(stats, selectedPair);

    if (!path) {
      setRuntimeInfo("collecting selected pair...", "collecting RTP counters...");
      return;
    }

    if (path.routeSummary !== state.lastRuntimeRoute) {
      state.lastRuntimeRoute = path.routeSummary;
      log(`Runtime ICE route: ${path.routeSummary}`);
      log(`Runtime route class: ${classifyPath(path.localType, path.remoteType)}`);
    }

    const totals = extractRtpTotals(stats);
    const now = Date.now();
    let trafficText = "collecting RTP counters...";

    if (state.lastStatsSample && now > state.lastStatsSample.ts) {
      const dtSeconds = (now - state.lastStatsSample.ts) / 1000;
      const deltaOutPackets = Math.max(totals.outPackets - state.lastStatsSample.outPackets, 0);
      const deltaInPackets = Math.max(totals.inPackets - state.lastStatsSample.inPackets, 0);
      const deltaOutBytes = Math.max(totals.outBytes - state.lastStatsSample.outBytes, 0);
      const deltaInBytes = Math.max(totals.inBytes - state.lastStatsSample.inBytes, 0);

      const outPacketsPerSec = Math.round(deltaOutPackets / dtSeconds);
      const inPacketsPerSec = Math.round(deltaInPackets / dtSeconds);
      const outBytesPerSec = formatBytesPerSecond(deltaOutBytes / dtSeconds);
      const inBytesPerSec = formatBytesPerSecond(deltaInBytes / dtSeconds);
      trafficText = `out ${outPacketsPerSec} pkt/s (${outBytesPerSec}), in ${inPacketsPerSec} pkt/s (${inBytesPerSec})`;

      if (deltaOutPackets > 0 || deltaInPackets > 0) {
        log(`Runtime traffic: +${deltaOutPackets} out / +${deltaInPackets} in packets over ${dtSeconds.toFixed(1)}s`);
      }
    }

    state.lastStatsSample = { ...totals, ts: now };
    setRuntimeInfo(path.routeSummary, trafficText);
  } catch (error) {
    log(`Runtime diagnostics failed: ${error.message}`);
  }
}

function startRuntimeDiagnostics(pc) {
  if (!pc) {
    return;
  }

  if (state.statsPollTimer) {
    return;
  }

  state.lastStatsSample = null;
  state.lastRuntimeRoute = "";
  setRuntimeInfo("collecting selected pair...", "collecting RTP counters...");

  state.statsPollTimer = setInterval(() => {
    void pollRuntimeDiagnostics(pc);
  }, STATS_POLL_INTERVAL_MS);

  void pollRuntimeDiagnostics(pc);
}

function stopRuntimeDiagnostics() {
  if (state.statsPollTimer) {
    clearInterval(state.statsPollTimer);
    state.statsPollTimer = null;
  }

  state.lastStatsSample = null;
  state.lastRuntimeRoute = "";
  resetRuntimeInfo();
}

function resetPeerInfo() {
  state.remotePeerId = null;
  peerId.textContent = "-";
  remoteVideo.srcObject = null;
  state.lastIcePathSummary = "";
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
  stopRuntimeDiagnostics();

  if (state.iceReportTimer) {
    clearTimeout(state.iceReportTimer);
    state.iceReportTimer = null;
  }

  if (state.pc) {
    state.pc.ontrack = null;
    state.pc.onicecandidate = null;
    state.pc.oniceconnectionstatechange = null;
    state.pc.onicegatheringstatechange = null;
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
    if (!event.candidate) {
      log("ICE gathering completed.");
      return;
    }

    const candidateInfo = getCandidateInfo(event.candidate);
    log(`Local ICE candidate: ${candidateInfo.type}/${candidateInfo.protocol}`);

    if (!state.remotePeerId) {
      return;
    }

    sendSignal({
      type: "candidate",
      target: state.remotePeerId,
      candidate: event.candidate
    });
  };

  pc.onicegatheringstatechange = () => {
    log(`ICE gathering state: ${pc.iceGatheringState}`);
  };

  pc.oniceconnectionstatechange = () => {
    log(`ICE connection state: ${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      scheduleIcePathReport(pc, 250);
      startRuntimeDiagnostics(pc);
    }
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
      scheduleIcePathReport(pc, 1000);
      startRuntimeDiagnostics(pc);
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

  const candidateInfo = getCandidateInfo(message.candidate);
  log(`Remote ICE candidate: ${candidateInfo.type}/${candidateInfo.protocol}`);
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
  resetRuntimeInfo();

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
  resetRuntimeInfo();

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
    cleanupPeerConnection();
    stopLocalMedia();
  });
}

initUi();
