# BabyPhone Web

Interphone bébé à sens unique entre deux téléphones, dans le navigateur.
Un téléphone sert de **micro** (posé dans la chambre), l'autre sert d'**enceinte**
(côté parent). Aucun son n'est envoyé dans l'autre sens.

Techniquement : une simple page web statique (HTML/CSS/JS), aucun serveur à
coder. La connexion audio passe en direct entre les deux téléphones via
**WebRTC**, la mise en relation ("qui appelle qui") passe par le service
public gratuit [PeerJS Cloud](https://peerjs.com/) (pas d'audio ne transite
par ce service, uniquement les infos de connexion).

## Utilisation

1. Ouvrez la page sur les deux téléphones (voir déploiement ci-dessous).
2. Sur le téléphone dans la chambre : choisissez **🎙️ Chambre du bébé**,
   autorisez le micro. Un code à 4 chiffres et un QR code s'affichent.
3. Sur le téléphone du parent : choisissez **🔊 Côté parent**, entrez le code
   (ou scannez le QR code avec l'appareil photo, qui ouvrira directement la
   bonne page).
4. Le son se met à circuler automatiquement dès la connexion établie.

Les deux écrans empêchent la mise en veille de l'écran (Wake Lock) tant que
la session est active.

## Déploiement (obligatoire : HTTPS)

Les navigateurs mobiles n'autorisent l'accès au micro (`getUserMedia`) que
sur une page servie en **HTTPS** (ou `localhost`). Le plus simple :

### Option rapide — Netlify Drop (aucun compte requis)

1. Allez sur https://app.netlify.com/drop
2. Glissez-déposez ce dossier (`index.html`, `style.css`, `app.js`)
3. Récupérez l'URL HTTPS générée, ouvrez-la sur les deux téléphones

### Option GitHub Pages

```bash
git init
git add index.html style.css app.js README.md
git commit -m "BabyPhone web app"
gh repo create babyphone-web --public --source=. --push
```

Puis activez GitHub Pages sur la branche `main` dans les paramètres du dépôt.

### Test local sur le même Wi-Fi (sans déployer)

Un certificat auto-signé suffit pour tester sur le réseau local (les deux
téléphones devront accepter l'avertissement "connexion non sécurisée") :

```bash
npx local-web-server --https --http2.cert cert.pem --http2.key key.pem
```

ou avec [mkcert](https://github.com/FiloSottile/mkcert) pour un certificat
de confiance locale, puis n'importe quel serveur statique (`npx serve -S`).

## Limites connues

- **Fiabilité réseau** : la configuration utilise uniquement des serveurs
  STUN publics. Sur un Wi-Fi classique ça fonctionne bien ; sur des réseaux
  mobiles/4G très restrictifs, un serveur **TURN** peut être nécessaire
  (voir `PEER_CONFIG` dans `app.js`).
- **Arrière-plan** : si le navigateur passe en arrière-plan ou l'écran se
  verrouille malgré le Wake Lock (selon l'OS), la capture micro ou la
  lecture audio peuvent être interrompues. Gardez l'onglet au premier plan.
- **iOS Safari** : peut couper l'audio si l'appli passe en arrière-plan ;
  Android est plus permissif.
- Le service de mise en relation (PeerJS Cloud) est un tiers public et
  partagé. Pour un usage entièrement privé/auto-hébergé, on peut remplacer
  `new Peer(...)` par une connexion à un
  [PeerServer](https://github.com/peers/peerjs-server) auto-hébergé.
