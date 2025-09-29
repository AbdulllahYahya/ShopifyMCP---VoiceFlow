import express from 'express';

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

// Tool handlers
const toolHandlers = {
  'get-products': async (args) => {
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
  },

  'get-product-by-id': async (args) => {
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
  },

  'get-customers': async (args) => {
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
  },

  'get-orders': async (args) => {
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
  },

  'get-order-by-id': async (args) => {
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
  },
};

// Tool definitions
const tools = [
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

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    hasShopifyCredentials: !!(process.env.SHOPIFY_ACCESS_TOKEN && process.env.MYSHOPIFY_DOMAIN),
  });
});

// MCP endpoints
app.get('/', (req, res) => {
  res.json({
    name: 'shopify-mcp-server',
    version: '1.0.0',
    description: 'Shopify MCP Server for Voiceflow',
    capabilities: ['tools'],
  });
});

// List tools (MCP standard)
app.post('/tools/list', authenticate, (req, res) => {
  res.json({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });
});

// Also support GET for tools list
app.get('/tools/list', authenticate, (req, res) => {
  res.json({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  });
});

// Call tool (MCP standard)
app.post('/tools/call', authenticate, async (req, res) => {
  try {
    const { name, arguments: args } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Tool name is required' });
    }

    const handler = toolHandlers[name];
    if (!handler) {
      return res.status(404).json({ error: `Tool not found: ${name}` });
    }

    console.log(`Executing tool: ${name}`, args);
    const result = await handler(args || {});
    
    res.json({
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    });
  } catch (error) {
    console.error('Tool execution error:', error);
    res.status(500).json({
      error: error.message,
      content: [{
        type: 'text',
        text: `Error: ${error.message}`,
      }],
    });
  }
});

// Alternative endpoint format that some MCP clients expect
app.post('/mcp/tools/call', authenticate, async (req, res) => {
  try {
    const { name, arguments: args } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Tool name is required' });
    }

    const handler = toolHandlers[name];
    if (!handler) {
      return res.status(404).json({ error: `Tool not found: ${name}` });
    }

    console.log(`Executing tool: ${name}`, args);
    const result = await handler(args || {});
    
    res.json({
      result: result,
      success: true,
    });
  } catch (error) {
    console.error('Tool execution error:', error);
    res.status(500).json({
      error: error.message,
      success: false,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Shopify MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Tools list: http://localhost:${PORT}/tools/list`);
});
