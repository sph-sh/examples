import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { createHash } from 'crypto';
import { UAParser } from 'ua-parser-js';

// Initialize DynamoDB client with optimized connection pooling
const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 2, // Reduced for faster failures
  requestHandler: {
    connectionTimeout: 500,  // Faster timeout for redirects
    requestTimeout: 1500,    // Optimized for redirect performance
  },
  // Connection pooling for better performance
  endpoint: process.env.DYNAMODB_ENDPOINT, // Support for local development
});

interface AnalyticsEvent {
  shortCode: string;
  timestamp: number;
  userAgent?: string;
  referer?: string;
  ip?: string;
  country?: string;
  eventType: 'SUCCESS' | 'NOT_FOUND' | 'EXPIRED';
}

interface LinkItem {
  shortCode: string;
  originalUrl: string;
  expiresAt?: number;
  clickCount: number;
  lastClickAt?: number;
}

// Track cold starts for monitoring
const COLD_START = !global.isWarm;
global.isWarm = true;

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  const shortCode = event.pathParameters?.shortCode;
  
  if (!shortCode) {
    return createErrorResponse(400, 'Short code is required');
  }

  // Log request details for monitoring
  console.log(JSON.stringify({
    coldStart: COLD_START,
    shortCode,
    userAgent: event.headers['User-Agent'] || 'unknown',
    referer: event.headers['Referer'] || event.headers['referer'] || 'direct',
    sourceIp: event.requestContext.identity?.sourceIp,
  }));

  try {
    // Get the URL from DynamoDB with minimal projection
    const result = await dynamodb.send(new GetItemCommand({
      TableName: process.env.LINKS_TABLE_NAME!,
      Key: { shortCode: { S: shortCode } },
      ProjectionExpression: 'originalUrl, expiresAt, clickCount, lastClickAt',
    }));

    if (!result.Item) {
      // Track 404s for analytics and monitoring
      await trackAnalytics({
        shortCode,
        timestamp: Date.now(),
        userAgent: event.headers['User-Agent'],
        referer: event.headers['Referer'] || event.headers['referer'],
        ip: event.requestContext.identity?.sourceIp,
        eventType: 'NOT_FOUND',
      });
      
      return createNotFoundResponse(shortCode);
    }

    const linkItem = unmarshall(result.Item) as LinkItem;
    
    // Check if link has expired
    if (linkItem.expiresAt && Date.now() > linkItem.expiresAt) {
      await trackAnalytics({
        shortCode,
        timestamp: Date.now(),
        userAgent: event.headers['User-Agent'],
        referer: event.headers['Referer'] || event.headers['referer'],
        ip: event.requestContext.identity?.sourceIp,
        eventType: 'EXPIRED',
      });
      
      return createExpiredResponse();
    }

    // Track successful analytics asynchronously (don't block the redirect)
    const analyticsPromise = Promise.all([
      trackAnalytics({
        shortCode,
        timestamp: Date.now(),
        userAgent: event.headers['User-Agent'],
        referer: event.headers['Referer'] || event.headers['referer'],
        ip: event.requestContext.identity?.sourceIp,
        eventType: 'SUCCESS',
      }),
      updateClickCount(shortCode),
    ]).catch(error => {
      console.error('Analytics tracking failed:', error);
      // Don't fail the redirect if analytics fail
    });

    // Don't await analytics - let the redirect happen immediately
    analyticsPromise;

    // Log performance metrics
    const responseTime = Date.now() - startTime;
    console.log(JSON.stringify({
      action: 'redirect',
      shortCode,
      responseTime,
      coldStart: COLD_START,
      success: true,
    }));

    // Return redirect response
    return {
      statusCode: 301,
      headers: {
        Location: linkItem.originalUrl,
        'Cache-Control': 'public, max-age=300', // 5 minutes
        'X-Response-Time': `${responseTime}ms`,
        'X-Short-Code': shortCode,
      },
      body: '',
    };

  } catch (error) {
    console.error('Redirect error:', error);
    
    // Log error for monitoring
    console.log(JSON.stringify({
      action: 'redirect',
      shortCode,
      responseTime: Date.now() - startTime,
      coldStart: COLD_START,
      success: false,
      error: error.message,
    }));
    
    return createErrorResponse(500, 'Internal server error');
  }
};

