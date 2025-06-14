import { z } from "zod";

// Environment variables interface
interface Env {
  LAYRPAY_API_BASE_URL: string;
  LAYRPAY_USER_ID: string;
}

// LayrPay API response interface
interface LayrPayApiResponse {
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
  };
}

// Tool response helper
function createToolResponse(data: any, isError: boolean = false) {
							return {
								content: [
									{
        type: "text" as const,
        text: JSON.stringify(data, null, 2)
      }
    ],
    isError
  };
}

// HTTP request helper with proper error handling
async function makeApiRequest(
  url: string, 
  method: 'GET' | 'POST' = 'GET', 
  body?: any,
  userId?: string
): Promise<LayrPayApiResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (userId) {
    headers['x-layrpay-user-id'] = userId;
  }

  const requestInit: RequestInit = {
    method,
    headers,
  };

  if (body && method === 'POST') {
    requestInit.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(url, requestInit);
    
    // Handle different content types
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      const data: any = await response.json();
      return {
        success: response.ok,
        data: data.success ? data.data : data,
        error: !response.ok ? (data.error || { code: 'HTTP_ERROR', message: `HTTP ${response.status}` }) : undefined
      };
    } else {
      // Handle non-JSON responses
      const text = await response.text();
      return {
        success: response.ok,
        data: text,
        error: !response.ok ? { code: 'HTTP_ERROR', message: `HTTP ${response.status}: ${text}` } : undefined
      };
    }
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'NETWORK_ERROR',
        message: error instanceof Error ? error.message : 'Unknown network error'
      }
    };
  }
}

// SSE streaming handler for validate-transaction
async function handleStreamingValidation(
  url: string, 
  body: any, 
  userId: string
): Promise<LayrPayApiResponse> {
  const headers = {
    'Content-Type': 'application/json',
    'x-layrpay-user-id': userId,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    const contentType = response.headers.get('content-type') || '';
    
    // Handle JSON response (auto-approved transactions)
    if (contentType.includes('application/json')) {
      const data: any = await response.json();
      return {
        success: response.ok,
        data: data.success ? data.data : data,
        error: !response.ok ? (data.error || { code: 'HTTP_ERROR', message: `HTTP ${response.status}` }) : undefined
      };
    }
    
    // Handle SSE streaming response
    if (contentType.includes('text/event-stream')) {
      return new Promise((resolve, reject) => {
        const reader = response.body?.getReader();
        if (!reader) {
          reject(new Error('No response body reader available'));
          return;
        }

        const decoder = new TextDecoder();
        let buffer = '';

        const processStream = async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              
              if (done) {
                reject(new Error('SSE stream ended without final status'));
						break;
				}

              buffer += decoder.decode(value, { stream: true });
              
              // Process complete lines
              const lines = buffer.split('\n');
              buffer = lines.pop() || ''; // Keep incomplete line in buffer
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  try {
                    const eventData = JSON.parse(line.slice(6));
                    
                    // Check if this is a final status (not pending)
                    if (eventData.status && eventData.status !== 'pending') {
                      resolve({
                        success: true,
                        data: eventData
                      });
                      return;
                    }
                  } catch (parseError) {
                    console.error('Error parsing SSE data:', parseError);
                  }
                }
              }
            }
          } catch (error) {
            reject(error);
          }
        };

        processStream();
        
        // Set timeout for SSE requests
        setTimeout(() => {
          reader.cancel();
          reject(new Error('SSE request timeout'));
        }, 120000); // 2 minute timeout
      });
    }
    
    throw new Error(`Unexpected content type: ${contentType}`);
  } catch (error) {
    return {
      success: false,
      error: {
        code: 'STREAMING_ERROR',
        message: error instanceof Error ? error.message : 'Unknown streaming error'
      }
    };
  }
}

// Note: The original MCP Server class is no longer used since we handle MCP protocol directly

