"use strict";

// --- Navigation entre écrans ---------------------------------------------

const views = {
  home: document.getElementById("view-home"),
  mic: document.getElementById("view-mic"),
  parent: document.getElementById("view-parent"),
};

function showView(name) {
  for (const key in views) views[key].hidden = key !== name;
}

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => {
    teardownMic();
    teardownParent();
    showView("home");
  });
});

document.getElementById("btn-role-mic").addEventListener("click", startMicRole);
document.getElementById("btn-role-parent").addEventListener("click", () => {
  showView("parent");
});

// --- Wake Lock : empêche l'écran de s'éteindre pendant la surveillance ---

let wakeLock = null;

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch (err) {
    // Le wake lock est refusé sur certains navigateurs/contextes : non bloquant.
    console.warn("Wake lock indisponible :", err);
  }
}

function releaseWakeLock() {
  if (wakeLock) {
    wakeLock.release().catch(() => {});
    wakeLock = null;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (micState.active || parentState.active)) {
    requestWakeLock();
  }
});

// --- Config PeerJS (STUN publics ; ajoute un TURN pour les réseaux restrictifs) ---

const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:global.stun.twilio.com:3478" },
    ],
  },
};

const PEER_ID_PREFIX = "babyphone-";

function randomCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function shortLevelMeter(analyser, dataArray, dotEl) {
  analyser.getByteTimeDomainData(dataArray);
  let sum = 0;
  for (let i = 0; i < dataArray.length; i++) {
    const v = (dataArray[i] - 128) / 128;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / dataArray.length);
  const scale = Math.min(1, rms * 6);
  dotEl.style.boxShadow = `0 0 0 ${scale * 24}px rgba(124,157,255,${0.35 * scale})`;
  dotEl.style.transform = `scale(${1 + scale * 0.12})`;
}

function attachLevelMeter(stream, dotEl) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const dataArray = new Uint8Array(analyser.fftSize);
  let rafId;
  function loop() {
    shortLevelMeter(analyser, dataArray, dotEl);
    rafId = requestAnimationFrame(loop);
  }
  loop();
  return () => {
    cancelAnimationFrame(rafId);
    ctx.close().catch(() => {});
  };
}

// --- Rôle Micro (chambre bébé) -------------------------------------------

const micState = { peer: null, call: null, stream: null, active: false, stopMeter: null };

const micStatusEl = document.getElementById("mic-status");
const micPairingEl = document.getElementById("mic-pairing");
const micCodeEl = document.getElementById("mic-code");
const micQrEl = document.getElementById("mic-qr");
const micLiveEl = document.getElementById("mic-live");
const micLevelEl = document.getElementById("mic-level");
const micStopBtn = document.getElementById("mic-stop");

function setMicStatus(text, kind) {
  micStatusEl.textContent = text;
  micStatusEl.className = "status-pill status-" + kind;
}

async function startMicRole() {
  showView("mic");
  micPairingEl.hidden = true;
  micLiveEl.hidden = true;
  micStopBtn.hidden = true;
  setMicStatus("Demande d'accès au micro…", "pending");

  try {
    micState.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
  } catch (err) {
    setMicStatus("Micro refusé ou indisponible", "error");
    return;
  }

  requestWakeLock();
  setMicStatus("Connexion au service…", "pending");
  connectMicPeer();
}

function connectMicPeer(attempt = 0) {
  const code = randomCode();
  const peer = new Peer(PEER_ID_PREFIX + code, PEER_CONFIG);
  micState.peer = peer;

  peer.on("open", () => {
    micCodeEl.textContent = code;
    renderQr(micQrEl, `${location.origin}${location.pathname}?role=parent&code=${code}`);
    micPairingEl.hidden = false;
    setMicStatus("En attente du parent…", "pending");
  });

  peer.on("call", (call) => {
    call.answer(micState.stream);
    micState.call = call;
    micState.active = true;

    call.on("stream", () => {}); // sens unique : aucun flux entrant attendu

    call.on("close", () => {
      micState.active = false;
      micPairingEl.hidden = false;
      micLiveEl.hidden = true;
      micStopBtn.hidden = true;
      setMicStatus("Parent déconnecté — en attente…", "pending");
    });

    micPairingEl.hidden = true;
    micLiveEl.hidden = false;
    micStopBtn.hidden = false;
    setMicStatus("Connecté", "connected");
    if (micState.stopMeter) micState.stopMeter();
    micState.stopMeter = attachLevelMeter(micState.stream, micLevelEl);
  });

  peer.on("error", (err) => {
    if (err.type === "unavailable-id" && attempt < 5) {
      peer.destroy();
      connectMicPeer(attempt + 1);
      return;
    }
    setMicStatus("Erreur de connexion : " + err.type, "error");
  });

  peer.on("disconnected", () => {
    if (micState.active) return;
    setMicStatus("Connexion perdue, nouvelle tentative…", "pending");
    peer.reconnect();
  });
}

