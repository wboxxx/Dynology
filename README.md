# Dynogy V1 - Core Deployment Agent

Dynogy est un agent de déploiement automatisé conçu pour tourner sur un NAS Synology. Il reçoit des webhooks Git et déclenche automatiquement le déploiement de services via Docker Compose.

## 🎯 Fonctionnalités V1

- ✅ Réception de webhooks Git (GitHub, GitLab)
- ✅ Déploiement automatique (git pull + docker compose build/up)
- ✅ API REST pour vérifier l'état du système
- ✅ Détection automatique des services
- ✅ Logs de déploiement par service

## 📋 Prérequis

- NAS Synology avec Docker et Docker Compose installés
- Nom de domaine configuré avec certificat SSL (reverse proxy DSM)
- Accès SSH ou Terminal au NAS
- Git installé sur le NAS (ou dans le conteneur Docker)
- **Permissions Docker** : Votre utilisateur SSH doit avoir accès à Docker (voir section Dépannage ci-dessous)

## 🚀 Installation

### Option A : Déploiement automatique depuis Cursor (Recommandé)

1. **Installer les dépendances** :
   ```bash
   npm install
   ```

2. **Configurer les credentials NAS** :
   ```bash
   cp .nas-credentials.example .nas-credentials
   ```
   
   Éditez `.nas-credentials` avec vos informations :
   ```json
   {
     "host": "192.168.1.100",
     "port": 22,
     "username": "admin",
     "password": "votre-mot-de-passe",
     "deployPath": "/volume1/docker/dynogy",
     "sshKeyPath": ""
   }
   ```
   
   **⚠️ Sécurité** : Le fichier `.nas-credentials` est dans `.gitignore` et ne sera jamais commité.

3. **Déployer automatiquement** :
   ```bash
   npm run deploy
   ```
   
   Le script va :
   - Se connecter au NAS via SSH
   - Créer les répertoires nécessaires
   - Copier tous les fichiers
   - Démarrer Docker Compose
   - Vérifier le statut

### Option B : Installation manuelle

### 1. Cloner ou copier le projet sur le NAS

Placez le projet dans un répertoire accessible, par exemple :
```bash
/volume1/docker/dynogy/
```

### 2. Configuration

Créez un fichier `.env` à partir de `env.example` (ou `.env.example` si disponible) :

```bash
cp env.example .env
```

Sur Windows, vous pouvez renommer `env.example` en `.env`.

Modifiez `.env` selon votre configuration :

```env
DYNOGY_PORT=4000
SERVICES_DIR=/volume1/docker/dynogy/services
DEPLOY_LOG_DIR=/volume1/docker/dynogy/logs
```

**Note importante** : Ajustez `SERVICES_DIR` et `DEPLOY_LOG_DIR` selon l'emplacement sur votre NAS. Par défaut, les services seront déployés dans `/volume1/docker/dynogy/services/`.

### 3. Préparer les répertoires

Assurez-vous que les répertoires existent :

```bash
mkdir -p /volume1/docker/dynogy/services
mkdir -p /volume1/docker/dynogy/logs
```

### 4. Démarrage

```bash
docker compose up -d
```

Vérifiez les logs :

```bash
docker compose logs -f dynogy-agent
```

### 5. Configuration du Reverse Proxy (DSM)

Dans **DSM > Panneau de configuration > Reverse Proxy** :

1. Créez une nouvelle règle
2. **Description** : `Dynogy Agent`
3. **Protocole** : HTTPS
4. **Nom d'hôte** : `dynogy.votre-domaine.com` (ou autre)
5. **Port** : `443`
6. **Activer HSTS** : ✅
7. **Destination** :
   - Protocole : HTTP
   - Nom d'hôte : `localhost`
   - Port : `4000` (ou le port configuré dans `.env`)

## 📡 Configuration des Webhooks

### GitHub

1. Allez dans votre repository GitHub
2. **Settings > Webhooks > Add webhook**
3. **Payload URL** : `https://dynogy.votre-domaine.com/webhook`
4. **Content type** : `application/json`
5. **Which events** : Sélectionnez "Just the push event"
6. **Active** : ✅

**Note V1** : La vérification de signature n'est pas encore implémentée (prévu pour V2).

### GitLab

1. Allez dans votre projet GitLab
2. **Settings > Webhooks**
3. **URL** : `https://dynogy.votre-domaine.com/webhook`
4. **Trigger** : Cochez "Push events"
5. **Secret token** : (optionnel pour V1, sera utilisé en V2)

## 🔧 Utilisation

### Vérifier le statut

```bash
curl https://dynogy.votre-domaine.com/status
```

Réponse JSON :
```json
{
  "version": "1.0.0",
  "status": "running",
  "services": [
    {
      "name": "manga-cleaner",
      "path": "/volume1/docker/dynogy/services/manga-cleaner",
      "lastDeploy": "2024-01-15T10:30:00.000Z"
    }
  ],
  "lastDeploy": "2024-01-15T10:30:00.000Z",
  "config": {
    "servicesDir": "/volume1/docker/dynogy/services",
    "logDir": "/volume1/docker/dynogy/logs",
    "port": 4000
  }
}
```

### Health check

```bash
curl https://dynogy.votre-domaine.com/health
```

## 📦 Ajouter un service

