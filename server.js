import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

// Authentication middleware
const authenticate = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
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

// Define all Shopify tools
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
    handler: async (args) => {
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data.products.edges.map(e => e.node), null, 2),
        }],
      };
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
    handler: async (args) => {
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data.product, null, 2),
        }],
      };
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
    handler: async (args) => {
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
      
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data.customers.edges.map(e => e.node), null, 2),
        }],
      };
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
    handler: async (args) => {
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data.orders.edges.map(e => e.node), null, 2),
        }],
      };
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
    handler: async (args) => {
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
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(data.order, null, 2),
        }],
      };
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

// SSE endpoint for MCP
app.get('/sse', authenticate, async (req, res) => {
  console.log('New SSE connection established');
  
  // Validate environment variables
  if (!process.env.SHOPIFY_ACCESS_TOKEN || !process.env.MYSHOPIFY_DOMAIN) {
    console.error('Missing Shopify credentials');
    return res.status(500).json({ 
      error: 'Missing SHOPIFY_ACCESS_TOKEN or MYSHOPIFY_DOMAIN' 
    });
  }

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

  // List available tools
  server.setRequestHandler('tools/list', async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  // Handle tool calls
  server.setRequestHandler('tools/call', async (request) => {
    const tool = tools.find(t => t.name === request.params.name);
    if (!tool) {
      throw new Error(`Tool not found: ${request.params.name}`);
    }
    
    try {
      return await tool.handler(request.params.arguments || {});
    } catch (error) {
      console.error(`Error executing tool ${request.params.name}:`, error);
      return {
        content: [{
          type: 'text',
          text: `Error: ${error.message}`,
        }],
        isError: true,
      };
    }
  });

  await server.connect(transport);
  console.log('Shopify MCP server connected via SSE');
});

// POST endpoint for messages
app.post('/message', authenticate, async (req, res) => {
  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`Shopify MCP Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
