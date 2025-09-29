import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createShopifyTools } from 'shopify-mcp/dist/tools.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// Middleware
app.use(express.json());

// Authentication middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SSE endpoint for MCP
app.get('/sse', authenticate, async (req, res) => {
  console.log('New SSE connection established');
  
  const transport = new SSEServerTransport('/message', res);
  const server = new Server(
    {
      name: 'shopify-mcp-server',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Validate environment variables
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const domain = process.env.MYSHOPIFY_DOMAIN;

  if (!accessToken || !domain) {
    console.error('Missing required environment variables');
    return res.status(500).json({ 
      error: 'Server configuration error: Missing Shopify credentials' 
    });
  }

  // Register Shopify tools
  try {
    const tools = createShopifyTools(accessToken, domain);
    
    server.setRequestHandler('tools/list', async () => ({
      tools: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    server.setRequestHandler('tools/call', async (request) => {
      const tool = tools.find(t => t.name === request.params.name);
      if (!tool) {
        throw new Error(`Tool not found: ${request.params.name}`);
      }
      return await tool.handler(request.params.arguments);
    });

    await server.connect(transport);
    console.log('Shopify MCP server connected via SSE');
  } catch (error) {
    console.error('Error setting up MCP server:', error);
    return res.status(500).json({ error: 'Failed to initialize MCP server' });
  }
});

// POST endpoint for MCP messages
app.post('/message', authenticate, async (req, res) => {
  // This endpoint receives messages from the SSE transport
  res.json({ received: true });
});

// Start server
app.listen(PORT, () => {
  console.log(`Shopify MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
