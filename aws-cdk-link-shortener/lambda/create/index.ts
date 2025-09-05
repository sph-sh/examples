import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { nanoid, customAlphabet } from 'nanoid';
import { createHash } from 'crypto';
import { z } from 'zod';

// Initialize DynamoDB client with optimized settings
const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 3000,
  },
});

// Custom alphabet for short codes (URL-safe, avoiding confusing characters)
const generateShortCode = customAlphabet('23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz', 8);

// Request validation schema
const CreateLinkSchema = z.object({
  url: z.string()
    .url('Invalid URL format')
    .min(10, 'URL must be at least 10 characters')
    .max(2048, 'URL must be less than 2048 characters')
    .refine(url => url.startsWith('http://') || url.startsWith('https://'), {
      message: 'URL must start with http:// or https://'
    }),
  customCode: z.string()
    .regex(/^[a-zA-Z0-9-_]{3,20}$/, 'Custom code must be 3-20 characters, alphanumeric, hyphens, or underscores only')
    .optional(),
  expiresIn: z.number()
    .min(3600, 'Minimum expiration is 1 hour')
    .max(31536000, 'Maximum expiration is 1 year')
    .optional(),
  userId: z.string().optional(),
});

interface LinkItem {
  shortCode: string;
  originalUrl: string;
  originalUrlHash: string;
  createdAt: number;
  expiresAt?: number;
  userId?: string;
  clickCount: number;
  isCustom: boolean;
  metadata?: {
    title?: string;
    description?: string;
    favicon?: string;
  };
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  
  try {
    // Parse and validate request body
    if (!event.body) {
      return createErrorResponse(400, 'Request body is required');
    }

    const requestBody = JSON.parse(event.body);
    const validatedData = CreateLinkSchema.parse(requestBody);

    const { url, customCode, expiresIn, userId } = validatedData;
    const urlHash = createUrlHash(url);
    
    // Check for existing URL to prevent duplicates
    const existingLink = await findExistingLink(urlHash);
    if (existingLink) {
      return createSuccessResponse({
        shortCode: existingLink.shortCode,
        shortUrl: createShortUrl(existingLink.shortCode),
        originalUrl: existingLink.originalUrl,
        created: false, // Indicates this is an existing link
        createdAt: new Date(existingLink.createdAt).toISOString(),
        clickCount: existingLink.clickCount || 0,
      });
    }

    // Generate or validate short code
    let shortCode: string;
    let isCustom = false;

    if (customCode) {
      // Validate custom code availability
      const customExists = await checkShortCodeExists(customCode);
      if (customExists) {
        return createErrorResponse(409, 'Custom short code already exists');
      }
      shortCode = customCode;
      isCustom = true;
    } else {
      // Generate unique short code
      shortCode = await generateUniqueShortCode();
    }

    // Create link item
    const now = Date.now();
    const linkItem: LinkItem = {
      shortCode,
      originalUrl: url,
      originalUrlHash: urlHash,
      createdAt: now,
      clickCount: 0,
      isCustom,
      ...(expiresIn && { expiresAt: now + (expiresIn * 1000) }),
      ...(userId && { userId }),
    };

    // Optionally fetch URL metadata (title, description, favicon)
    if (shouldFetchMetadata(url)) {
      try {
        linkItem.metadata = await fetchUrlMetadata(url);
      } catch (error) {
        console.warn('Failed to fetch URL metadata:', error);
        // Continue without metadata - don't fail the request
      }
    }

    // Save to DynamoDB
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.LINKS_TABLE_NAME!,
      Item: marshall(linkItem),
      ConditionExpression: 'attribute_not_exists(shortCode)', // Prevent overwrites
    }));

    // Log performance metrics
    const responseTime = Date.now() - startTime;
    console.log(JSON.stringify({
      action: 'create_link',
      shortCode,
      isCustom,
      responseTime,
      urlLength: url.length,
      hasMetadata: !!linkItem.metadata,
    }));

    return createSuccessResponse({
      shortCode,
      shortUrl: createShortUrl(shortCode),
      originalUrl: url,
      created: true,
      createdAt: new Date(now).toISOString(),
      clickCount: 0,
      ...(linkItem.expiresAt && { expiresAt: new Date(linkItem.expiresAt).toISOString() }),
      ...(linkItem.metadata && { metadata: linkItem.metadata }),
    });

  } catch (error) {
    console.error('Error creating short link:', error);
    
    if (error instanceof z.ZodError) {
      return createErrorResponse(400, error.errors[0].message);
    }
    
    if (error.name === 'ConditionalCheckFailedException') {
      return createErrorResponse(409, 'Short code already exists');
    }

    return createErrorResponse(500, 'Internal server error');
  }
};

async function findExistingLink(urlHash: string): Promise<LinkItem | null> {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: process.env.LINKS_TABLE_NAME!,
      IndexName: 'OriginalUrlIndex',
      KeyConditionExpression: 'originalUrlHash = :hash',
      ExpressionAttributeValues: {
        ':hash': { S: urlHash },
      },
      Limit: 1,
    }));

    if (result.Items && result.Items.length > 0) {
      const item = unmarshall(result.Items[0]) as LinkItem;
      
      // Check if the link is still valid (not expired)
      if (!item.expiresAt || item.expiresAt > Date.now()) {
        return item;
      }
    }

    return null;
  } catch (error) {
    console.warn('Failed to check for existing link:', error);
    return null; // Continue with creating new link
  }
}

async function checkShortCodeExists(shortCode: string): Promise<boolean> {
  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: process.env.LINKS_TABLE_NAME!,
      Key: { shortCode: { S: shortCode } },
      ProjectionExpression: 'shortCode',
    }));

    return !!result.Item;
  } catch (error) {
    console.warn('Failed to check short code existence:', error);
    return true; // Err on the side of caution
  }
}

async function generateUniqueShortCode(maxAttempts = 5): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const shortCode = generateShortCode();
    const exists = await checkShortCodeExists(shortCode);
    
    if (!exists) {
      return shortCode;
    }

    // Log collision for monitoring
    console.warn(`Short code collision detected: ${shortCode} (attempt ${attempt + 1})`);
  }

  throw new Error('Failed to generate unique short code after maximum attempts');
}

function createUrlHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function createShortUrl(shortCode: string): string {
  const domain = process.env.CUSTOM_DOMAIN || process.env.API_DOMAIN;
  return `https://${domain}/${shortCode}`;
}

function shouldFetchMetadata(url: string): boolean {
  // Only fetch metadata for HTTP/HTTPS URLs that look like web pages
  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    
    // Skip known file hosting services and APIs
    const skipDomains = [
      'api.',
      'cdn.',
      's3.amazonaws.com',
      'storage.googleapis.com',
      'github.com/raw',
    ];

    return !skipDomains.some(domain => hostname.includes(domain));
  } catch {
    return false;
  }
}

async function fetchUrlMetadata(url: string): Promise<any> {
  // In a real implementation, you'd use a service like:
  // - AWS Lambda with Puppeteer
  // - Third-party service like Clearbit or LinkPreview
  // - Custom web scraping service
  
  // For this example, we'll return a placeholder
  return {
    title: 'Web Page',
    description: 'A web page',
    favicon: `${new URL(url).origin}/favicon.ico`,
  };
}

function createSuccessResponse(data: any): APIGatewayProxyResult {
  return {
    statusCode: 201,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
    body: JSON.stringify({
      success: true,
      data,
    }),
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