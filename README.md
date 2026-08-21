# USL Trésorerie

Application de gestion comptable pour club sportif : saisie des mouvements, comptes multiples (caisse, banque, livret, trésorerie vive...), catégories et sous-catégories de dépenses/recettes, budget prévisionnel, analyses (réalisé vs prévisionnel, mensuelle, dépenses/recettes), bilan de trésorerie et détection d'anomalies.

Conçue pour être utilisée par plusieurs membres du bureau, chacun avec son propre compte.

**Zéro dépendance externe** : le serveur n'utilise que des modules intégrés à Node.js (`http`, `node:sqlite`, `crypto`). Il n'y a donc rien à compiler et `npm install` ne télécharge rien — cela évite la plupart des soucis de build au déploiement.

## Déployer sur Render

### Option A — via Blueprint (le plus simple)

1. Mettez ce dossier dans un dépôt Git (GitHub/GitLab) — voir plus bas si vous n'avez pas encore de dépôt.
2. Sur [render.com](https://render.com), **New +** → **Blueprint**, connectez le dépôt. Render détecte automatiquement `render.yaml` et configure :
   - le service web Node,
   - un disque persistant de 1 Go monté sur `/data` (indispensable pour ne pas perdre les données à chaque déploiement),
   - une variable `SESSION_SECRET` générée automatiquement,
   - `DATA_DIR=/data`.
3. Cliquez **Apply**. Le premier déploiement prend une minute ou deux.
4. Ouvrez l'URL fournie par Render : vous arrivez sur l'écran **« Créer le compte administrateur »**. C'est votre premier compte — les suivants (autres membres du bureau) se créent ensuite depuis l'onglet **Utilisateurs** de l'application.

⚠️ **Le disque persistant (`disk:` dans `render.yaml`) nécessite un plan payant** (Starter ou supérieur, pas le plan gratuit). Sans disque persistant, le plan gratuit de Render redémarre régulièrement le service et **efface le fichier de base de données à chaque redéploiement/redémarrage**. Si vous voulez rester sur le plan gratuit en attendant, vous pouvez déployer sans disque, mais sachez que les données ne seront pas fiables dans la durée.

### Option B — création manuelle du service (sans Blueprint)

1. **New +** → **Web Service**, connectez votre dépôt (ou glissez le dossier dans un nouveau dépôt Git au préalable — Render ne prend pas de dossier local en glisser-déposer direct, il lui faut un dépôt Git).
2. Renseignez :
   - **Build command** : `npm install`
   - **Start command** : `node server/index.js`
   - **Environment** : Node
3. Dans **Environment → Environment Variables**, ajoutez :
   - `SESSION_SECRET` : une longue chaîne aléatoire (ex. générée avec `openssl rand -hex 32`). **Obligatoire en production**, sinon toutes les sessions sont invalidées à chaque redémarrage du service.
   - `DATA_DIR` : `/data` (si vous ajoutez un disque, voir ci-dessous) ou laissez vide pour utiliser un dossier local au service (non persistant).
   - `NODE_ENV` : `production`
4. Dans **Disks**, ajoutez un disque (ex. 1 Go) monté sur `/data` — nécessite un plan payant. C'est ce qui garde vos données d'une mise à jour à l'autre.
5. Déployez, puis ouvrez l'URL et créez le compte administrateur.

### Si vous n'avez pas encore de dépôt Git pour ce dossier

Depuis ce dossier :

```bash
git init
git add .
git commit -m "USL Trésorerie"
```

Puis créez un dépôt vide sur GitHub et suivez les instructions affichées (`git remote add origin ...` puis `git push -u origin main`). Ensuite seulement, connectez ce dépôt à Render.

## Utilisation

- **Premier accès** : créez le compte administrateur (formulaire affiché automatiquement tant qu'aucun compte n'existe).
- **Ajouter les autres membres du bureau** : onglet *Utilisateurs* (visible seulement pour les administrateurs) → *Ajouter un membre*.
- **Comptes** (Caisse, Compte courant, Livret, Trésorerie vive, Chèques non débités...) sont pré-remplis avec la structure habituelle d'un club, modifiables dans l'onglet *Comptes*.
- **Catégories/sous-catégories** de dépenses et de recettes sont pré-remplies avec une taxonomie standard de club sportif (licences, arbitrage, éducateurs, équipements, cotisations, subventions, partenariats...), modifiable dans l'onglet *Catégories*.
- **Budget prévisionnel** : saisissez un montant par catégorie ; l'onglet *Réalisé vs prévisionnel* compare automatiquement au réalisé.
- **Anomalies** : détecte doublons probables, montants inhabituels, mouvements non catégorisés ou non validés (seuils réglables).

## Développement local

```bash
npm install          # ne télécharge rien (zéro dépendance), juste pour cohérence
SESSION_SECRET=dev-secret node server/index.js
```

Ouvrez `http://localhost:3000` (ou le port défini par `PORT`).

## Sauvegarde des données

Toutes les données vivent dans un unique fichier SQLite : `$DATA_DIR/data.db` (par défaut `./data/data.db` en local, `/data/data.db` sur Render avec la configuration fournie). Pour sauvegarder, il suffit de copier ce fichier (via un shell Render, `render ssh`, ou en programmant une exportation régulière).

## Structure du projet

```
server/
  index.js            serveur HTTP + routes API (aucune dépendance externe)
  db.js               accès SQLite (node:sqlite)
  auth.js             sessions signées (cookie HMAC) + hachage des mots de passe (scrypt)
  default-config.js   comptes et catégories par défaut à la création
public/
  index.html          page unique
  app.js              application cliente (SPA, sans framework)
  styles.css
render.yaml           configuration Render (Blueprint)
```
