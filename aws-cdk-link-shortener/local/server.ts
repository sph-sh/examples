import express from 'express';
import cors from 'cors';
import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.dev' });

// Import Lambda handlers
const createHandler = require('../lambda/create/index').handler;
const redirectHandler = require('../lambda/redirect/index').handler;
const analyticsHandler = require('../lambda/analytics/index').handler;

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Helper function to convert Express request to API Gateway event
function createAPIGatewayEvent(req: express.Request, pathParameters: any = {}): APIGatewayProxyEvent {
  return {
    httpMethod: req.method,
    path: req.path,
    pathParameters,
    queryStringParameters: req.query as any,
    headers: req.headers as any,
    body: req.method === 'GET' ? null : JSON.stringify(req.body),
    isBase64Encoded: false,
    requestContext: {
      accountId: 'local',
      apiId: 'local',
      domainName: 'localhost',
      domainPrefix: 'local',
      httpMethod: req.method,
      path: req.path,
      protocol: 'HTTP/1.1',
      requestId: `local-${Date.now()}`,
      requestTime: new Date().toISOString(),
      requestTimeEpoch: Date.now(),
      resourceId: 'local',
      resourcePath: req.path,
      stage: 'local',
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: req.ip || '127.0.0.1',
        user: null,
        userAgent: req.get('User-Agent') || 'local-development',
        userArn: null,
      },
      authorizer: {},
    },
    resource: req.path,
    stageVariables: null,
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
  };
}

// Helper function to send Lambda response
async function handleLambdaResponse(
  res: express.Response, 
  handler: Function, 
  event: APIGatewayProxyEvent
): Promise<void> {
  try {
    const context: Context = {
      callbackWaitsForEmptyEventLoop: false,
      functionName: 'local-function',
      functionVersion: '$LATEST',
      invokedFunctionArn: 'arn:aws:lambda:local:123456789012:function:local-function',
      memoryLimitInMB: '256',
      awsRequestId: `local-${Date.now()}`,
      logGroupName: '/aws/lambda/local-function',
      logStreamName: 'local-stream',
      getRemainingTimeInMillis: () => 30000,
      done: () => {},
      fail: () => {},
      succeed: () => {},
    };

    const result: APIGatewayProxyResult = await handler(event, context);
    
    // Set headers
    if (result.headers) {
      Object.entries(result.headers).forEach(([key, value]) => {
        res.set(key, value as string);
      });
    }

    // Send response
    if (result.statusCode >= 300 && result.statusCode < 400 && result.headers?.Location) {
      // Handle redirects
      res.redirect(result.statusCode, String(result.headers.Location));
    } else {
      res.status(result.statusCode);
      if (result.body) {
        // Check if response is JSON
        const contentType = result.headers?.['Content-Type'];
        if (contentType && typeof contentType === 'string' && contentType.includes('application/json')) {
          res.json(JSON.parse(result.body));
        } else {
          res.send(result.body);
        }
      } else {
        res.end();
      }
    }
  } catch (error) {
    console.error('Lambda handler error:', error);
    res.status(500).json({
      success: false,
      error: {
        message: 'Internal server error',
        code: 500,
      },
    });
  }
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    environment: 'development',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
});

// Create short link - POST /api/shorten
app.post('/api/shorten', async (req, res) => {
  const event = createAPIGatewayEvent(req);
  return await handleLambdaResponse(res, createHandler, event);
});

// Get analytics - GET /api/analytics/:shortCode
app.get('/api/analytics/:shortCode', async (req, res) => {
  const event = createAPIGatewayEvent(req, {
    shortCode: req.params.shortCode,
  });
  return await handleLambdaResponse(res, analyticsHandler, event);
});

// Redirect - GET /:shortCode
app.get('/:shortCode', async (req, res) => {
  // Skip API routes and static files
  if (req.params.shortCode.startsWith('api') || 
      req.params.shortCode.includes('.')) {
    return res.status(404).json({ error: 'Not found' });
  }

  const event = createAPIGatewayEvent(req, {
    shortCode: req.params.shortCode,
  });
  return await handleLambdaResponse(res, redirectHandler, event);
});

