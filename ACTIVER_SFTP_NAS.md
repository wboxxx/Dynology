# Activer SFTP sur Synology NAS

Pour améliorer la fiabilité du déploiement, activez SFTP sur votre NAS Synology :

## Étapes :

1. **Connectez-vous à DSM** (interface web du NAS)

2. **Allez dans :**
   - Panneau de configuration
   - Terminal et SNMP
   - Onglet **Terminal**

3. **Activez SSH :**
   - Cochez "Activer le service SSH"
   - Port SSH : `22` (ou celui que vous utilisez)
   - Activez "Activer le service SFTP"

4. **Cliquez sur "Appliquer"**

5. **Redémarrez le service SSH si nécessaire**

## Alternative : Utiliser rsync (si disponible)

Si rsync est disponible sur votre NAS, le script peut l'utiliser à la place.