Pour qu'un service soit géré par Dynogy, il doit :

1. **Être cloné dans le répertoire des services** :
   ```bash
   cd /volume1/docker/dynogy/services
   git clone https://github.com/votre-org/manga-cleaner.git
   ```

2. **Avoir un `docker-compose.yml`** à la racine du repository

3. **Le nom du repository** (sans extension `.git`) sera utilisé comme nom de service

### Exemple : manga-cleaner

```bash
cd /volume1/docker/dynogy/services
git clone https://github.com/votre-org/manga-cleaner.git
```

Structure attendue :
```
services/
└── manga-cleaner/
    ├── docker-compose.yml
    ├── Dockerfile
    └── ... (autres fichiers du projet)
```

Quand vous push sur la branche `main` ou `master` du repository GitHub, Dynogy :
1. Reçoit le webhook
2. Identifie le service (nom du repo = `manga-cleaner`)
3. Exécute dans `/volume1/docker/dynogy/services/manga-cleaner/` :
   - `git pull`
   - `docker compose build`
   - `docker compose up -d`

## 📝 Logs

Les logs de déploiement sont stockés dans le répertoire configuré (`DEPLOY_LOG_DIR`) :

```
logs/
├── manga-cleaner-1705312345678.log
├── manga-cleaner-1705312456789.log
└── ...
```

Chaque fichier contient la sortie complète du déploiement (git pull, docker build, docker up).

## 🔍 Dépannage

### Permission refusée pour Docker

Si vous voyez `permission denied while trying to connect to the Docker daemon socket` :

**Solution (Synology)** :

1. Connectez-vous au NAS via SSH :
   ```bash
   ssh votre-utilisateur@votre-nas
   ```

2. Ajoutez votre utilisateur au groupe docker :
   ```bash
   sudo synogroup --add docker
   sudo synogroup --member docker votre-utilisateur
   ```

3. **Déconnectez-vous et reconnectez-vous** via SSH pour que les changements prennent effet :
   ```bash
   exit
   ssh votre-utilisateur@votre-nas
   ```

4. Vérifiez :
   ```bash
   docker ps
   ```

5. Relancez le déploiement depuis Cursor :
   ```bash
   npm run deploy
   ```

**Alternative** : Si vous ne pouvez pas modifier les groupes, vous pouvez utiliser `sudo` pour les commandes Docker (nécessite sudo sans mot de passe).

### L'agent ne démarre pas

```bash
docker compose logs dynogy-agent
```

Vérifiez :
- Que le port n'est pas déjà utilisé
- Que les répertoires existent et sont accessibles
- Que Docker socket est bien monté (`/var/run/docker.sock`)
- Que votre utilisateur a les permissions Docker (voir ci-dessus)

### Le webhook ne déclenche pas de déploiement

1. Vérifiez les logs de l'agent :
   ```bash
   docker compose logs -f dynogy-agent
   ```

2. Testez le webhook manuellement :
   ```bash
   curl -X POST https://dynogy.votre-domaine.com/webhook \
     -H "Content-Type: application/json" \
     -d '{
       "ref": "refs/heads/main",
       "repository": {"name": "manga-cleaner"},
       "head_commit": {"id": "abc123"}
     }'
   ```

3. Vérifiez que :
   - La branche est `main` ou `master` (seules branches déployées par défaut)
   - Le service existe dans `SERVICES_DIR`
   - Le service a un `docker-compose.yml`

### Le déploiement échoue

Consultez les logs de déploiement :

```bash
tail -f /volume1/docker/dynogy/logs/manga-cleaner-*.log
```

Problèmes courants :
- Repository non cloné (clonez-le manuellement la première fois)
- Problème de permissions (vérifiez les droits sur les répertoires)
- Erreur Docker (vérifiez `docker compose` manuellement dans le répertoire du service)

## 🏗️ Architecture

```
┌─────────────┐
│   GitHub    │
│   GitLab    │
└──────┬──────┘
       │ Webhook (POST)
       ▼
┌─────────────────────────────────────┐
│      Dynogy Agent (Docker)          │
│  ┌──────────────────────────────┐   │
│  │  Express Server (port 4000)  │   │
│  │  - GET /status               │   │
│  │  - POST /webhook             │   │
│  └──────────┬───────────────────┘   │
│             │                        │
│  ┌──────────▼───────────────────┐   │
│  │   deploy.sh                  │   │
│  │   - git pull                 │   │
│  │   - docker compose build     │   │
│  │   - docker compose up -d     │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
       │
       ▼
┌─────────────────────┐
│  Services Directory │
│  - manga-cleaner/   │
│  - other-service/   │
└─────────────────────┘
```

## 🚧 Versions futures

### V2 - Sécurité et améliorations
- [ ] Vérification de signature des webhooks (GitHub X-Hub-Signature-256)
- [ ] Interface web simple pour visualiser les déploiements
- [ ] Support de plusieurs branches avec configuration
- [ ] Notifications (email, Discord, etc.)

### V3 - Intelligence artificielle
- [ ] Analyse automatique des logs et erreurs
- [ ] Suggestions de corrections par LLM
- [ ] Assistance à l'ajout de nouveaux services

## 📄 Licence

MIT

## 🤝 Contribution

Les contributions sont les bienvenues ! Ce projet est en phase V1, donc la structure est encore en évolution.

