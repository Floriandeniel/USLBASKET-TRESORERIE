/* Service worker minimal — uniquement présent pour permettre l'installation de
   l'application (mode « app », plein écran, icône sur l'écran d'accueil).
   Il ne met VOLONTAIREMENT rien en cache : toutes les requêtes repartent
   normalement sur le réseau. On évite ainsi de réintroduire le bug déjà
   rencontré où un téléphone continuait à afficher une ancienne version de
   l'application après une mise à jour du serveur. */
self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", () => { /* pass-through : pas de cache */ });
