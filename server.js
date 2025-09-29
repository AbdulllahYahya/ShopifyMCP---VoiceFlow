import express from 'express';
import { spawn } from 'child_process';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Auth
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Keep track of active MCP processes
let mcpProcess = null;
let toolsList = null;

// Initialize the Shopify MCP server as a subprocess
function initializeMCPServer() {
  if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.MYSHOPIFY_DOMAIN) {
    console.error('Missing Shopify credentials');
    return;
  }

  console.log('Starting Shopify MCP server...');
  
  mcpProcess = spawn('npx', [
    'shopify-mcp',
    '--accessToken', process.env.SHOPIFY_ACCESS_TOKEN,
    '--domain', process.env.MYSHOPIFY_DOMAIN
  ], {
    stdio: ['pipe', 'pipe', 'pipe']
  });

  mcpProcess.on('error', (error) => {
    console.error('MCP Process error:', error);
  });

  mcpProcess.on('exit', (code) => {
    console.log(`MCP process exited with code ${code}`);
    mcpProcess = null;
  });

  // Send initialization request
  const initRequest = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'voiceflow-bridge', version: '1.0.0' }
    }
  };

  mcpProcess.stdin.write(JSON.stringify(initRequest) + '\n');

  // Listen for tools list
  let buffer = '';
  mcpProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (line.trim()) {
        try {
          const response = JSON.parse(line);
          console.log('MCP Response:', JSON.stringify(response, null, 2));
          
          if (response.result && response.result.capabilities) {
            console.log('MCP initialized successfully');
            // Now request tools list
            requestToolsList();
          }
          
          if (response.result && response.result.tools) {
            toolsList = response.result.tools;
            console.log(`Loaded ${toolsList.length} tools`);
          }
        } catch (e) {
          console.error('Failed to parse MCP response:', e);
        }
      }
    }
  });

  mcpProcess.stderr.on('data', (data) => {
    console.error('MCP stderr:', data.toString());
  });
}

function requestToolsList() {
  if (!mcpProcess) return;
  
  const listRequest = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  };

  mcpProcess.stdin.write(JSON.stringify(listRequest) + '\n');
}

// Call an MCP tool
async function callMCPTool(toolName, args) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess) {
      reject(new Error('MCP server not initialized'));
      return;
    }

    const requestId = Date.now();
    const callRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: args || {}
      }
    };

    let responseHandler;
    const timeout = setTimeout(() => {
      mcpProcess.stdout.off('data', responseHandler);
      reject(new Error('Tool call timeout'));
    }, 30000);

    let buffer = '';
    responseHandler = (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line);
            if (response.id === requestId) {
              clearTimeout(timeout);
              mcpProcess.stdout.off('data', responseHandler);
              
              if (response.error) {
                reject(new Error(response.error.message || 'Tool call failed'));
              } else {
                resolve(response.result);
              }
            }
          } catch (e) {
            // Continue listening for more data
          }
        }
      }
    };

    mcpProcess.stdout.on('data', responseHandler);
    mcpProcess.stdin.write(JSON.stringify(callRequest) + '\n');
  });
}

// Initialize on startup
initializeMCPServer();

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    mcpReady: !!mcpProcess,
    toolsLoaded: !!toolsList,
    toolCount: toolsList?.length || 0
  });
});

// MCP info
app.get('/', (req, res) => {
  res.json({
    name: 'shopify-mcp-bridge',
    version: '1.0.0',
    description: 'HTTP bridge for Shopify MCP Server',
    ready: !!mcpProcess && !!toolsList
  });
});

// List tools (MCP standard endpoint)
app.post('/mcp', authenticate, async (req, res) => {
  try {
    const { method, params } = req.body;

    if (method === 'tools/list') {
      if (!toolsList) {
        return res.status(503).json({ error: 'Tools not yet loaded' });
      }
      return res.json({
        jsonrpc: '2.0',
        id: req.body.id || 1,
        result: { tools: toolsList }
      });
    }

    if (method === 'tools/call') {
      const result = await callMCPTool(params.name, params.arguments);
      return res.json({
        jsonrpc: '2.0',
        id: req.body.id || 1,
        result: result
      });
    }

    res.status(400).json({ error: 'Unknown method' });
  } catch (error) {
    console.error('MCP endpoint error:', error);
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body.id || 1,
      error: { code: -32603, message: error.message }
    });
  }
});

// Also support GET for listing tools
app.get('/tools', authenticate, (req, res) => {
  if (!toolsList) {
    return res.status(503).json({ error: 'Tools not yet loaded' });
  }
  res.json({ tools: toolsList });
});

// Clean shutdown
process.on('SIGTERM', () => {
  if (mcpProcess) {
    mcpProcess.kill();
  }
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`✓ Shopify MCP Bridge running on port ${PORT}`);
  console.log(`✓ Health: http://localhost:${PORT}/health`);
  console.log(`✓ MCP endpoint: http://localhost:${PORT}/mcp`);
});
