// Petit serveur local pour développer (aucune dépendance à installer).
//   node dev-server.js   ->   http://localhost:5174
//   (5174 et pas 5173 pour ne pas entrer en conflit avec GTALive)
const http = require("http");
const fs = require("fs");
const path = require("path");

const RACINE = path.join(__dirname, "web");
const PORT = 5174;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    let fichier = path.join(RACINE, url === "/" ? "index.html" : url);

    // on ne sort jamais du dossier web/
    if (!fichier.startsWith(RACINE)) {
      res.writeHead(403).end("Interdit");
      return;
    }

    fs.readFile(fichier, (err, contenu) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Introuvable : " + url);
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(fichier)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(contenu);
    });
  })
  .listen(PORT, () => console.log("AgendaBoite -> http://localhost:" + PORT));
