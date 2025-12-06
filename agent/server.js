#!/usr/bin/env node

const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// Configuration from environment variables
const PORT = process.env.DYNOGY_PORT || 4000;
const SERVICES_DIR = process.env.SERVICES_DIR || '/volume1/docker/dynogy/services';
const DEPLOY_LOG_DIR = process.env.DEPLOY_LOG_DIR || '/volume1/docker/dynogy/logs';
const DEPLOY_SCRIPT = path.join(__dirname, 'deploy.sh');

// Ensure log directory exists
if (!fs.existsSync(DEPLOY_LOG_DIR)) {
  fs.mkdirSync(DEPLOY_LOG_DIR, { recursive: true });
}

// In-memory state (simple for V1)
const state = {
  version: '1.0.0',
  services: {},
  lastDeploy: null
};

/**
 * Detect services from SERVICES_DIR
 */
function detectServices() {
  const services = {};
  try {
    if (fs.existsSync(SERVICES_DIR)) {
      const entries = fs.readdirSync(SERVICES_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const composeFile = path.join(SERVICES_DIR, entry.name, 'docker-compose.yml');
          if (fs.existsSync(composeFile)) {
            services[entry.name] = {
              name: entry.name,
              path: path.join(SERVICES_DIR, entry.name),
              composeFile: composeFile,
              lastDeploy: state.services[entry.name]?.lastDeploy || null
            };
          }
        }
      }
    }
  } catch (error) {
    console.error('Error detecting services:', error.message);
  }
  return services;
}

/**
 * Extract repository name from webhook payload
 * Supports both GitHub and GitLab formats
 */
function extractRepoInfo(payload) {
  let repoName = null;
  let ref = null;
  let branch = null;

  // GitHub format
  if (payload.repository && payload.repository.name) {
    repoName = payload.repository.name;
  }
  // GitLab format
  else if (payload.project && payload.project.name) {
    repoName = payload.project.name;
  }
  // Fallback: try repository.full_name (GitHub) or project.path_with_namespace (GitLab)
  else if (payload.repository && payload.repository.full_name) {
    repoName = payload.repository.full_name.split('/').pop();
  }
  else if (payload.project && payload.project.path_with_namespace) {
    repoName = payload.project.path_with_namespace.split('/').pop();
  }

  // Extract ref/branch
  if (payload.ref) {
    ref = payload.ref;
    branch = ref.replace('refs/heads/', '').replace('refs/tags/', '');
  }

  return { repoName, ref, branch };
}

/**
 * Trigger deployment script
 */
function triggerDeployment(serviceName, repoPath) {
  return new Promise((resolve, reject) => {
    const logFile = path.join(DEPLOY_LOG_DIR, `${serviceName}-${Date.now()}.log`);
    const command = `bash "${DEPLOY_SCRIPT}" "${serviceName}" "${repoPath}" "${SERVICES_DIR}" "${logFile}"`;

    exec(command, (error, stdout, stderr) => {
      // Log output
      const logContent = `=== Deployment started at ${new Date().toISOString()} ===\n` +
                        `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}\n` +
                        `=== Deployment finished at ${new Date().toISOString()} ===\n` +
                        `Exit code: ${error ? error.code : 0}\n`;

      try {
        fs.appendFileSync(logFile, logContent);
      } catch (logError) {
        console.error('Failed to write log file:', logError.message);
      }

      if (error) {
        console.error(`Deployment failed for ${serviceName}:`, error.message);
        reject(error);
      } else {
        console.log(`Deployment completed for ${serviceName}`);
        resolve({ stdout, stderr });
      }
    });
  });
}

// GET /status - System status endpoint
app.get('/status', (req, res) => {
  const services = detectServices();
  state.services = services;

  res.json({
    version: state.version,
    status: 'running',
    services: Object.keys(services).map(name => ({
      name: name,
      path: services[name].path,
      lastDeploy: services[name].lastDeploy
    })),
    lastDeploy: state.lastDeploy,
    config: {
      servicesDir: SERVICES_DIR,
      logDir: DEPLOY_LOG_DIR,
      port: PORT
    }
  });
});

// POST /webhook - Git webhook endpoint
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;

    // Extract repository information
    const { repoName, ref, branch } = extractRepoInfo(payload);

    if (!repoName) {
      return res.status(400).json({
        error: 'Could not extract repository name from webhook payload'
      });
    }

    // Filter by branch (only deploy main/master by default)
    const allowedBranches = ['main', 'master'];
    if (branch && !allowedBranches.includes(branch)) {
      return res.status(200).json({
        message: `Branch ${branch} ignored. Only ${allowedBranches.join(', ')} branches trigger deployment.`
      });
    }

    // TODO V2: Verify webhook signature here
    // const signature = req.headers['x-hub-signature-256'] || req.headers['x-gitlab-token'];
    // if (!verifySignature(signature, payload)) {
    //   return res.status(401).json({ error: 'Invalid signature' });
    // }

    // Determine service path
    // Auto-detect: use repo name as service name
    const serviceName = repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const repoPath = path.join(SERVICES_DIR, serviceName);

    console.log(`Webhook received for ${repoName} (${branch}), deploying to ${repoPath}`);

    // Trigger deployment asynchronously
    triggerDeployment(serviceName, repoPath)
      .then(() => {
        // Update state
        state.lastDeploy = new Date().toISOString();
        if (state.services[serviceName]) {
          state.services[serviceName].lastDeploy = state.lastDeploy;
        }
        console.log(`Deployment completed successfully for ${serviceName}`);
      })
      .catch((error) => {
        console.error(`Deployment failed for ${serviceName}:`, error.message);
      });

    // Return immediately (deployment runs in background)
    res.status(202).json({
      message: 'Deployment triggered',
      service: serviceName,
      branch: branch,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dynogy Agent v${state.version} running on port ${PORT}`);
  console.log(`Services directory: ${SERVICES_DIR}`);
  console.log(`Log directory: ${DEPLOY_LOG_DIR}`);
  
  // Initial service detection
  state.services = detectServices();
  console.log(`Detected ${Object.keys(state.services).length} service(s)`);
});

