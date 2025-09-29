import express from 'express';

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

// Shopify GraphQL
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

// Tool handlers
const tools = {
  'get-products': {
    name: 'get-products',
    description: 'Get all products or search by title',
    inputSchema: {
      type: 'object',
      properties: {
        searchTitle: { type: 'string', description: 'Filter products by title (optional)' },
        limit: { type: 'number', description: 'Maximum number of products to return', default: 10 },
      },
    },
    handler: async (args) => {
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
  },
  'get-product-by-id': {
    name: 'get-product-by-id',
    description: 'Get a specific product by ID',
    inputSchema: {
      type: 'object',
      properties: { productId: { type: 'string', description: 'ID of the product to retrieve' } },
      required: ['productId'],
    },
    handler: async (args) => {
      const query = `query getProduct($id: ID!) {
        product(id: $id) { id title descriptionHtml vendor productType tags status totalInventory }
      }`;
      const data = await shopifyGraphQL(query, { id: args.productId });
      return data.product;
    },
  },
  'get-customers': {
    name: 'get-customers',
    description: 'Get customers or search by name/email',
    inputSchema: {
      type: 'object',
      properties: {
        searchQuery: { type: 'string', description: 'Filter customers by name or email (optional)' },
        limit: { type: 'number', description: 'Maximum number of customers to return', default: 10 },
      },
    },
    handler: async (args) => {
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
  },
  'get-orders': {
    name: 'get-orders',
    description: 'Get orders with optional filtering',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum number of orders to return', default: 10 },
      },
    },
    handler: async (args) => {
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
  },
  'get-order-by-id': {
    name: 'get-order-by-id',
    description: 'Get a specific order by ID',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string', description: 'Shopify order ID' } },
      required: ['orderId'],
    },
    handler: async (args) => {
      const query = `query getOrder($id: ID!) {
        order(id: $id) {
          id name email phone
          totalPriceSet { shopMoney { amount currencyCode } }
          createdAt displayFinancialStatus displayFulfillmentStatus
          shippingAddress { address1 address2 city province country zip }
        }
      }`;
      const data = await shopifyGraphQL(query, { id: args.orderId });
      return data.order;
    },
  },
};

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    hasShopifyCredentials: !!(process.env.SHOPIFY_ACCESS_TOKEN && process.env.MYSHOPIFY_DOMAIN),
  });
});

// MCP Info
app.get('/', (req, res) => {
  res.json({
    name: 'shopify-mcp-server',
    version: '1.0.0',
    description: 'Shopify MCP Server',
    capabilities: ['tools'],
  });
});

// List tools
app.get('/tools', authenticate, (req, res) => {
  res.json({
    tools: Object.values(tools).map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  });
});

// Call tool
app.post('/tools/:toolName', authenticate, async (req, res) => {
  try {
    const tool = tools[req.params.toolName];
    if (!tool) {
      return res.status(404).json({ error: `Tool not found: ${req.params.toolName}` });
    }

    console.log(`Executing tool: ${req.params.toolName}`, req.body);
    const result = await tool.handler(req.body);

    res.json({
      success: true,
      result: result,
    });
  } catch (error) {
    console.error('Tool execution error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`✓ Shopify MCP Server running on port ${PORT}`);
  console.log(`✓ Health: http://localhost:${PORT}/health`);
  console.log(`✓ Tools: http://localhost:${PORT}/tools`);
});