async function trackAnalytics(event: AnalyticsEvent): Promise<void> {
  const timestamp = Date.now();
  
  // Parse user agent for device info
  let deviceInfo: any = {};
  try {
    const parser = new UAParser(event.userAgent);
    const result = parser.getResult();
    deviceInfo = {
      browser: result.browser.name || 'unknown',
      browserVersion: result.browser.version || 'unknown',
      os: result.os.name || 'unknown',
      osVersion: result.os.version || 'unknown',
      device: result.device.type || 'desktop',
    };
  } catch (error) {
    console.warn('Failed to parse user agent:', error);
  }

  const analyticsItem = {
    shortCode: event.shortCode,
    timestamp,
    eventType: event.eventType,
    userAgent: event.userAgent || 'unknown',
    referer: event.referer || 'direct',
    
    // Privacy-first IP handling
    ipHash: event.ip ? hashIP(event.ip) : 'unknown',
    
    // Device information
    ...deviceInfo,
    
    // Geographic data (placeholder - implement with real IP geolocation service)
    country: await getCountryFromIP(event.ip),
    
    // Partition key for efficient querying (shortCode#hour)
    hourPartition: `${event.shortCode}#${Math.floor(timestamp / (1000 * 60 * 60))}`,
    
    // TTL for automatic cleanup (90 days)
    expiresAt: Math.floor(timestamp / 1000) + (90 * 24 * 60 * 60),
  };

  try {
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.ANALYTICS_TABLE_NAME!,
      Item: marshall(analyticsItem),
    }));
  } catch (error) {
    console.error('Failed to store analytics:', error);
    // Don't propagate analytics errors
  }
}

async function updateClickCount(shortCode: string): Promise<void> {
  try {
    await dynamodb.send(new UpdateItemCommand({
      TableName: process.env.LINKS_TABLE_NAME!,
      Key: { shortCode: { S: shortCode } },
      UpdateExpression: 'ADD clickCount :inc SET lastClickAt = :timestamp',
      ExpressionAttributeValues: {
        ':inc': { N: '1' },
        ':timestamp': { N: Date.now().toString() },
      },
    }));
  } catch (error) {
    console.error('Failed to update click count:', error);
    // Don't propagate click count errors
  }
}

function hashIP(ip: string): string {
  // Simple privacy-preserving hash with salt
  const salt = process.env.IP_SALT || 'default-salt-change-in-production';
  return createHash('sha256').update(ip + salt).digest('hex').substring(0, 16);
}

async function getCountryFromIP(ip?: string): Promise<string> {
  if (!ip) return 'unknown';
  
  try {
    // In production, use a service like:
    // - AWS Lambda with IP geolocation API
    // - MaxMind GeoLite2 database
    // - IP-API service
    // - CloudFlare's IP geolocation headers
    
    // For this example, we'll return a placeholder
    // You could also use CloudFront headers if available
    return 'US'; // Placeholder
  } catch (error) {
    console.warn('Failed to get country from IP:', error);
    return 'unknown';
  }
}

function createNotFoundResponse(shortCode: string): APIGatewayProxyResult {
  return {
    statusCode: 404,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Short-Code': shortCode,
    },
    body: `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Link Not Found</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex; 
            justify-content: center; 
            align-items: center; 
            min-height: 100vh; 
            margin: 0; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
        }
        .container { 
            text-align: center; 
            padding: 2rem;
            max-width: 400px;
        }
        h1 { 
            font-size: 3rem; 
            margin-bottom: 1rem;
            opacity: 0.9;
        }
        p { 
            font-size: 1.1rem; 
            margin-bottom: 2rem;
            opacity: 0.8;
            line-height: 1.6;
        }
        .short-code {
            background: rgba(255,255,255,0.2);
            padding: 0.5rem 1rem;
            border-radius: 6px;
            font-family: 'Monaco', 'Menlo', monospace;
            display: inline-block;
            margin: 0.5rem 0;
        }
        .back-link {
            color: rgba(255,255,255,0.9);
            text-decoration: none;
            border: 1px solid rgba(255,255,255,0.3);
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            display: inline-block;
            transition: all 0.2s ease;
        }
        .back-link:hover {
            background: rgba(255,255,255,0.1);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🔍</h1>
        <h2>Link Not Found</h2>
        <p>
            The shortened link <code class="short-code">${shortCode}</code> doesn't exist or may have been removed.
        </p>
        <a href="/" class="back-link">← Go Home</a>
    </div>
</body>
</html>
    `,
  };
}

function createExpiredResponse(): APIGatewayProxyResult {
  return {
    statusCode: 410,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    },
    body: `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Link Expired</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex; 
            justify-content: center; 
            align-items: center; 
            min-height: 100vh; 
            margin: 0; 
            background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
            color: white;
        }
        .container { 
            text-align: center; 
            padding: 2rem;
            max-width: 400px;
        }
        h1 { 
            font-size: 3rem; 
            margin-bottom: 1rem;
        }
        p { 
            font-size: 1.1rem; 
            margin-bottom: 2rem;
            opacity: 0.9;
            line-height: 1.6;
        }
        .back-link {
            color: rgba(255,255,255,0.9);
            text-decoration: none;
            border: 1px solid rgba(255,255,255,0.3);
            padding: 0.75rem 1.5rem;
            border-radius: 6px;
            display: inline-block;
            transition: all 0.2s ease;
        }
        .back-link:hover {
            background: rgba(255,255,255,0.1);
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>⏰</h1>
        <h2>Link Expired</h2>
        <p>This shortened link has expired and is no longer available.</p>
        <a href="/" class="back-link">← Go Home</a>
    </div>
</body>
</html>
    `,
  };
}

function createErrorResponse(statusCode: number, message: string): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify({
      success: false,
      error: {
        message,
        code: statusCode,
      },
    }),
  };
}