"use strict";

// Sert à vérifier qu'un téléphone tourne bien la dernière version déployée
// (utile pour exclure un cache navigateur obsolète en cas de bug).
const BUILD_ID = "v7-noise-alerts-selftest";
const buildTagEl = document.getElementById("build-tag");
if (buildTagEl) buildTagEl.textContent = "build " + BUILD_ID;

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
  // Le parent doit savoir tout de suite si la page de la chambre passe en
  // arrière-plan (la capture micro risque d'être coupée par l'OS).
  if (micState.stream) sendHeartbeat();
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

// --- Mesure du niveau sonore ----------------------------------------------

// Échelle affichée : -70 dBFS (chambre silencieuse) → 0, -10 dBFS (cris
// tout près du micro) → 1.
const DB_FLOOR = -70;
const DB_CEIL = -10;
// Un vrai micro capte toujours un léger souffle : en dessous de ce seuil ce
// n'est plus "le calme" mais un signal numériquement nul, donc un micro coupé.
const DIGITAL_SILENCE_DB = -100;
const DIGITAL_SILENCE_ALARM_S = 20;

const HEARTBEAT_MS = 2000;
const HEARTBEAT_STALE_MS = 8000;
const AUDIO_STALL_MS = 5000;
const ALARM_REMINDER_MS = 60000;
const NOISE_HOLD_MS = 1500;
const VIBRATE_COOLDOWN_MS = 15000;
const HISTORY_SECONDS = 300;

// Bip de test injecté directement dans le flux envoyé : il n'est jamais
// joué par le haut-parleur du téléphone de la chambre.
const TEST_TONE_HZ = 1200;
const TEST_TONE_MS = 700;
const TEST_TIMEOUT_MS = 5000;

function newAudioContext() {
  return new (window.AudioContext || window.webkitAudioContext)();
}

function createLevelMeter(ctx, stream) {
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const bytes = new Uint8Array(analyser.fftSize);
  const spectrum = new Float32Array(analyser.frequencyBinCount);
  return {
    source,
    analyser,
    readDb() {
      let sum = 0;
      if (analyser.getFloatTimeDomainData) {
        analyser.getFloatTimeDomainData(samples);
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
      } else {
        analyser.getByteTimeDomainData(bytes);
        for (let i = 0; i < bytes.length; i++) {
          const v = (bytes[i] - 128) / 128;
          sum += v * v;
        }
      }
      const rms = Math.sqrt(sum / analyser.fftSize);
      return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    },
    readSpectrum() {
      analyser.getFloatFrequencyData(spectrum);
      return spectrum;
    },
    stop() {
      source.disconnect();
    },
  };
}

function dbToLevel(db) {
  return Math.min(1, Math.max(0, (db - DB_FLOOR) / (DB_CEIL - DB_FLOOR)));
}

function formatDb(db) {
  return db == null || !isFinite(db) ? "silence total" : Math.round(db) + " dB";
}

function renderDot(dotEl, level, noisy) {
  const rgb = noisy ? "255,140,60" : "124,157,255";
  dotEl.style.boxShadow = `0 0 0 ${level * (noisy ? 44 : 24)}px rgba(${rgb},${0.2 + 0.4 * level})`;
  dotEl.style.transform = `scale(${1 + level * (noisy ? 0.3 : 0.12)})`;
}

// --- Rôle Micro (chambre bébé) -------------------------------------------

const micState = {
  peer: null, call: null, conn: null, stream: null, active: false,
  audioCtx: null, meter: null, dotRaf: null, hbTimer: null, battery: null, testing: false,
};

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

  startMicMonitoring();
  requestWakeLock();
  setMicStatus("Connexion au service…", "pending");
  connectMicPeer();
}

function startMicMonitoring() {
  micState.audioCtx = newAudioContext();
  micState.audioCtx.resume().catch(() => {});
  micState.meter = createLevelMeter(micState.audioCtx, micState.stream);

  const loop = () => {
    renderDot(micLevelEl, dbToLevel(micState.meter.readDb()), false);
    micState.dotRaf = requestAnimationFrame(loop);
  };
  loop();

  micState.hbTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  const track = micState.stream.getAudioTracks()[0];
  if (track) {
    // L'OS peut couper le micro sans prévenir (appel entrant, appli en
    // arrière-plan…) : on le signale au parent dès que ça arrive.
    ["mute", "unmute", "ended"].forEach((evt) => track.addEventListener(evt, sendHeartbeat));
  }
  if (navigator.getBattery) {
    navigator.getBattery().then((battery) => { micState.battery = battery; }).catch(() => {});
  }
}

