import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key, authorization');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Authentication middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

// Shopify GraphQL helper
async function shopifyGraphQL(query, variables = {}) {
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;
  const domain = process.env.MYSHOPIFY_DOMAIN;
  
  const response = await fetch(`https://${domain}/admin/api/2024-01/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': accessToken,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Shopify API error: ${response.statusText}`);
  }

  const result = await response.json();
  
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

// Tool definitions and handlers
const toolDefinitions = [
  {
    name: 'get-products',
    description: 'Get all products or search by title',
    inputSchema: {
      type: 'object',
      properties: {
        searchTitle: {
          type: 'string',
          description: 'Filter products by title (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of products to return',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get-product-by-id',
    description: 'Get a specific product by ID',
    inputSchema: {
      type: 'object',
      properties: {
        productId: {
          type: 'string',
          description: 'ID of the product to retrieve',
        },
      },
      required: ['productId'],
    },
  },
  {
    name: 'get-customers',
    description: 'Get customers or search by name/email',
    inputSchema: {
      type: 'object',
      properties: {
        searchQuery: {
          type: 'string',
          description: 'Filter customers by name or email (optional)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of customers to return',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get-orders',
    description: 'Get orders with optional filtering',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Maximum number of orders to return',
          default: 10,
        },
      },
    },
  },
  {
    name: 'get-order-by-id',
    description: 'Get a specific order by ID',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: {
          type: 'string',
          description: 'Shopify order ID',
        },
      },
      required: ['orderId'],
    },
  },
];

// Tool execution handlers
async function executeGetProducts(args) {
  const limit = args.limit || 10;
  const query = `
    query getProducts($first: Int!, $query: String) {
      products(first: $first, query: $query) {
        edges {
          node {
            id
            title
            descriptionHtml
            vendor
            productType
            tags
            status
            totalInventory
          }
        }
      }
    }
  `;
  
  const variables = {
    first: limit,
    query: args.searchTitle ? `title:*${args.searchTitle}*` : null,
  };
  
  const data = await shopifyGraphQL(query, variables);
  return data.products.edges.map(e => e.node);
}

async function executeGetProductById(args) {
  const query = `
    query getProduct($id: ID!) {
      product(id: $id) {
        id
        title
        descriptionHtml
        vendor
        productType
        tags
        status
        totalInventory
      }
    }
  `;
  
  const data = await shopifyGraphQL(query, { id: args.productId });
  return data.product;
}

async function executeGetCustomers(args) {
  const limit = args.limit || 10;
  const query = `
    query getCustomers($first: Int!, $query: String) {
      customers(first: $first, query: $query) {
        edges {
          node {
            id
            firstName
            lastName
            email
            phone
            tags
            ordersCount
          }
        }
      }
    }
  `;
  
  const data = await shopifyGraphQL(query, {
    first: limit,
    query: args.searchQuery || null,
  });
  
  return data.customers.edges.map(e => e.node);
}

async function executeGetOrders(args) {
  const limit = args.limit || 10;
  const query = `
    query getOrders($first: Int!) {
      orders(first: $first) {
        edges {
          node {
            id
            name
            email
            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
          }
        }
      }
    }
  `;
  
  const data = await shopifyGraphQL(query, { first: limit });
  return data.orders.edges.map(e => e.node);
}

async function executeGetOrderById(args) {
  const query = `
    query getOrder($id: ID!) {
      order(id: $id) {
        id
        name
        email
        phone
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress {
          address1
          address2
          city
          province
          country
          zip
        }
      }
    }
  `;
  
  const data = await shopifyGraphQL(query, { id: args.orderId });
  return data.order;
}

// Map tool names to handlers
const toolHandlers = {
  'get-products': executeGetProducts,
  'get-product-by-id': executeGetProductById,
  'get-customers': executeGetCustomers,
  'get-orders': executeGetOrders,
  'get-order-by-id': executeGetOrderById,
};

// Create MCP server instance (singleton)
const mcpServer = new Server(
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

// Register tools/list handler
mcpServer.setRequestHandler('tools/list', async () => {
  console.log('Listing tools');
  return {
    tools: toolDefinitions,
  };
});

// Register tools/call handler
mcpServer.setRequestHandler('tools/call', async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};
  
  console.log(`Calling tool: ${toolName}`, args);
  
  const handler = toolHandlers[toolName];
  if (!handler) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  try {
    const result = await handler(args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error(`Error executing tool ${toolName}:`, error);
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Store active transports
let currentTransport = null;

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    hasShopifyCredentials: !!(process.env.SHOPIFY_ACCESS_TOKEN && process.env.MYSHOPIFY_DOMAIN),
  });
});

// SSE endpoint - this is where Voiceflow will connect
app.get('/sse', authenticate, async (req, res) => {
  console.log('New SSE connection established');
  
  // Validate environment variables
  if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.MYSHOPIFY_DOMAIN) {
    console.error('Missing Shopify credentials');
    return res.status(500).json({ 
      error: 'Missing SHOPIFY_ACCESS_TOKEN or MYSHOPIFY_DOMAIN' 
    });
  }

  try {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Create SSE transport with the response object
    currentTransport = new SSEServerTransport('/messages', res);
    
    // Connect server to transport
    await mcpServer.connect(currentTransport);
    
    console.log('Shopify MCP server connected via SSE');
    
    // Keep connection alive
    req.on('close', () => {
      console.log('SSE connection closed');
      currentTransport = null;
    });
  } catch (error) {
    console.error('Error setting up SSE connection:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// POST endpoint for messages (required by SSE transport)
app.post('/messages', authenticate, async (req, res) => {
  console.log('Received message on /messages endpoint');
  
  if (currentTransport) {
    try {
      await currentTransport.handlePostMessage(req, res);
    } catch (error) {
      console.error('Error handling POST message:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  } else {
    res.status(503).json({ error: 'No active SSE connection' });
  }
});

app.listen(PORT, () => {
  console.log(`Shopify MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
  console.log(`Messages endpoint: http://localhost:${PORT}/messages`);
});
