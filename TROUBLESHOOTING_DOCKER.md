# Dépannage Docker sur Synology

## Problème : "docker: command not found"

Si vous voyez cette erreur, Docker n'est pas dans le PATH pour votre utilisateur SSH.

## Solutions

### Solution 1 : Trouver le chemin Docker

Connectez-vous au NAS et trouvez où Docker est installé :

```bash
ssh vincent.boiteau@192.168.1.51
which docker
# ou
ls -la /usr/local/bin/docker
ls -la /var/packages/Docker/target/usr/bin/docker
```

### Solution 2 : Ajouter Docker au PATH (Recommandé)

1. **Connectez-vous au NAS via SSH** :
   ```bash
   ssh vincent.boiteau@192.168.1.51
   ```

2. **Éditez votre fichier de profil** :
   ```bash
   nano ~/.bashrc
   # ou
   nano ~/.profile
   ```

3. **Ajoutez ces lignes** :
   ```bash
   export PATH=/usr/local/bin:$PATH
   export PATH=/var/packages/Docker/target/usr/bin:$PATH
   ```

4. **Appliquez les changements** :
   ```bash
   source ~/.bashrc
   # ou
   source ~/.profile
   ```

5. **Vérifiez** :
   ```bash
   docker --version
   docker compose version
   ```

### Solution 3 : Utiliser le chemin complet dans le script

Si vous trouvez le chemin exact de Docker (ex: `/var/packages/Docker/target/usr/bin/docker`), vous pouvez modifier le script `deploy-to-nas.js` pour utiliser ce chemin directement.

### Solution 4 : Utiliser sudo (si nécessaire)

Sur certains NAS Synology, Docker nécessite des privilèges. Essayez :

```bash
sudo /usr/local/bin/docker --version
```

Si ça fonctionne avec sudo, vous devrez peut-être configurer sudo sans mot de passe ou modifier le script pour utiliser sudo.

## Vérification après configuration

Une fois configuré, testez depuis votre machine locale :

```bash
ssh vincent.boiteau@192.168.1.51 "docker --version"
ssh vincent.boiteau@192.168.1.51 "docker compose version"
```

Si ces commandes fonctionnent, le script de déploiement devrait aussi fonctionner.



