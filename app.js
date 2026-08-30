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

// --- Config PeerJS ---------------------------------------------------------
// Le STUN seul suffit quand les deux téléphones sont sur le même réseau Wi-Fi
// sans isolation. Dès qu'ils sont sur des réseaux différents (l'un en 4G, ou
// NAT symétrique), l'échange ICE échoue silencieusement sans TURN. Les
// identifiants TURN ci-dessous sont récupérés dynamiquement (compte gratuit
// Metered.ca, 20 Go/mois) : ils peuvent tourner/changer de région côté
// Metered, d'où la récupération via leur API plutôt qu'en dur.
const TURN_CREDENTIALS_URL = "https://bbfone.metered.live/api/v1/turn/credentials?apiKey=3dbf27d3321ef1e1721f91baa25c7877830a";
const STUN_FALLBACK = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:global.stun.twilio.com:3478" },
];

let iceServersPromise = null;

async function getIceServers() {
  if (!iceServersPromise) {
    iceServersPromise = fetch(TURN_CREDENTIALS_URL)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((turnServers) => [...STUN_FALLBACK, ...turnServers])
      .catch((err) => {
        console.warn("Identifiants TURN indisponibles, repli sur STUN seul :", err);
        return STUN_FALLBACK;
      });
  }
  return iceServersPromise;
}

function watchIceState(peerConnection, onFailed, onRecovered) {
  if (!peerConnection) return;
  peerConnection.addEventListener("iceconnectionstatechange", () => {
    const state = peerConnection.iceConnectionState;
    console.log("ICE state:", state);
    if (state === "failed") onFailed();
    else if ((state === "connected" || state === "completed") && onRecovered) onRecovered();
  });
}

function describeMediaError(err) {
  const name = err && err.name;
  const message = (err && err.message) || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    if (/dismiss/i.test(message)) {
      // Aucune popup n'a pu s'afficher : le blocage est au niveau de l'appli
      // (permission micro coupée pour le navigateur dans les réglages du
      // téléphone), pas un simple refus dans la page.
      return "Micro bloqué par le téléphone — vérifiez le réglage Microphone du navigateur dans les réglages du téléphone";
    }
    return "Micro refusé — rechargez la page pour réautoriser, ou vérifiez les réglages du site";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "Aucun micro détecté sur cet appareil";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Micro déjà utilisé par une autre application";
  }
  if (name === "SecurityError") {
    return "Accès micro bloqué (page non sécurisée)";
  }
  if (name === "OverconstrainedError") {
    return "Réglages micro non supportés par cet appareil";
  }
  return "Erreur micro : " + (name || err);
}

async function getMicStream() {
  const attempts = [
    { audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1 }, video: false },
    { audio: true, video: false },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.error("getUserMedia a échoué avec", constraints, err);
      lastErr = err;
      // Un refus/dismiss de permission ne se résoudra pas en réessayant avec
      // d'autres contraintes : ça ne ferait qu'enchaîner les popups.
      if (err && err.name === "NotAllowedError") break;
    }
  }
  throw lastErr;
}

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

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setMicStatus("Micro non supporté par ce navigateur", "error");
    return;
  }

  try {
    micState.stream = await getMicStream();
  } catch (err) {
    setMicStatus(describeMediaError(err), "error");
    return;
  }

  requestWakeLock();
  setMicStatus("Connexion au service…", "pending");
  connectMicPeer();
}

async function connectMicPeer(attempt = 0) {
  const iceServers = await getIceServers();
  const code = randomCode();
  const peer = new Peer(PEER_ID_PREFIX + code, { config: { iceServers } });
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

    watchIceState(
      call.peerConnection,
      () => setMicStatus("Connexion réseau perdue avec le parent", "error"),
      () => setMicStatus("Connecté", "connected")
    );

    micPairingEl.hidden = true;
    micLiveEl.hidden = false;
    micStopBtn.hidden = false;
    // "Connecté" n'est confirmé que par watchIceState ci-dessus : recevoir
    // l'appel ne veut pas dire que l'audio circule déjà (ICE peut échouer).
    setMicStatus("Connexion en cours…", "pending");
    if (micState.stopMeter) micState.stopMeter();
    micState.stopMeter = attachLevelMeter(micState.stream, micLevelEl);

    setTimeout(() => {
      const state = call.peerConnection && call.peerConnection.iceConnectionState;
      if (state !== "connected" && state !== "completed") {
        setMicStatus("Ça prend du temps… vérifiez le réseau des deux téléphones", "pending");
      }
    }, 12000);
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

async function connectToMic(code) {
  parentState.lastCode = code;
  setParentStatus("Connexion…", "pending");
  const iceServers = await getIceServers();
  const peer = new Peer({ config: { iceServers } });
  parentState.peer = peer;

  peer.on("open", () => {
    // Flux local vide : ce téléphone ne fait qu'écouter, il n'envoie aucun audio.
    const call = peer.call(PEER_ID_PREFIX + code, new MediaStream());
    parentState.call = call;

    const connectTimeout = setTimeout(() => {
      if (!parentState.active) {
        setParentStatus("Ça prend du temps… vérifiez que les deux téléphones sont sur le même Wi-Fi", "pending");
      }
    }, 12000);

    watchIceState(
      call.peerConnection,
      () => setParentStatus("Connexion réseau impossible entre ces deux téléphones", "error"),
      () => { if (parentState.active) setParentStatus("Connecté", "connected"); }
    );

    call.on("stream", (remoteStream) => {
      clearTimeout(connectTimeout);
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
      clearTimeout(connectTimeout);
      parentState.active = false;
      setParentStatus("Déconnecté", "error");
      parentLiveEl.hidden = true;
      parentConnectEl.hidden = false;
    });

    call.on("error", (err) => {
      clearTimeout(connectTimeout);
      console.error("Erreur d'appel :", err);
      setParentStatus("Erreur d'appel : " + (err.message || err.type || err), "error");
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