// Static homepage for development
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Link Shortener - Development</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 800px;
            margin: 2rem auto;
            padding: 0 2rem;
            line-height: 1.6;
            color: #333;
        }
        .container { 
            background: #f8f9fa;
            padding: 2rem;
            border-radius: 8px;
            margin-bottom: 2rem;
        }
        .form-group { 
            margin-bottom: 1rem;
        }
        label { 
            display: block;
            margin-bottom: 0.5rem;
            font-weight: 600;
        }
        input { 
            width: 100%;
            padding: 0.75rem;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 1rem;
        }
        button { 
            background: #007bff;
            color: white;
            padding: 0.75rem 1.5rem;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 1rem;
        }
        button:hover { 
            background: #0056b3;
        }
        .result { 
            margin-top: 1rem;
            padding: 1rem;
            background: #d4edda;
            border: 1px solid #c3e6cb;
            border-radius: 4px;
        }
        .error { 
            background: #f8d7da;
            border-color: #f5c6cb;
            color: #721c24;
        }
        pre { 
            background: #f8f9fa;
            padding: 1rem;
            border-radius: 4px;
            overflow-x: auto;
        }
        .examples {
            background: #e9ecef;
            padding: 1.5rem;
            border-radius: 8px;
            margin-top: 2rem;
        }
    </style>
</head>
<body>
    <h1>🔗 Link Shortener - Development Server</h1>
    
    <div class="container">
        <h2>Create Short Link</h2>
        <form id="shortenForm">
            <div class="form-group">
                <label for="url">URL to shorten:</label>
                <input type="url" id="url" name="url" placeholder="https://example.com/very-long-url" required>
            </div>
            <div class="form-group">
                <label for="customCode">Custom code (optional):</label>
                <input type="text" id="customCode" name="customCode" placeholder="my-custom-code">
            </div>
            <button type="submit">Shorten URL</button>
        </form>
        <div id="result" style="display: none;"></div>
    </div>

    <div class="examples">
        <h3>🧪 API Examples</h3>
        <p><strong>Health Check:</strong> <a href="/api/health" target="_blank">GET /api/health</a></p>
        <p><strong>Create Link via curl:</strong></p>
        <pre>curl -X POST http://localhost:${port}/api/shorten \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com", "customCode": "test123"}'</pre>
        <p><strong>View Analytics:</strong> GET /api/analytics/{shortCode}</p>
        <p><strong>Test Redirect:</strong> GET /{shortCode}</p>
    </div>

    <script>
        document.getElementById('shortenForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const formData = new FormData(e.target);
            const data = {
                url: formData.get('url'),
            };
            
            if (formData.get('customCode')) {
                data.customCode = formData.get('customCode');
            }
            
            const resultDiv = document.getElementById('result');
            resultDiv.style.display = 'block';
            resultDiv.innerHTML = 'Creating short link...';
            resultDiv.className = 'result';
            
            try {
                const response = await fetch('/api/shorten', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(data),
                });
                
                const result = await response.json();
                
                if (result.success) {
                    resultDiv.innerHTML = \`
                        <h4>✅ Short link created!</h4>
                        <p><strong>Short URL:</strong> <a href="\${result.data.shortUrl}" target="_blank">\${result.data.shortUrl}</a></p>
                        <p><strong>Original URL:</strong> \${result.data.originalUrl}</p>
                        <p><strong>Short Code:</strong> \${result.data.shortCode}</p>
                        <p><strong>Created:</strong> \${new Date(result.data.createdAt).toLocaleString()}</p>
                    \`;
                } else {
                    resultDiv.className = 'result error';
                    resultDiv.innerHTML = \`<h4>❌ Error</h4><p>\${result.error.message}</p>\`;
                }
            } catch (error) {
                resultDiv.className = 'result error';
                resultDiv.innerHTML = \`<h4>❌ Network Error</h4><p>\${error.message}</p>\`;
            }
        });
    </script>
</body>
</html>
  `);
});

// Error handling middleware
app.use((error: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Express error:', error);
  res.status(500).json({
    success: false,
    error: {
      message: 'Internal server error',
      code: 500,
    },
  });
});

// Start server
app.listen(port, () => {
  console.log(`🚀 Link Shortener development server running on http://localhost:${port}`);
  console.log(`📖 API Documentation: http://localhost:${port}`);
  console.log(`🏥 Health Check: http://localhost:${port}/api/health`);
  console.log('');
  console.log('Environment variables:');
  console.log(`  LINKS_TABLE_NAME: ${process.env.LINKS_TABLE_NAME}`);
  console.log(`  ANALYTICS_TABLE_NAME: ${process.env.ANALYTICS_TABLE_NAME}`);
  console.log(`  AWS_REGION: ${process.env.AWS_REGION}`);
});

export default app;