micStopBtn.addEventListener("click", () => {
  teardownMic();
  showView("home");
});

function teardownMic() {
  if (micState.stopMeter) micState.stopMeter();
  if (micState.call) micState.call.close();
  if (micState.peer) micState.peer.destroy();
  if (micState.stream) micState.stream.getTracks().forEach((t) => t.stop());
  micState.peer = null;
  micState.call = null;
  micState.stream = null;
  micState.active = false;
  micState.stopMeter = null;
  releaseWakeLock();
}

function renderQr(container, text) {
  container.innerHTML = "";
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  container.innerHTML = qr.createImgTag(5, 8);
}

// --- Rôle Parent (écoute) --------------------------------------------------

const parentState = { peer: null, call: null, active: false, lastCode: null, stopMeter: null };

const parentConnectEl = document.getElementById("parent-connect");
const parentCodeInput = document.getElementById("parent-code-input");
const parentConnectBtn = document.getElementById("parent-connect-btn");
const parentStatusEl = document.getElementById("parent-status");
const parentLiveEl = document.getElementById("parent-live");
const parentLevelEl = document.getElementById("parent-level");
const parentVolumeInput = document.getElementById("parent-volume");
const parentEnableAudioBtn = document.getElementById("parent-enable-audio");
const parentHangupBtn = document.getElementById("parent-hangup");
const remoteAudio = document.getElementById("remote-audio");

function setParentStatus(text, kind) {
  parentStatusEl.hidden = false;
  parentStatusEl.textContent = text;
  parentStatusEl.className = "status-pill status-" + kind;
}

// Pré-remplit le code si on arrive via le lien/QR généré côté micro.
const urlParams = new URLSearchParams(location.search);
if (urlParams.get("role") === "parent") {
  showView("parent");
  if (urlParams.get("code")) parentCodeInput.value = urlParams.get("code");
}

parentConnectBtn.addEventListener("click", () => {
  const code = parentCodeInput.value.trim();
  if (!/^\d{4}$/.test(code)) {
    setParentStatus("Entrez un code à 4 chiffres", "error");
    return;
  }
  connectToMic(code);
});

function connectToMic(code) {
  parentState.lastCode = code;
  setParentStatus("Connexion…", "pending");
  const peer = new Peer(PEER_CONFIG);
  parentState.peer = peer;

  peer.on("open", () => {
    // Flux local vide : ce téléphone ne fait qu'écouter, il n'envoie aucun audio.
    const call = peer.call(PEER_ID_PREFIX + code, new MediaStream());
    parentState.call = call;

    call.on("stream", (remoteStream) => {
      remoteAudio.srcObject = remoteStream;
      remoteAudio.volume = Number(parentVolumeInput.value);
      const playPromise = remoteAudio.play();
      if (playPromise) {
        playPromise.catch(() => {
          parentEnableAudioBtn.hidden = false;
        });
      }

      parentState.active = true;
      requestWakeLock();
      parentConnectEl.hidden = true;
      parentLiveEl.hidden = false;
      setParentStatus("Connecté", "connected");
      if (parentState.stopMeter) parentState.stopMeter();
      parentState.stopMeter = attachLevelMeter(remoteStream, parentLevelEl);
    });

    call.on("close", () => {
      parentState.active = false;
      setParentStatus("Déconnecté", "error");
      parentLiveEl.hidden = true;
      parentConnectEl.hidden = false;
    });

    call.on("error", () => {
      setParentStatus("Erreur d'appel", "error");
    });
  });

  peer.on("error", (err) => {
    if (err.type === "peer-unavailable") {
      setParentStatus("Code introuvable — vérifiez-le", "error");
    } else {
      setParentStatus("Erreur de connexion : " + err.type, "error");
    }
  });
}

parentEnableAudioBtn.addEventListener("click", () => {
  remoteAudio.play().then(() => {
    parentEnableAudioBtn.hidden = true;
  });
});

parentVolumeInput.addEventListener("input", () => {
  remoteAudio.volume = Number(parentVolumeInput.value);
});

parentHangupBtn.addEventListener("click", () => {
  teardownParent();
  parentConnectEl.hidden = false;
  parentLiveEl.hidden = true;
  parentStatusEl.hidden = true;
});

function teardownParent() {
  if (parentState.stopMeter) parentState.stopMeter();
  if (parentState.call) parentState.call.close();
  if (parentState.peer) parentState.peer.destroy();
  remoteAudio.srcObject = null;
  parentState.peer = null;
  parentState.call = null;
  parentState.active = false;
  parentState.stopMeter = null;
  releaseWakeLock();
}
