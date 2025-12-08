#!/usr/bin/env node

/**
 * Script de déploiement automatique vers NAS Synology
 * 
 * Usage: node deploy-to-nas.js
 * 
 * Ce script copie les fichiers nécessaires sur le NAS via SSH/SCP
 * et lance docker compose pour démarrer l'agent Dynogy.
 * 
 * Compatible Windows/Linux/Mac grâce aux bibliothèques Node.js pures.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');
const { Readable } = require('stream');

// Charger les credentials
const credentialsFile = path.join(__dirname, '.nas-credentials');
if (!fs.existsSync(credentialsFile)) {
  console.error('❌ Fichier .nas-credentials introuvable !');
  console.error('   Créez ce fichier à partir de .nas-credentials.example');
  process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));

const {
  host,
  port = 22,
  username,
  password,
  deployPath = '/volume1/docker/dynogy',
  sshKeyPath = null,
  useSudo = false
} = credentials;

// Vérifier les credentials
if (!host || !username || (!password && !sshKeyPath)) {
  console.error('❌ Credentials incomplets dans .nas-credentials');
  console.error('   Requis: host, username, ET (password OU sshKeyPath)');
  process.exit(1);
}

console.log(`🚀 Déploiement Dynogy vers ${username}@${host}:${port}`);
console.log(`   Destination: ${deployPath}\n`);

// Configuration SSH
const sshConfig = {
  host,
  port,
  username,
  readyTimeout: 20000,
  ...(sshKeyPath && fs.existsSync(sshKeyPath)
    ? { privateKey: fs.readFileSync(sshKeyPath) }
    : { password })
};

// Fonction helper pour exécuter une commande SSH
function execSSH(command) {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          conn.end();
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          conn.end();
          resolve({ code, signal, stdout, stderr });
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });

    conn.on('error', (err) => {
      reject(err);
    });

    conn.connect(sshConfig);
  });
}


// Fonction helper pour copier un fichier via SSH (méthode simple et fiable)
function copyFileSSH(localFilePath, remoteFilePath, conn) {
  return new Promise((resolve, reject) => {
    try {
      const fileContent = fs.readFileSync(localFilePath);
      const remoteFileName = path.basename(remoteFilePath);
      // Normaliser le chemin distant pour utiliser des slashes Unix
      const remoteFileDir = path.dirname(remoteFilePath).replace(/\\/g, '/');
      const normalizedRemotePath = `${remoteFileDir}/${remoteFileName}`.replace(/\\/g, '/');

      // Utiliser base64 pour éviter les problèmes d'échappement avec heredoc
      const base64Content = Buffer.from(fileContent).toString('base64');

      // Découper en chunks si trop grand (limite de commande shell ~100KB)
      if (base64Content.length > 80000) {
        return reject(new Error(`File too large (${Math.round(base64Content.length / 1024)}KB base64). Max ~60KB original file.`));
      }

      // Utiliser base64 pour la copie (plus fiable pour préserver exactement le contenu)
      const command = `mkdir -p "${remoteFileDir}" && echo '${base64Content}' | base64 -d > "${normalizedRemotePath}" && chmod 644 "${normalizedRemotePath}" && test -f "${normalizedRemotePath}" && echo "FILE_OK" || (ls -la "${remoteFileDir}" 2>&1 && echo "FILE_MISSING")`;

      conn.exec(command, (err, stream) => {
        if (err) {
          return reject(err);
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        stream.on('close', (code) => {
          const allOutput = (stdout + stderr).trim();

          if (code === 0 && allOutput.includes('FILE_OK')) {
            resolve();
          } else {
            // Afficher plus de détails pour le débogage
            console.error(`   ⚠️  Détails de l'erreur pour ${remoteFileName}:`);
            console.error(`      Code: ${code}`);
            console.error(`      Stdout: ${stdout.trim() || '(vide)'}`);
            console.error(`      Stderr: ${stderr.trim() || '(vide)'}`);

            if (allOutput.includes('FILE_MISSING')) {
              reject(new Error(`File copy failed: ${remoteFileName} was not created. Output: ${allOutput}`));
            } else if (code !== 0) {
              reject(new Error(`File copy failed (code ${code}): ${allOutput || 'Unknown error'}`));
            } else {
              reject(new Error(`File copy verification failed: ${remoteFileName}. Output: ${allOutput}`));
            }
          }
        });

        // Timeout pour cette commande (30 secondes par fichier)
        setTimeout(() => {
          stream.destroy();
          reject(new Error(`File copy timeout: ${remoteFileName}`));
        }, 30000);
      });
    } catch (error) {
      reject(error);
    }
  });
}

// Fonction helper pour copier un fichier/dossier via SSH
// Utilise rsync côté serveur si disponible, sinon méthode fichier par fichier
async function copySCP(localPath, remotePath) {
  return new Promise(async (resolve, reject) => {
    const stats = fs.statSync(localPath);
    const baseName = path.basename(localPath);
    const remoteDir = path.dirname(remotePath);
    const conn = new Client();

    // Timeout global pour éviter les blocages
    const globalTimeout = setTimeout(() => {
      conn.end();
      reject(new Error('Global timeout: opération trop longue (> 5 minutes)'));
    }, 300000);

    conn.on('ready', async () => {
      try {
        // Utiliser méthode fichier par fichier optimisée avec logs détaillés
        console.log(`   📦 Copie de ${baseName}...`);
        await copyDirectoryOptimized(localPath, remotePath, conn);
        clearTimeout(globalTimeout);
        conn.end();
        resolve();
      } catch (error) {
        clearTimeout(globalTimeout);
        conn.end();
        reject(error);
      }
    });

    conn.on('error', (err) => {
      clearTimeout(globalTimeout);
      reject(err);
    });

    conn.connect(sshConfig);
  });
}

// Fonction optimisée pour copier un dossier fichier par fichier avec logs détaillés
async function copyDirectoryOptimized(localPath, remotePath, conn) {
  const stats = fs.statSync(localPath);

  if (!stats.isDirectory()) {
    // Fichier simple
    console.log(`   📄 Copie du fichier ${path.basename(localPath)}...`);
    await copyFileSSH(localPath, remotePath, conn);
    console.log(`   ✅ ${path.basename(localPath)} copié`);
    return;
  }

  // Créer le répertoire de destination (utiliser la même connexion conn)
  console.log(`   📁 Création du répertoire ${path.basename(remotePath)}...`);
  await new Promise((resolveMkdir, rejectMkdir) => {
    const mkdirTimeout = setTimeout(() => {
      rejectMkdir(new Error(`mkdir timeout pour ${remotePath}`));
    }, 10000);

    conn.exec(`mkdir -p "${remotePath}" && echo "OK"`, (mkdirErr, mkdirStream) => {
      if (mkdirErr) {
        clearTimeout(mkdirTimeout);
        return rejectMkdir(mkdirErr);
      }

      let mkdirData = '';
      mkdirStream.on('data', (data) => {
        mkdirData += data.toString();
      });

      mkdirStream.on('close', (code) => {
        clearTimeout(mkdirTimeout);
        if (code === 0 || mkdirData.includes('OK')) {
          console.log(`   ✅ Répertoire créé`);
          resolveMkdir();
        } else {
          rejectMkdir(new Error(`mkdir failed (code ${code}): ${mkdirData}`));
        }
      });

      mkdirStream.on('end', () => {
        if (mkdirTimeout && mkdirData.includes('OK')) {
          clearTimeout(mkdirTimeout);
          resolveMkdir();
        }
      });
    });
  });

  // Fonction récursive avec logs détaillés
  async function copyRecursive(localDir, remoteDir, level = 0) {
    const indent = '  '.repeat(level);
    try {
      const entries = fs.readdirSync(localDir);
      console.log(`${indent}📁 ${path.basename(localDir)}: ${entries.length} éléments`);

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const localEntryPath = path.join(localDir, entry);
        const remoteEntryPath = path.join(remoteDir, entry);
        const entryStats = fs.statSync(localEntryPath);

        console.log(`${indent}  [${i + 1}/${entries.length}] ${entry}...`);

        if (entryStats.isDirectory()) {
          // Créer le sous-répertoire avec timeout
          await new Promise((resolveMkdir, rejectMkdir) => {
            const mkdirTimeout = setTimeout(() => {
              rejectMkdir(new Error(`mkdir timeout pour ${remoteEntryPath}`));
            }, 5000);

            conn.exec(`mkdir -p "${remoteEntryPath}"`, (mkdirErr, mkdirStream) => {
              if (mkdirErr) {
                clearTimeout(mkdirTimeout);
                return rejectMkdir(mkdirErr);
              }

              let mkdirData = '';
              mkdirStream.on('data', (data) => {
                mkdirData += data.toString();
              });

              mkdirStream.on('close', (code) => {
                clearTimeout(mkdirTimeout);
                if (code === 0) {
                  resolveMkdir();
                } else {
                  rejectMkdir(new Error(`mkdir failed (code ${code})`));
                }
              });

              // Si le stream se termine sans close, résoudre quand même
              mkdirStream.on('end', () => {
                if (mkdirTimeout) {
                  clearTimeout(mkdirTimeout);
                  resolveMkdir();
                }
              });
            });
          });
          await copyRecursive(localEntryPath, remoteEntryPath, level + 1);
          console.log(`${indent}  ✅ ${entry}/`);
        } else {
          try {
            await copyFileSSH(localEntryPath, remoteEntryPath, conn);
            console.log(`${indent}  ✅ ${entry}`);
          } catch (copyError) {
            console.error(`${indent}  ❌ ${entry} - Erreur: ${copyError.message}`);
            throw copyError;
          }
        }
      }
    } catch (error) {
      console.error(`   ❌ Erreur dans ${path.basename(localDir)}: ${error.message}`);
      throw error;
    }
  }

  await copyRecursive(localPath, remotePath);
  console.log(`   ✅ Dossier ${path.basename(localPath)} copié avec succès\n`);
}


async function deploy() {
  try {
    // Étape 1: Vérifier la connexion SSH
    console.log('📡 Test de connexion SSH...');
    try {
      const result = await execSSH('echo "SSH connection OK"');
      if (result.code === 0) {
        console.log('✅ Connexion SSH réussie\n');
      } else {
        throw new Error(`SSH command failed with code ${result.code}`);
      }
    } catch (error) {
      console.error('❌ Impossible de se connecter au NAS');
      console.error('   Vérifiez que:');
      console.error('   - SSH est activé sur le NAS (DSM > Terminal et SNMP > Terminal)');
      console.error('   - Les credentials sont corrects');
      console.error('   - Le NAS est accessible depuis ce poste');
      console.error(`   Erreur: ${error.message}`);
      process.exit(1);
    }

    // Étape 2: Créer le répertoire de destination
    console.log('📁 Création du répertoire de destination...');
    await execSSH(`mkdir -p ${deployPath}`);
    await execSSH(`mkdir -p ${deployPath}/services`);
    await execSSH(`mkdir -p ${deployPath}/logs`);
    console.log('✅ Répertoires créés\n');

    // Étape 3: Vérifier si .env existe
    console.log('⚙️  Vérification de la configuration...');
    const envCheck = await execSSH(`test -f ${deployPath}/.env && echo "ok" || echo "missing"`);
    const envExists = envCheck.stdout.trim() === 'ok';

    // Étape 4: Copier les fichiers
    console.log('📦 Copie des fichiers...');

    const filesToCopy = [
      { local: 'agent', remote: `${deployPath}/agent` },
      { local: 'docker-compose.yml', remote: `${deployPath}/docker-compose.yml` },
      { local: 'env.example', remote: `${deployPath}/env.example` },
    ];

    // Créer un .env sur le NAS si il n'existe pas
    if (!envExists) {
      filesToCopy.push({ local: 'env.example', remote: `${deployPath}/.env` });
      console.log('   Création du fichier .env depuis env.example...');
    }

    for (const file of filesToCopy) {
      const localPath = path.join(__dirname, file.local);
      if (!fs.existsSync(localPath)) {
        console.warn(`⚠️  Fichier introuvable: ${file.local}`);
        continue;
      }

      console.log(`   → ${file.local} → ${file.remote}`);
      try {
        await copySCP(localPath, file.remote);
      } catch (error) {
        console.error(`❌ Erreur lors de la copie de ${file.local}: ${error.message}`);
        throw error;
      }
    }

    // Convertir les fins de ligne Windows en Unix pour deploy.sh et le rendre exécutable
    console.log('   Conversion des fins de ligne et permissions pour deploy.sh...');
    await execSSH(`dos2unix ${deployPath}/agent/deploy.sh 2>/dev/null || sed -i 's/\\r$//' ${deployPath}/agent/deploy.sh`);
    await execSSH(`chmod +x ${deployPath}/agent/deploy.sh`);

    console.log('✅ Fichiers copiés\n');

    // Afficher le statut du .env
    if (!envExists) {
      console.log('⚠️  Fichier .env créé depuis env.example');
      console.log('   Vérifiez/modifiez-le si nécessaire:');
      console.log(`   ssh ${username}@${host} "nano ${deployPath}/.env"`);
    } else {
      console.log('✅ Fichier .env présent');
    }
    console.log();

    // Étape 5: Vérifier Docker et trouver le chemin (Synology)
    console.log('🐳 Vérification de Docker...');
    let dockerCmd = 'docker';
    let composeCmd = 'docker compose';

    // Chemins Synology courants pour Docker
    const dockerPaths = [
      'docker',
      '/usr/local/bin/docker',
      '/var/packages/Docker/target/usr/bin/docker',
      '/usr/bin/docker'
    ];

    let dockerFound = false;
    for (const dockerPath of dockerPaths) {
      try {
        const testResult = await execSSH(`${dockerPath} --version 2>&1`);
        if (testResult.code === 0 || testResult.stdout.includes('version') || testResult.stderr.includes('version')) {
          dockerCmd = dockerPath;
          composeCmd = `${dockerPath} compose`;
          const version = testResult.stdout.trim() || testResult.stderr.trim();
          console.log(`✅ Docker trouvé: ${dockerCmd}`);
          console.log(`   ${version.split('\n')[0]}\n`);
          dockerFound = true;
          break;
        }
      } catch (e) {
        // Continuer à essayer le prochain chemin
        continue;
      }
    }

    if (!dockerFound) {
      console.error('❌ Docker non trouvé sur le NAS.');
      console.error('\n💡 Solutions possibles:');
      console.error('   1. Vérifiez que Docker est installé depuis le DSM Package Center');
      console.error('   2. Trouvez le chemin Docker avec: ssh user@nas "which docker"');
      console.error('   3. Ou ajoutez Docker au PATH dans ~/.bashrc ou ~/.profile');
      console.error('\n   Exemple pour ajouter au PATH:');
      console.error('   ssh user@nas');
      console.error('   echo "export PATH=/usr/local/bin:\$PATH" >> ~/.bashrc');
      console.error('   source ~/.bashrc');
      process.exit(1);
    }

    // Étape 6: Vérifier les permissions Docker
    console.log('🔐 Vérification des permissions Docker...');
    const testDockerCmd = useSudo ? `sudo ${dockerCmd}` : dockerCmd;
    const permissionCheck = await execSSH(`${testDockerCmd} ps 2>&1`);

    // Vérifier le code de retour ET les messages d'erreur dans stdout ou stderr
    const errorOutput = (permissionCheck.stderr || '') + (permissionCheck.stdout || '');
    const hasPermissionError =
      permissionCheck.code !== 0 ||
      errorOutput.includes('permission denied') ||
      errorOutput.includes('dial unix');

    if (hasPermissionError) {
      // Si useSudo est activé, on continue quand même (sudo sera utilisé)
      if (useSudo) {
        console.log('⚠️  Permission refusée sans sudo, mais useSudo est activé - continuation avec sudo...\n');
      } else {
        console.error('\n❌ Permission refusée pour accéder à Docker.\n');

        // Diagnostic supplémentaire (compatible Synology)
        console.log('🔍 Diagnostic en cours...');
        try {
          const userCheck = await execSSH(`id`);
          const dockerSocketCheck = await execSSH(`ls -la /var/run/docker.sock 2>&1`);
          const dockerGroupCheck = await execSSH(`getent group docker 2>&1 || cat /etc/group | grep docker 2>&1`);

          console.log(`   Utilisateur actuel: ${userCheck.stdout.trim() || userCheck.stderr.trim()}`);
          if (dockerGroupCheck.stdout || dockerGroupCheck.stderr) {
            const groupInfo = (dockerGroupCheck.stdout || dockerGroupCheck.stderr).trim();
            console.log(`   Groupe docker: ${groupInfo}`);
            const userInfo = (userCheck.stdout || userCheck.stderr).trim();
            if (userInfo.includes('docker') || groupInfo.includes(username)) {
              console.log(`   ⚠️  Vous êtes dans le groupe docker, mais le socket n'est pas accessible.`);
              console.log(`   💡 Le problème vient probablement des permissions du socket Docker.`);
              console.log(`   💡 Solution: Corrigez les permissions du socket (voir Option 2 ci-dessous).`);
            }
          }
          console.log(`   Socket Docker: ${dockerSocketCheck.stdout.trim() || dockerSocketCheck.stderr.trim()}`);
        } catch (e) {
          // Ignorer les erreurs de diagnostic
        }

        console.error('\n💡 Solutions:');
        console.error('\n   Option 1 - Vérifier et ajouter au groupe docker (Synology):');
        console.error(`   ssh ${username}@${host}`);
        console.error(`   id  # Vérifiez les groupes (cherchez "docker")`);
        console.error(`   sudo synogroup --add docker  # Si le groupe n'existe pas`);
        console.error(`   sudo synogroup --member docker ${username}`);
        console.error(`   # IMPORTANT: Déconnectez-vous (exit) puis reconnectez-vous (ssh) pour que les changements prennent effet`);
        console.error(`   # Après reconnexion, vérifiez: id | grep docker`);

        console.error('\n   Option 2 - Corriger les permissions du socket Docker (RECOMMANDÉ):');
        console.error(`   ssh ${username}@${host}`);
        console.error(`   ls -la /var/run/docker.sock  # Vérifiez les permissions actuelles`);
        console.error(`   sudo chown root:docker /var/run/docker.sock`);
        console.error(`   sudo chmod 660 /var/run/docker.sock`);
        console.error(`   # Testez: docker ps`);
        console.error(`   # Si ça fonctionne, relancez: npm run deploy`);

        console.error('\n   Option 3 - Utiliser sudo (solution rapide):');
        console.error(`   Modifiez .nas-credentials et ajoutez: "useSudo": true`);
        console.error(`   Le script utilisera alors sudo pour toutes les commandes Docker`);

        console.error('\n   Option 4 - Vérifier le propriétaire du socket:');
        console.error(`   ssh ${username}@${host} "ls -la /var/run/docker.sock"`);
        console.error(`   # Le socket doit être accessible par votre utilisateur ou le groupe docker\n`);

        process.exit(1);
      }
    }

    if (!hasPermissionError || useSudo) {
      console.log('✅ Permissions Docker OK\n');
    }

    // Étape 7: Vérifier que les fichiers nécessaires sont présents
    console.log('🔍 Vérification des fichiers nécessaires...');
    const fileCheck = await execSSH(`cd ${deployPath} && ls -la agent/Dockerfile agent/package.json docker-compose.yml 2>&1`);
    if (fileCheck.code !== 0 || fileCheck.stderr.includes('No such file')) {
      console.error('❌ Fichiers manquants pour le build Docker');
      console.error(`   ${fileCheck.stderr || fileCheck.stdout}`);
      process.exit(1);
    }
    console.log('✅ Fichiers présents\n');

    // Étape 8: Lancer docker compose
    console.log('🚀 Démarrage de Dynogy Agent...');

    // Utiliser sudo si configuré dans les credentials
    const finalDockerCmd = useSudo ? `sudo ${dockerCmd}` : dockerCmd;
    const finalComposeCmd = useSudo ? `sudo ${composeCmd}` : composeCmd;

    if (useSudo) {
      console.log(`   (Utilisation de sudo pour Docker)\n`);
    }

    console.log(`   cd ${deployPath} && ${finalComposeCmd} up -d --build\n`);

    const deployResult = await execSSH(`cd ${deployPath} && ${finalComposeCmd} up -d --build`);
    if (deployResult.stdout) {
      console.log(deployResult.stdout);
    }
    if (deployResult.stderr && deployResult.code !== 0) {
      if (deployResult.stderr.includes('permission denied')) {
        console.error('\n❌ Permission refusée. Voir les instructions ci-dessus.\n');
        process.exit(1);
      }
      console.error(deployResult.stderr);
    }

    // Étape 9: Vérifier le statut
    console.log('\n📊 Vérification du statut...');
    const statusResult = await execSSH(`cd ${deployPath} && ${finalComposeCmd} ps`);
    console.log(statusResult.stdout);
    if (statusResult.stderr && !statusResult.stderr.includes('permission denied')) {
      console.log(statusResult.stderr);
    }

    console.log('\n✅ Déploiement terminé !');
    console.log('\n📝 Prochaines étapes:');
    console.log(`   1. Vérifiez les logs: ssh ${username}@${host} "cd ${deployPath} && docker compose logs -f dynogy-agent"`);
    console.log(`   2. Configurez le reverse proxy dans DSM`);
    console.log(`   3. Testez l'endpoint: curl http://${host}:4000/health`);

  } catch (error) {
    console.error('\n❌ Erreur lors du déploiement:', error.message);
    if (error.stderr) {
      console.error('STDERR:', error.stderr);
    }
    process.exit(1);
  }
}

// Lancer le déploiement
deploy();

