import express from 'express';
import crypto from 'crypto';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, authorization, Mcp-Session-Id, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Auth middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Store sessions
const sessions = new Map();

// Shopify GraphQL helper
async function shopifyGraphQL(query, variables = {}) {
  const response = await fetch(`https://${process.env.MYSHOPIFY_DOMAIN}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) throw new Error(`Shopify API error: ${response.statusText}`);
  const result = await response.json();
  if (result.errors) throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  return result.data;
}

// Define tools
const tools = [
  {
    name: 'get-products',
    description: 'Get all products or search by title from Shopify store',
    inputSchema: {
      type: 'object',
      properties: {
        searchTitle: { type: 'string', description: 'Filter products by title (optional)' },
        limit: { type: 'number', description: 'Maximum number of products', default: 10 },
      },
    },
  },
  {
    name: 'get-customers',
    description: 'Get customers or search by name/email from Shopify store',
    inputSchema: {
      type: 'object',
      properties: {
        searchQuery: { type: 'string', description: 'Filter customers by name or email (optional)' },
        limit: { type: 'number', description: 'Maximum number of customers', default: 10 },
      },
    },
  },
  {
    name: 'get-orders',
    description: 'Get recent orders from Shopify store',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of orders', default: 10 },
      },
    },
  },
];

// Tool handlers
const toolHandlers = {
  'get-products': async (args) => {
    const query = `query getProducts($first: Int!, $query: String) {
      products(first: $first, query: $query) {
        edges { node { id title descriptionHtml vendor productType tags status totalInventory } }
      }
    }`;
    const data = await shopifyGraphQL(query, {
      first: args?.limit || 10,
      query: args?.searchTitle ? `title:*${args.searchTitle}*` : null,
    });
    return data.products.edges.map(e => e.node);
  },
  'get-customers': async (args) => {
    const query = `query getCustomers($first: Int!, $query: String) {
      customers(first: $first, query: $query) {
        edges { node { id firstName lastName email phone tags ordersCount } }
      }
    }`;
    const data = await shopifyGraphQL(query, {
      first: args?.limit || 10,
      query: args?.searchQuery || null,
    });
    return data.customers.edges.map(e => e.node);
  },
  'get-orders': async (args) => {
    const query = `query getOrders($first: Int!) {
      orders(first: $first) {
        edges {
          node {
            id name email
            totalPriceSet { shopMoney { amount currencyCode } }
            createdAt displayFinancialStatus displayFulfillmentStatus
          }
        }
      }
    }`;
    const data = await shopifyGraphQL(query, { first: args?.limit || 10 });
    return data.orders.edges.map(e => e.node);
  },
};

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasCredentials: !!(process.env.SHOPIFY_ACCESS_TOKEN && process.env.MYSHOPIFY_DOMAIN),
  });
});

// Main MCP endpoint (Streamable HTTP)
app.post('/mcp', authenticate, async (req, res) => {
  try {
    const { jsonrpc, id, method, params } = req.body;

    if (jsonrpc !== '2.0') {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32600, message: 'Invalid JSON-RPC version' }
      });
    }

    console.log(`MCP Request: ${method}`, params);

    // Handle initialize
    if (method === 'initialize') {
      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        initialized: true,
        createdAt: new Date(),
      });

      res.setHeader('Mcp-Session-Id', sessionId);
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'shopify-mcp-server',
            version: '1.0.0',
          },
        },
      });
    }

    // All other requests require session
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId || !sessions.has(sessionId)) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: 'Session not found. Please initialize first.' }
      });
    }

    // Handle tools/list
    if (method === 'tools/list') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: { tools },
      });
    }

    // Handle tools/call
    if (method === 'tools/call') {
      const { name, arguments: toolArgs } = params;
      const handler = toolHandlers[name];

      if (!handler) {
        return res.status(404).json({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Tool not found: ${name}` }
        });
      }

      try {
        const result = await handler(toolArgs || {});
        return res.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          },
        });
      } catch (error) {
        console.error(`Tool ${name} error:`, error);
        return res.status(500).json({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: error.message }
        });
      }
    }

    // Method not found
    return res.status(404).json({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });

  } catch (error) {
    console.error('MCP endpoint error:', error);
    return res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id || null,
      error: { code: -32603, message: 'Internal error' }
    });
  }
});

// Also support GET for compatibility (returns server info)
app.get('/mcp', authenticate, (req, res) => {
  res.json({
    name: 'shopify-mcp-server',
    version: '1.0.0',
    protocol: 'Model Context Protocol',
    transport: 'Streamable HTTP',
  });
});

app.listen(PORT, () => {
  console.log(`✓ Shopify MCP Server (Streamable HTTP) on port ${PORT}`);
  console.log(`✓ Health: http://localhost:${PORT}/health`);
  console.log(`✓ MCP Endpoint: http://localhost:${PORT}/mcp`);
  console.log(`✓ Tools: ${tools.length}`);
});