function micHealthSnapshot() {
  const track = micState.stream && micState.stream.getAudioTracks()[0];
  const db = micState.meter ? micState.meter.readDb() : -Infinity;
  return {
    micDb: isFinite(db) ? Math.round(db) : null,
    trackLive: !!track && track.readyState === "live",
    trackMuted: !!track && track.muted,
    hidden: document.visibilityState === "hidden",
    battery: micState.battery ? { level: micState.battery.level, charging: micState.battery.charging } : null,
  };
}

function sendToParent(msg) {
  if (micState.conn && micState.conn.open) micState.conn.send(msg);
}

function sendHeartbeat() {
  sendToParent({ type: "hb", ...micHealthSnapshot() });
}

function handleMicMessage(msg) {
  if (!msg || msg.type !== "test") return;
  sendToParent({ type: "test-ack", id: msg.id, ...micHealthSnapshot() });
  injectTestTone()
    .then(() => sendToParent({ type: "test-done", id: msg.id, ok: true }))
    .catch((err) => {
      console.error("Bip de test impossible :", err);
      sendToParent({ type: "test-done", id: msg.id, ok: false, error: String((err && err.message) || err) });
    });
}

// Remplace brièvement la piste envoyée par "micro + bip" (replaceTrack, sans
// renégociation), puis remet la piste micro d'origine. Rien n'est relié à
// audioCtx.destination : le bip n'existe que dans le flux réseau, la chambre
// reste silencieuse. Le flux normal ne passe jamais par Web Audio, pour ne
// pas ajouter de point de panne à l'écoute elle-même.
async function injectTestTone() {
  if (micState.testing) throw new Error("test déjà en cours");
  const pc = micState.call && micState.call.peerConnection;
  const sender = pc && pc.getSenders().find((s) => s.track && s.track.kind === "audio");
  if (!sender) throw new Error("pas d'appel audio en cours");

  micState.testing = true;
  const ctx = micState.audioCtx;
  const roomSource = micState.meter.source;
  const originalTrack = sender.track;
  const dest = ctx.createMediaStreamDestination();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  try {
    if (ctx.state !== "running") await ctx.resume();
    roomSource.connect(dest); // garde le son de la chambre pendant le test
    osc.frequency.value = TEST_TONE_HZ;
    osc.connect(gain).connect(dest);
    await sender.replaceTrack(dest.stream.getAudioTracks()[0]);

    const t0 = ctx.currentTime + 0.03;
    const t1 = t0 + TEST_TONE_MS / 1000;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.25, t0 + 0.02);
    gain.gain.setValueAtTime(0.25, t1 - 0.02);
    gain.gain.linearRampToValueAtTime(0, t1);
    osc.start(t0);
    osc.stop(t1 + 0.05);
    await new Promise((resolve) => setTimeout(resolve, TEST_TONE_MS + 250));
  } finally {
    await sender.replaceTrack(originalTrack).catch((err) => console.error("Restauration de la piste micro :", err));
    osc.disconnect();
    gain.disconnect();
    try { roomSource.disconnect(dest); } catch (err) { /* déjà déconnecté */ }
    micState.testing = false;
  }
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

  // Le parent ouvre juste une connexion de signalisation légère pour se faire
  // connaître ; c'est le micro qui rappelle avec son flux réel dès le départ.
  // (Faire l'inverse — appeler avec un flux vide puis l'ajouter après coup
  // côté micro — oblige à une renégociation SDP en cours d'appel que PeerJS
  // ne relaie pas de façon fiable : un côté voit "connecté", l'autre jamais.)
  // Cette connexion sert ensuite à envoyer l'état du micro au parent et à
  // recevoir ses demandes de test.
  peer.on("connection", (conn) => {
    micState.conn = conn;
    conn.on("data", handleMicMessage);

    const startCall = () => {
      sendHeartbeat();
      const call = peer.call(conn.peer, micState.stream);
      micState.call = call;
      micState.active = true;

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
      // "Connecté" n'est confirmé que par watchIceState ci-dessus.
      setMicStatus("Connexion en cours…", "pending");

      setTimeout(() => {
        const state = call.peerConnection && call.peerConnection.iceConnectionState;
        if (state !== "connected" && state !== "completed") {
          setMicStatus("Ça prend du temps… vérifiez le réseau des deux téléphones", "pending");
        }
      }, 12000);
    };

    if (conn.open) startCall();
    else conn.on("open", startCall);
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
  cancelAnimationFrame(micState.dotRaf);
  clearInterval(micState.hbTimer);
  if (micState.meter) micState.meter.stop();
  if (micState.audioCtx) micState.audioCtx.close().catch(() => {});
  if (micState.call) micState.call.close();
  if (micState.peer) micState.peer.destroy();
  if (micState.stream) micState.stream.getTracks().forEach((t) => t.stop());
  micState.peer = null;
  micState.call = null;
  micState.conn = null;
  micState.stream = null;
  micState.active = false;
  micState.audioCtx = null;
  micState.meter = null;
  micState.dotRaf = null;
  micState.hbTimer = null;
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

const parentState = {
  peer: null, call: null, pairConn: null, active: false, lastCode: null,
  audioCtx: null, meter: null, tickTimer: null,
  noise: null, second: null, history: [], ambientDb: -Infinity, lastHealthAt: 0,
  lastHb: null, lastHbAt: 0, lastPackets: null, audioOkAt: 0, silentSeconds: 0,
  test: null, suppressNoiseUntil: 0, alarm: null, alarmNotifiedAt: 0,
};

const parentConnectEl = document.getElementById("parent-connect");
const parentCodeInput = document.getElementById("parent-code-input");
const parentConnectBtn = document.getElementById("parent-connect-btn");
const parentStatusEl = document.getElementById("parent-status");
const parentAlarmEl = document.getElementById("parent-alarm");
const parentLiveEl = document.getElementById("parent-live");
const parentLevelEl = document.getElementById("parent-level");
const parentVolumeInput = document.getElementById("parent-volume");
const parentSensitivityInput = document.getElementById("parent-sensitivity");
const parentEnableAudioBtn = document.getElementById("parent-enable-audio");
const parentHangupBtn = document.getElementById("parent-hangup");
const parentTestBtn = document.getElementById("parent-test");
const testResultEl = document.getElementById("test-result");
const noiseLabelEl = document.getElementById("noise-label");
const noiseLastEl = document.getElementById("noise-last");
const meterFillEl = document.getElementById("meter-fill");
const meterThresholdEl = document.getElementById("meter-threshold");
const historyCanvas = document.getElementById("noise-history");
const healthEls = {
  mic: document.getElementById("health-mic"),
  audio: document.getElementById("health-audio"),
  speaker: document.getElementById("health-speaker"),
  battery: document.getElementById("health-battery"),
};
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

// L'AudioContext doit naître pendant un geste de l'utilisateur, sinon iOS le
// laisse suspendu et l'analyse du niveau sonore reste muette.
function ensureParentAudioCtx() {
  if (!parentState.audioCtx || parentState.audioCtx.state === "closed") {
    parentState.audioCtx = newAudioContext();
  }
  parentState.audioCtx.resume().catch(() => {});
  return parentState.audioCtx;
}

document.addEventListener("pointerdown", () => {
  if (parentState.audioCtx && parentState.audioCtx.state === "suspended") {
    parentState.audioCtx.resume().catch(() => {});
  }
});

parentConnectBtn.addEventListener("click", () => {
  const code = parentCodeInput.value.trim();
  if (!/^\d{4}$/.test(code)) {
    setParentStatus("Entrez un code à 4 chiffres", "error");
    return;
  }
  ensureParentAudioCtx();
  connectToMic(code);
});

async function connectToMic(code) {
  parentState.lastCode = code;
  parentState.lastHb = null;
  parentState.lastHbAt = 0;
  clearAlarm();
  testResultEl.hidden = true;
  // Une reconnexion après coupure : on libère l'ancien pair sans que sa
  // fermeture ne déclenche l'alarme "liaison perdue".
  parentState.call = null;
  if (parentState.peer) parentState.peer.destroy();

  setParentStatus("Connexion…", "pending");
  const iceServers = await getIceServers();
  const peer = new Peer({ config: { iceServers } });
  parentState.peer = peer;

  peer.on("open", () => {
    // Signale juste notre présence au micro ; c'est lui qui nous rappellera
    // avec son flux audio réel (voir le commentaire côté micro).
    parentState.pairConn = peer.connect(PEER_ID_PREFIX + code, { reliable: true });
    parentState.pairConn.on("data", handleParentMessage);
  });

  peer.on("call", (call) => {
    call.answer(); // ce téléphone n'envoie aucun audio, il écoute seulement
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
      startParentMonitoring(remoteStream);
    });

    call.on("close", () => {
      clearTimeout(connectTimeout);
      if (parentState.call !== call) return; // fermeture volontaire
      parentState.active = false;
      stopParentMonitoring();
      setParentStatus("Déconnecté", "error");
      parentLiveEl.hidden = true;
      parentConnectEl.hidden = false;
      raiseAlarm("Liaison perdue avec la chambre — reconnectez-vous");
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

function handleParentMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const test = parentState.test;
  if (msg.type === "hb" || msg.type === "test-ack") {
    parentState.lastHb = msg;
    parentState.lastHbAt = performance.now();
  }
  if (!test || msg.id !== test.id) return;
  if (msg.type === "test-ack") {
    test.ack = msg;
    if (test.detectedAt) finishSelfTest();
  } else if (msg.type === "test-done" && !msg.ok) {
    test.toneError = msg.error;
  }
}

// --- Parent : détection et affichage du bruit -------------------------------

const SENSITIVITY_KEY = "babyphone-sensitivity";
try {
  const saved = localStorage.getItem(SENSITIVITY_KEY);
  if (saved != null) parentSensitivityInput.value = saved;
} catch (err) { /* stockage indisponible : valeur par défaut */ }

// Plus la sensibilité est haute, plus le seuil de déclenchement est bas.
function noiseThreshold() {
  return 0.85 - (Number(parentSensitivityInput.value) / 100) * 0.7;
}

function updateThresholdMarker() {
  meterThresholdEl.style.left = (noiseThreshold() * 100).toFixed(1) + "%";
}
updateThresholdMarker();

parentSensitivityInput.addEventListener("input", () => {
  try { localStorage.setItem(SENSITIVITY_KEY, parentSensitivityInput.value); } catch (err) { /* ignoré */ }
  updateThresholdMarker();
  drawHistory();
});

function startParentMonitoring(remoteStream) {
  stopParentMonitoring();
  const now = performance.now();
  parentState.meter = createLevelMeter(ensureParentAudioCtx(), remoteStream);
  parentState.noise = { smooth: 0, active: false, lastAboveAt: 0, lastNoiseAt: 0, lastNoiseClock: null, count: 0, lastVibrateAt: 0 };
  parentState.second = { start: now, peak: 0, power: 0, frames: 0 };
  parentState.history = [];
  parentState.ambientDb = -Infinity;
  parentState.lastHealthAt = now;
  parentState.lastPackets = null;
  parentState.audioOkAt = now;
  parentState.silentSeconds = 0;
  renderNoiseText(now);
  // setInterval plutôt que requestAnimationFrame : la détection continue
  // (au ralenti) même si l'écran passe en arrière-plan.
  parentState.tickTimer = setInterval(parentTick, 50);
}

function stopParentMonitoring() {
  clearInterval(parentState.tickTimer);
  parentState.tickTimer = null;
  if (parentState.meter) parentState.meter.stop();
  parentState.meter = null;
  if (parentState.test) {
    clearTimeout(parentState.test.timer);
    parentState.test = null;
    parentTestBtn.disabled = false;
  }
  document.documentElement.style.setProperty("--noise", "0");
  document.body.classList.remove("noisy");
}

function parentTick() {
  if (!parentState.meter) return;
  const now = performance.now();
  const db = parentState.meter.readDb();
  const level = dbToLevel(db);

  const sec = parentState.second;
  sec.peak = Math.max(sec.peak, level);
  sec.power += isFinite(db) ? Math.pow(10, db / 10) : 0;
  sec.frames++;

  if (parentState.test) detectTestTone(now);
  updateNoise(level, now);
  renderNoise(now);

  if (now - sec.start >= 1000) {
    onParentSecond(now);
    parentState.second = { start: now, peak: 0, power: 0, frames: 0 };
  }
}

function updateNoise(level, now) {
  const n = parentState.noise;
  n.smooth = Math.max(level, n.smooth * 0.85);
  // Le bip de test n'est pas un bruit de la chambre.
  const suppressed = parentState.test || now < parentState.suppressNoiseUntil;
  if (!suppressed && level >= noiseThreshold()) {
    n.lastAboveAt = now;
    n.lastNoiseAt = now;
    n.lastNoiseClock = new Date();
    if (!n.active) {
      n.active = true;
      n.count++;
      if (navigator.vibrate && now - n.lastVibrateAt > VIBRATE_COOLDOWN_MS) {
        n.lastVibrateAt = now;
        navigator.vibrate([150, 100, 150]);
      }
    }
  } else if (n.active && now - n.lastAboveAt > NOISE_HOLD_MS) {
    n.active = false;
  }
}

function renderNoise(now) {
  const n = parentState.noise;
  const threshold = noiseThreshold();
  const over = Math.min(1, Math.max(0, (n.smooth - threshold) / Math.max(0.1, 1 - threshold)));
  const glow = n.active ? 0.45 + 0.55 * over : 0;
  document.documentElement.style.setProperty("--noise", glow.toFixed(3));
  if (document.body.classList.contains("noisy") !== n.active) {
    document.body.classList.toggle("noisy", n.active);
    renderNoiseText(now);
  }
  meterFillEl.style.width = (n.smooth * 100).toFixed(1) + "%";
  renderDot(parentLevelEl, n.smooth, n.active);
}

function formatAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  return `il y a ${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function formatClock(date) {
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function renderNoiseText(now) {
  const n = parentState.noise;
  if (n.active) noiseLabelEl.textContent = "🔊 Bruit dans la chambre";
  else if (!isFinite(parentState.ambientDb)) noiseLabelEl.textContent = "Silence total reçu";
  else noiseLabelEl.textContent = `Calme · bruit de fond ${formatDb(parentState.ambientDb)}`;
  noiseLastEl.textContent = n.lastNoiseAt
    ? `Dernier bruit à ${formatClock(n.lastNoiseClock)} (${formatAgo(now - n.lastNoiseAt)}) · ${n.count} depuis la connexion`
    : "Aucun bruit depuis la connexion";
}

function onParentSecond(now) {
  const sec = parentState.second;
  const avgDb = sec.frames ? 10 * Math.log10(sec.power / sec.frames) : -Infinity;
  parentState.ambientDb = avgDb;
  parentState.silentSeconds = avgDb < DIGITAL_SILENCE_DB ? parentState.silentSeconds + 1 : 0;
  parentState.history.push(sec.peak);
  if (parentState.history.length > HISTORY_SECONDS) parentState.history.shift();
  drawHistory();
  renderNoiseText(now);
  if (now - parentState.lastHealthAt >= 2000) {
    parentState.lastHealthAt = now;
    checkHealth(now);
  }
}

function drawHistory() {
  const w = historyCanvas.clientWidth;
  const h = historyCanvas.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (historyCanvas.width !== Math.round(w * dpr)) {
    historyCanvas.width = Math.round(w * dpr);
    historyCanvas.height = Math.round(h * dpr);
  }
  const g = historyCanvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const threshold = noiseThreshold();
  const barW = w / HISTORY_SECONDS;
  const history = parentState.history;
  for (let i = 0; i < history.length; i++) {
    const level = history[i];
    const x = w - (history.length - i) * barW;
    const barH = Math.max(1, level * h);
    g.fillStyle = level >= threshold ? "#ff8c3c" : "rgba(124,157,255,0.55)";
    g.fillRect(x, h - barH, Math.max(1, barW), barH);
  }

  g.strokeStyle = "rgba(238,240,247,0.5)";
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(0, h - threshold * h);
  g.lineTo(w, h - threshold * h);
  g.stroke();
  g.setLineDash([]);
}

// --- Parent : santé du système ------------------------------------------------
// Un écran calme ne doit pas pouvoir cacher une panne : on vérifie en continu
// que des paquets audio arrivent, que le micro de la chambre est actif
// (signalé par la chambre toutes les 2 s) et que le son est bien audible ici.

function setChip(el, state, label) {
  el.dataset.state = state;
  el.textContent = label;
}

async function checkHealth(now) {
  const call = parentState.call;
  const pc = call && call.peerConnection;
  if (pc) {
    try {
      const stats = await pc.getStats();
      stats.forEach((report) => {
        if (report.type !== "inbound-rtp" || (report.kind || report.mediaType) !== "audio") return;
        if (parentState.lastPackets != null && report.packetsReceived > parentState.lastPackets) {
          parentState.audioOkAt = now;
        }
        parentState.lastPackets = report.packetsReceived;
      });
    } catch (err) {
      console.warn("getStats a échoué :", err);
    }
  }
  if (parentState.call !== call || !parentState.meter) return; // déconnecté entre-temps

  const problems = [];

  if (now - parentState.audioOkAt > AUDIO_STALL_MS) {
    setChip(healthEls.audio, "bad", "📶 Audio coupé");
    problems.push("Le son de la chambre n'arrive plus");
  } else if (parentState.silentSeconds >= DIGITAL_SILENCE_ALARM_S) {
    setChip(healthEls.audio, "bad", "📶 Silence total");
    problems.push("Silence total reçu : le micro de la chambre semble coupé");
  } else {
    setChip(healthEls.audio, "ok", "📶 Audio reçu");
  }

  const hb = parentState.lastHb;
  if (!hb) {
    setChip(healthEls.mic, "unknown", "🎙️ Micro ?");
  } else if (!hb.trackLive || hb.trackMuted) {
    setChip(healthEls.mic, "bad", "🎙️ Micro coupé");
    problems.push("Le micro de la chambre est coupé (écran verrouillé, appel en cours ou appli en arrière-plan ?)");
  } else if (now - parentState.lastHbAt > HEARTBEAT_STALE_MS) {
    setChip(healthEls.mic, "warn", "🎙️ Sans nouvelles");
  } else if (hb.hidden) {
    setChip(healthEls.mic, "warn", "🎙️ Arrière-plan");
  } else {
    setChip(healthEls.mic, "ok", "🎙️ Micro actif");
  }

  if (remoteAudio.paused) {
    setChip(healthEls.speaker, "warn", "🔊 Son bloqué");
  } else if (remoteAudio.muted || remoteAudio.volume === 0) {
    setChip(healthEls.speaker, "warn", "🔇 Volume à 0");
  } else {
    setChip(healthEls.speaker, "ok", "🔊 Son actif");
  }

  const battery = hb && hb.battery;
  healthEls.battery.hidden = !battery;
  if (battery) {
    const pct = Math.round(battery.level * 100);
    const state = battery.charging || pct > 20 ? "ok" : pct > 10 ? "warn" : "bad";
    setChip(healthEls.battery, state, `🔋 ${pct} %${battery.charging ? " ⚡" : ""}`);
    if (state === "bad") problems.push(`Batterie du téléphone de la chambre presque vide (${pct} %)`);
  }

  if (problems.length) raiseAlarm(problems.join(" · "));
  else clearAlarm();
}

function raiseAlarm(message) {
  const now = performance.now();
  parentAlarmEl.textContent = "⚠️ " + message;
  parentAlarmEl.hidden = false;
  document.body.classList.add("alarm");
  // Vibration + bip à chaque nouveau problème, et rappel régulier tant qu'il
  // persiste (au cas où le parent dort).
  if (parentState.alarm !== message || now - parentState.alarmNotifiedAt > ALARM_REMINDER_MS) {
    parentState.alarmNotifiedAt = now;
    if (navigator.vibrate) navigator.vibrate([400, 200, 400, 200, 400]);
    alarmBeep();
  }
  parentState.alarm = message;
}

function clearAlarm() {
  parentAlarmEl.hidden = true;
  document.body.classList.remove("alarm");
  parentState.alarm = null;
}

function alarmBeep() {
  const ctx = parentState.audioCtx;
  if (!ctx || ctx.state !== "running") return;
  for (let i = 0; i < 3; i++) {
    const t = ctx.currentTime + i * 0.3;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.setValueAtTime(0, t + 0.15);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  }
}

// --- Parent : test discret de bout en bout -----------------------------------
// Le parent demande à la chambre d'injecter un bip dans le flux envoyé (jamais
// joué dans la chambre), puis vérifie qu'il le reçoit bien. Ça valide d'un coup
// la liaison, le micro (son état est renvoyé avec l'accusé de réception) et le
// haut-parleur d'ici (le parent entend le bip).

function showTestResult(text, kind) {
  testResultEl.textContent = text;
  testResultEl.className = "test-result " + kind;
  testResultEl.hidden = false;
}

parentTestBtn.addEventListener("click", () => {
  if (parentState.test || !parentState.meter) return;
  ensureParentAudioCtx();
  const conn = parentState.pairConn;
  if (!conn || !conn.open) {
    showTestResult(`❌ ${formatClock(new Date())} — Pas de liaison avec la chambre : reconnectez-vous`, "error");
    return;
  }
  const id = Date.now();
  parentState.test = {
    id, sentAt: performance.now(), ack: null, toneError: null, detectedAt: 0, hits: 0,
    timer: setTimeout(finishSelfTest, TEST_TIMEOUT_MS),
  };
  conn.send({ type: "test", id });
  parentTestBtn.disabled = true;
  showTestResult("Test en cours… (rien n'est joué dans la chambre)", "pending");
});

function detectTestTone(now) {
  const test = parentState.test;
  if (test.detectedAt) return;
  const analyser = parentState.meter.analyser;
  const spectrum = parentState.meter.readSpectrum();
  const bin = Math.round(TEST_TONE_HZ / (analyser.context.sampleRate / analyser.fftSize));
  const peak = Math.max(spectrum[bin - 1], spectrum[bin], spectrum[bin + 1]);
  let around = 0;
  for (let k = 8; k < 24; k++) around += spectrum[bin - k] + spectrum[bin + k];
  around /= 32;
  // Une raie nette à la fréquence du bip, bien au-dessus de ses voisines,
  // pendant 3 mesures d'affilée : pas un pleur ou un bruit large bande.
  test.hits = peak > -60 && peak - around > 20 ? test.hits + 1 : 0;
  if (test.hits >= 3) {
    test.detectedAt = now;
    parentState.suppressNoiseUntil = now + TEST_TONE_MS + 500;
    if (test.ack) finishSelfTest();
  }
}

function finishSelfTest() {
  const test = parentState.test;
  if (!test) return;
  clearTimeout(test.timer);
  parentState.test = null;
  parentState.suppressNoiseUntil = Math.max(parentState.suppressNoiseUntil, performance.now() + 800);
  parentTestBtn.disabled = false;

  const time = formatClock(new Date());
  const ack = test.ack;
  if (!ack) {
    showTestResult(`❌ ${time} — La chambre ne répond pas : vérifiez que la page est ouverte et l'écran allumé sur le téléphone de la chambre`, "error");
    return;
  }
  if (!ack.trackLive || ack.trackMuted) {
    showTestResult(`❌ ${time} — Le micro de la chambre est coupé (écran verrouillé, appel en cours ou appli en arrière-plan ?)`, "error");
    return;
  }
  if (!test.detectedAt) {
    const detail = test.toneError ? ` (${test.toneError})` : "";
    showTestResult(`❌ ${time} — La chambre répond mais le son n'arrive pas jusqu'ici${detail} : déconnectez-vous puis reconnectez-vous`, "error");
    return;
  }

  const delay = ((test.detectedAt - test.sentAt) / 1000).toFixed(1).replace(".", ",");
  const base = `${time} — Son reçu en ${delay} s, micro actif (ambiance ${formatDb(ack.micDb)})`;
  const warnings = [];
  if (ack.micDb == null) warnings.push("le micro capte un silence total");
  if (ack.hidden) warnings.push("la page de la chambre est en arrière-plan");
  if (remoteAudio.paused || remoteAudio.muted || remoteAudio.volume === 0) warnings.push("le son est coupé sur ce téléphone");
  if (warnings.length) showTestResult(`⚠️ ${base}, mais ${warnings.join(" et ")}`, "warn");
  else showTestResult(`✅ ${base}`, "ok");
}

parentEnableAudioBtn.addEventListener("click", () => {
  ensureParentAudioCtx();
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
  stopParentMonitoring();
  clearAlarm();
  testResultEl.hidden = true;
  const call = parentState.call;
  parentState.call = null; // avant close() : pas d'alarme pour une déconnexion voulue
  if (call) call.close();
  if (parentState.pairConn) parentState.pairConn.close();
  if (parentState.peer) parentState.peer.destroy();
  if (parentState.audioCtx) parentState.audioCtx.close().catch(() => {});
  remoteAudio.srcObject = null;
  parentState.peer = null;
  parentState.pairConn = null;
  parentState.active = false;
  parentState.audioCtx = null;
  parentState.lastHb = null;
  releaseWakeLock();
}