// Export for Cloudflare Workers
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

    // Handle SSE endpoint
    if (url.pathname === '/sse') {
      // For SSE, we need to handle both GET and POST in a streaming fashion
      // The MCP Inspector expects a bidirectional SSE connection
      
      const headers = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      };

      if (request.method === 'GET') {
        // Initial SSE connection - just return a basic stream
        return new Response('data: {"jsonrpc":"2.0","method":"notifications/initialized"}\n\n', {
          status: 200,
          headers
        });
      }

      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      // Handle MCP requests directly without the server wrapper
      
      try {
        // Handle the MCP request
        const body = await request.text();
        console.log('Received request body:', body);
        
        const mcpRequest = JSON.parse(body);
        console.log('Parsed MCP request:', JSON.stringify(mcpRequest, null, 2));
        
        // Handle different MCP methods directly
        let response: any;
        
        if (mcpRequest.method === 'initialize') {
          response = {
            jsonrpc: "2.0",
            id: mcpRequest.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: {
                tools: {
                  listChanged: true
                },
                logging: {}
              },
              serverInfo: {
                name: "layrpay-mcp-server",
                version: "1.0.0"
              }
            }
          };
        } else if (mcpRequest.method === 'tools/list') {
           response = {
             jsonrpc: "2.0",
             id: mcpRequest.id,
             result: {
               tools: [
                 {
                   name: "layrpay_get_info",
                   description: "Get LayrPay MCP server information and available endpoints",
                   inputSchema: {
                     type: "object",
                     properties: {},
                   },
                 },
                 {
                   name: "layrpay_get_limits",
                   description: "Get user's spending limits and available balances for AI agent spending",
                   inputSchema: {
                     type: "object",
                     properties: {
                       currency: {
                         type: "string",
                         description: "Optional currency code (e.g., USD, EUR) to convert limits to"
                       }
                     }
                   }
                 },
                 {
                   name: "layrpay_validate_transaction",
                   description: "Validate a transaction request against user spending limits and obtain authorization when needed. This tool implements LayrPay's smart authorization system with automatic currency conversion: transactions within all spending limits are auto-approved instantly with a validation token, while transactions exceeding any limit (per-transaction, daily, weekly, or monthly) require explicit user authorization through the LayrPay app. The system automatically converts foreign currency transactions to the user's base currency using real-time exchange rates for accurate limit validation. Enhanced with product context for realistic checkout simulation and transaction tracking. The tool returns immediately with the transaction status - either auto-approved with a token for immediate use, or pending with an authorization ID that the user must approve. Use this before any payment to ensure compliance with user spending controls and to acquire the validation token required to generate the virtual payment card that completes the transaction.",
                   inputSchema: {
                     type: "object",
                     properties: {
                       merchant: {
                         type: "object",
                         properties: {
                           name: {
                             type: "string",
                             description: "Name of the merchant (e.g., 'Amazon', 'Starbucks', 'Local Coffee Shop'). This appears in user authorization requests, so be descriptive."
                           },
                           category: {
                             type: "string",
                             description: "Merchant category for user context (e.g., 'retail', 'food', 'entertainment', 'subscription', 'travel'). Helps users understand the purchase type."
                           }
                         },
                         required: ["name"]
                       },
                       amount: {
                         type: "number",
                         description: "Transaction amount in the specified currency (must be positive). This is checked against user's per-transaction, daily, weekly, and monthly spending limits."
                       },
                       currency: {
                         type: "string",
                         description: "ISO currency code (e.g., 'USD', 'EUR', 'GBP'). Must match user's account currency for limit validation."
                       },
                       product: {
                         type: "object",
                         description: "Detailed product information for enhanced checkout simulation and transaction tracking (recommended for testing)",
                         properties: {
                           title: {
                             type: "string",
                             description: "The product name/title (required, max 200 characters)"
                           },
                           price: {
                             type: "number",
                             description: "Product price (must exactly match transaction amount)"
                           },
                           currency: {
                             type: "string",
                             description: "Product currency (must exactly match transaction currency)"
                           },
                           description: {
                             type: "string",
                             description: "Product description (recommended for better context)"
                           },
                           brand: {
                             type: "string",
                             description: "Product brand name (recommended)"
                           },
                           category: {
                             type: "string",
                             description: "Product category (recommended, e.g. 'Electronics', 'Clothing')"
                           },
                           sku: {
                             type: "string",
                             description: "Product SKU/model number (optional)"
                           },
                           image_url: {
                             type: "string",
                             description: "Product image URL (optional, must be valid URL)"
                           },
                           product_url: {
                             type: "string",
                             description: "Product page URL (optional, must be valid URL)"
                           },
                           agent_reasoning: {
                             type: "string",
                             description: "Explanation of why the agent selected this product (optional, for context)"
                           },
                           user_intent: {
                             type: "string",
                             description: "What the user originally requested (optional, for context)"
                           }
                         },
                         required: ["title", "price", "currency"]
                       },
                       timeout: {
                         type: "number",
                         description: "Timeout in seconds for user authorization if required (default: 90, max: 300). Only applies to transactions requiring user approval."
                       },
                       agent_name: {
                         type: "string",
                         description: "Name of the AI agent making the request (e.g., 'Shopping Assistant', 'Travel Planner'). Shown to user in authorization requests for context."
                       }
                     },
                     required: ["merchant", "amount", "currency"]
                   }
                 },
                 {
                   name: "layrpay_create_virtual_card",
                   description: "Create a single-use virtual card for an approved transaction. REQUIRES A VALID VALIDATION TOKEN from layrpay_validate_transaction. The virtual card is automatically issued in the user's local currency (determined by their country/region) and the transaction amount is converted if needed. IMPORTANT: You must use the exact card_amount, card_currency, and exchange_rate values from the 'card_details' field in the validation response to ensure the card is created for the pre-approved amount. The virtual card is locked to the converted transaction amount plus 1% for payment processing fees and expires in 5 minutes. The card will be automatically cancelled after first successful use. Returns full card details including number, CVC, and expiry.",
                   inputSchema: {
                     type: "object",
                     properties: {
                       validation_token: {
                         type: "string",
                         description: "Validation token from layrpay_validate_transaction - REQUIRED"
                       },
                       merchant_name: {
                         type: "string", 
                         description: "Name of the merchant (must match validation request)"
                       },
                       transaction_amount: {
                         type: "number",
                         description: "Original transaction amount (must match validation request)"
                       },
                       transaction_currency: {
                         type: "string",
                         description: "Original transaction currency (must match validation request)"
                       },
                       card_amount: {
                         type: "number", 
                         description: "Card issuance amount from validation response card_details.amount (converted to user's local currency) - REQUIRED"
                       },
                       card_currency: {
                         type: "string",
                         description: "Card issuance currency from validation response card_details.currency (user's local currency) - REQUIRED"
                       },
                       exchange_rate: {
                         type: "number",
                         description: "Exchange rate from validation response card_details.exchange_rate (if currency conversion was applied)"
                       },
                       agent_name: {
                         type: "string",
                         description: "Name of the AI agent creating the card"
                       }
                     },
                     required: ["validation_token", "merchant_name", "transaction_amount", "transaction_currency", "card_amount", "card_currency"]
                   }
                 },
                 {
                   name: "layrpay_mock_checkout",
                   description: "Simulates e-commerce checkout experience using virtual card details for end-to-end testing. Use this AFTER receiving virtual card details from layrpay_create_virtual_card. Pass the exact card details and customer information from the virtual card response. The checkout amount is automatically determined from the linked transaction. Simulates realistic payment processing delays and includes complete order confirmation with tracking and receipt details. Updates transaction and virtual card status in the system.",
                   inputSchema: {
                     type: "object",
                     properties: {
                       card_details: {
                         type: "object",
                         description: "Virtual card details received from layrpay_create_virtual_card",
                         properties: {
                           card_number: {
                             type: "string",
                             description: "Full virtual card number"
                           },
                           cvc: {
                             type: "string", 
                             description: "Card CVC/CVV code"
                           },
                           exp_month: {
                             type: "number",
                             description: "Card expiration month (1-12)"
                           },
                           exp_year: {
                             type: "number",
                             description: "Card expiration year"
                           }
                         },
                         required: ["card_number", "cvc", "exp_month", "exp_year"]
                       },
                       customer_details: {
                         type: "object",
                         description: "Customer details received from layrpay_create_virtual_card response",
                         properties: {
                           email: {
                             type: "string",
                             description: "Customer email address"
                           },
                           firstName: {
                             type: "string",
                             description: "Customer first name"
                           },
                           lastName: {
                             type: "string",
                             description: "Customer last name"
                           },
                           phone: {
                             type: "string",
                             description: "Customer phone number (optional)"
                           },
                           billingAddress: {
                             type: "object",
                             description: "Customer billing address",
                             properties: {
                               line1: { type: "string", description: "Address line 1" },
                               line2: { type: "string", description: "Address line 2 (optional)" },
                               city: { type: "string", description: "City" },
                               state: { type: "string", description: "State/Province (optional)" },
                               postalCode: { type: "string", description: "Postal/ZIP code" },
                               country: { type: "string", description: "Country code (e.g., 'US', 'CA')" }
                             },
                             required: ["line1", "city", "postalCode", "country"]
                           },
                           shippingAddress: {
                             type: "object",
                             description: "Customer shipping address",
                             properties: {
                               line1: { type: "string", description: "Address line 1" },
                               line2: { type: "string", description: "Address line 2 (optional)" },
                               city: { type: "string", description: "City" },
                               state: { type: "string", description: "State/Province (optional)" },
                               postalCode: { type: "string", description: "Postal/ZIP code" },
                               country: { type: "string", description: "Country code (e.g., 'US', 'CA')" }
                             },
                             required: ["line1", "city", "postalCode", "country"]
                           }
                         },
                         required: ["email", "firstName", "lastName", "billingAddress", "shippingAddress"]
                       }
                     },
                     required: ["card_details", "customer_details"]
                   }
                 }
               ]
             }
           };
        } else if (mcpRequest.method === 'tools/call') {
          // Handle tool calls
          const toolName = mcpRequest.params?.name;
          const toolArgs = mcpRequest.params?.arguments || {};
          
          console.log('Tool call:', toolName, toolArgs);
          
          try {
            let toolResult: any;
            
            switch (toolName) {
              case "layrpay_get_info": {
                const apiResponse = await makeApiRequest(
                  `${env.LAYRPAY_API_BASE_URL}/info`,
                  'GET',
                  undefined,
                  env.LAYRPAY_USER_ID
                );
                
                if (!apiResponse.success) {
                  throw new Error(`API Error: ${apiResponse.error?.message || 'Unknown error'}`);
                }
                
                toolResult = createToolResponse(apiResponse.data);
                break;
              }

              case "layrpay_get_limits": {
                const url = new URL(`${env.LAYRPAY_API_BASE_URL}/limits`);
                if (toolArgs?.currency && typeof toolArgs.currency === 'string') {
                  url.searchParams.set('currency', toolArgs.currency);
                }
                
                const apiResponse = await makeApiRequest(
                  url.toString(),
                  'GET',
                  undefined,
                  env.LAYRPAY_USER_ID
                );
                
                if (!apiResponse.success) {
                  throw new Error(`API Error: ${apiResponse.error?.message || 'Unknown error'}`);
                }
                
                toolResult = createToolResponse(apiResponse.data);
                break;
              }

              case "layrpay_validate_transaction": {
                const apiResponse = await handleStreamingValidation(
                  `${env.LAYRPAY_API_BASE_URL}/validate-transaction`,
                  toolArgs,
                  env.LAYRPAY_USER_ID
                );
                
                if (!apiResponse.success) {
                  throw new Error(`Validation Error: ${apiResponse.error?.message || 'Unknown error'}`);
                }
                
                toolResult = createToolResponse(apiResponse.data);
                break;
              }

              case "layrpay_create_virtual_card": {
                const apiResponse = await makeApiRequest(
                  `${env.LAYRPAY_API_BASE_URL}/create-virtual-card`,
                  'POST',
                  toolArgs,
                  env.LAYRPAY_USER_ID
                );
                
                if (!apiResponse.success) {
                  throw new Error(`Card Creation Error: ${apiResponse.error?.message || 'Unknown error'}`);
                }
                
                toolResult = createToolResponse(apiResponse.data);
                break;
              }

              case "layrpay_mock_checkout": {
                const apiResponse = await makeApiRequest(
                  `${env.LAYRPAY_API_BASE_URL}/mock-checkout`,
                  'POST',
                  toolArgs,
                  env.LAYRPAY_USER_ID
                );
                
                if (!apiResponse.success) {
                  throw new Error(`Checkout Error: ${apiResponse.error?.message || 'Unknown error'}`);
                }
                
                toolResult = createToolResponse(apiResponse.data);
                break;
              }

              default:
                throw new Error(`Unknown tool: ${toolName}`);
            }
            
            response = {
              jsonrpc: "2.0",
              id: mcpRequest.id,
              result: toolResult
            };
          } catch (error) {
            console.error('Tool execution error:', error);
            response = {
              jsonrpc: "2.0",
              id: mcpRequest.id,
              error: {
                code: -32603,
                message: `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`
              }
            };
          }
        } else if (mcpRequest.method === 'notifications/initialized') {
          // Handle initialized notification - no response needed for notifications
          console.log('Received initialized notification');
          
          // After initialization, some clients expect an immediate tools/list response
          // Let's send a tools/list notification to help Claude Desktop discover tools
          console.log('Client initialized - tools should be discoverable via tools/list method');
          
          return new Response('', {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            }
          });
        } else if (mcpRequest.method.startsWith('notifications/')) {
          // Handle other notifications - no response needed
          console.log('Received notification:', mcpRequest.method);
          return new Response('', {
            status: 204,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Methods': 'POST, OPTIONS',
              'Access-Control-Allow-Headers': 'Content-Type',
            }
          });
        } else {
          response = {
            jsonrpc: "2.0",
            id: mcpRequest.id,
            error: {
              code: -32601,
              message: "Method not found"
            }
          };
        }
        
        console.log('Sending response:', response);
        
        // Return the response as SSE
        const sseData = `data: ${JSON.stringify(response)}\n\n`;
        
        return new Response(sseData, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      } catch (error) {
        console.error('Error processing request:', error);
        
        const errorResponse = {
          jsonrpc: "2.0",
          error: {
            code: -32700,
            message: `Parse error: ${error instanceof Error ? error.message : 'Unknown error'}`
          },
          id: null
        };
        
        const sseData = `data: ${JSON.stringify(errorResponse)}\n\n`;
        
        return new Response(sseData, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
        });
      }
    }
    
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    
    return new Response('Not found', { status: 404 });
  },
}; 