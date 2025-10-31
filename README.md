# Rover Joystick HMI

Ein minimales, produktionsnahes Node.js-Projekt für ein mobiles HMI im Hochformat. Es stellt einen eigenen HTTPS-Webserver auf einem Beckhoff IPC bereit und kommuniziert über WebSockets mit verbundenen Clients sowie via HTTP-POST mit Node-RED.

## Features

- 📱 Touch-optimiertes Hochformat-Layout mit Vollbild-Joystick
- 🔐 HTTPS-Server mit lokalem Zertifikat, CSP-Headern und `X-Frame-Options`
- 🔄 Umschaltung zwischen Automatic- und Manual-Modus inklusive WebSocket-Broadcast
- 🕹️ Virtueller Joystick mit Echtzeit-Streaming (ca. 30 Hz zum Browser, 20 Hz zu Node-RED)
- 🔁 Robuste WebSocket-Reconnect-Logik für mobile Geräte

## Projektstruktur

```
.
├─ server.js
├─ package.json
├─ .env
├─ certs/
│  ├─ server.crt
│  └─ server.key
├─ public/
│  ├─ index.html
│  ├─ styles.css
│  └─ app.js
└─ README.md
```

## Voraussetzungen

- Node.js 18 oder neuer (wegen nativer `fetch`-API)
- Zugriff auf den Beckhoff IPC (z. B. 169.254.75.59) im selben Netzwerk

## Installation

```bash
npm install
```

Erstelle anschließend ein selbstsigniertes Zertifikat (Beispiel):

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certs/server.key \
  -out certs/server.crt \
  -days 365 \
  -subj "/CN=169.254.75.59"
```

## Konfiguration

Die `.env` enthält alle wesentlichen Parameter:

```
PORT=8443
HOST=0.0.0.0
HMI_ORIGIN=https://169.254.75.59
CERT_PATH=./certs/server.crt
KEY_PATH=./certs/server.key
NODE_RED_HTTP_URL=http://127.0.0.1:1880/joystick
NODE_ENV=development
```

> **Hinweis:** Im Entwicklungsmodus ist HSTS deaktiviert. Für den Produktiveinsatz kann `NODE_ENV=production` gesetzt werden, um HSTS zu aktivieren und Caching-Header zu verschärfen.

## Starten des Servers

```bash
npm start
```

Der Server lauscht anschließend standardmäßig unter `https://0.0.0.0:8443`. Die Oberfläche kann im TwinCAT-HMI mittels `<iframe>` eingebunden werden und ist aus demselben WLAN erreichbar.

## Kommunikation

### WebSocket-Protokoll (Browser ↔ Server)

- `{"type":"setMode","mode":"automatic"|"manual"}`
- `{"type":"stick","x":number,"y":number,"mag":number,"deg":number,"ts":epochMillis}`

Der Server broadcastet identische Formate an alle verbundenen Clients und hält den aktuellen Zustand für neue Verbindungen bereit.

### Node-RED Anbindung (Server → Node-RED)

- Endpunkt: `POST http://127.0.0.1:1880/joystick`
- Rate-Limit: max. 20 Requests/Sekunde (50 ms Throttle)
- JSON-Body:

```json
{
  "mode": "automatic",
  "stick": { "x": 0, "y": 0, "mag": 0, "deg": 0 },
  "ts": 1695999999999,
  "source": "hmi-web"
}
```

### Beispiel-Flow für Node-RED

Importiere den folgenden Flow (JSON) in Node-RED, um die Joystick-Daten entgegenzunehmen, im Debug anzuzeigen und bei Bedarf weiterzuverarbeiten:

```json
[
  {
    "id": "a1b2c3d4.e5f6",
    "type": "http in",
    "z": "",
    "name": "Joystick Input",
    "url": "/joystick",
    "method": "post",
    "upload": false,
    "swaggerDoc": "",
    "x": 140,
    "y": 120,
    "wires": [["a7c8d9e0.1234"]]
  },
  {
    "id": "a7c8d9e0.1234",
    "type": "json",
    "z": "",
    "name": "Parse JSON",
    "property": "payload",
    "action": "obj",
    "pretty": false,
    "x": 340,
    "y": 120,
    "wires": [["f1e2d3c4.b5a6", "b4c3d2e1.f0a9"]]
  },
  {
    "id": "f1e2d3c4.b5a6",
    "type": "function",
    "z": "",
    "name": "Ack",
    "func": "msg.payload = { status: 'ok' };\nreturn msg;",
    "outputs": 1,
    "noerr": 0,
    "initialize": "",
    "finalize": "",
    "libs": [],
    "x": 520,
    "y": 100,
    "wires": [["c0ffee00.1234"]]
  },
  {
    "id": "c0ffee00.1234",
    "type": "http response",
    "z": "",
    "name": "HTTP 200",
    "statusCode": "200",
    "headers": {},
    "x": 700,
    "y": 100,
    "wires": []
  },
  {
    "id": "b4c3d2e1.f0a9",
    "type": "debug",
    "z": "",
    "name": "Joystick Debug",
    "active": true,
    "tosidebar": true,
    "console": false,
    "tostatus": false,
    "complete": "payload",
    "targetType": "msg",
    "x": 540,
    "y": 160,
    "wires": []
  }
]
```

Der Flow setzt voraus, dass der HTTP-Endpunkt `/joystick` mit dem Projekt übereinstimmt (`NODE_RED_HTTP_URL`). Die Function-Node bestätigt den Empfang gegenüber dem Webserver.

## Sicherheit & CSP

- `frame-ancestors 'self' https://169.254.75.59`
- `connect-src 'self' wss://169.254.75.59:*`
- `X-Frame-Options: ALLOW-FROM https://169.254.75.59`

Diese Vorgaben ermöglichen die sichere Einbettung in das TwinCAT-HMI via `<iframe>` und erlauben gleichzeitig WebSocket-Verbindungen vom Smartphone im selben Netzwerk.

## Entwicklungshinweise

- Bei Zertifikatsänderungen Server neu starten.
- Für produktive Zertifikate empfiehlt sich ein internes CA-Zertifikat, das auf allen Clients installiert wird.
- Die UI ist strikt auf Portrait-Geräte ausgerichtet; eine Rotation wird nicht erzwungen.

Viel Erfolg beim Steuern des Rovers! 🚀
