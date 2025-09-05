import { DynamoDBClient, UpdateItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';

// DynamoDB client with optimized configuration
const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 2000,
  },
});

// Rate limit configurations
const RATE_LIMITS = {
  free: {
    create: { requests: 10, window: 3600 }, // 10 requests per hour
    redirect: { requests: 1000, window: 3600 }, // 1000 redirects per hour
    analytics: { requests: 50, window: 3600 }, // 50 analytics requests per hour
  },
  premium: {
    create: { requests: 100, window: 3600 }, // 100 requests per hour
    redirect: { requests: 10000, window: 3600 }, // 10k redirects per hour
    analytics: { requests: 500, window: 3600 }, // 500 analytics requests per hour
  },
  admin: {
    create: { requests: 1000, window: 3600 }, // 1000 requests per hour
    redirect: { requests: 100000, window: 3600 }, // 100k redirects per hour
    analytics: { requests: 5000, window: 3600 }, // 5000 analytics requests per hour
  },
} as const;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfter?: number;
}

export interface RateLimitOptions {
  identifier: string; // IP address or user ID
  action: 'create' | 'redirect' | 'analytics';
  userRole?: 'free' | 'premium' | 'admin';
  increment?: number; // Number of requests to add (default: 1)
}

/**
 * DynamoDB-based rate limiter with atomic counters
 */
export class RateLimiter {
  private tableName: string;

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  /**
   * Check and update rate limit
   */
  async checkRateLimit(options: RateLimitOptions): Promise<RateLimitResult> {
    const { identifier, action, userRole = 'free', increment = 1 } = options;
    
    // Get rate limit configuration
    const limit = RATE_LIMITS[userRole][action];
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % limit.window);
    const windowEnd = windowStart + limit.window;
    
    // Create partition key for time window
    const partitionKey = `${identifier}:${action}:${windowStart}`;

    try {
      // Use atomic counter with UpdateItem
      const updateResult = await dynamodb.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({
          pk: partitionKey,
        }),
        UpdateExpression: 'ADD #count :increment SET #ttl = :ttl, #windowStart = :windowStart, #windowEnd = :windowEnd',
        ExpressionAttributeNames: {
          '#count': 'requestCount',
          '#ttl': 'ttl',
          '#windowStart': 'windowStart', 
          '#windowEnd': 'windowEnd',
        },
        ExpressionAttributeValues: marshall({
          ':increment': increment,
          ':ttl': windowEnd + 86400, // Keep records for 24 hours after window ends
          ':windowStart': windowStart,
          ':windowEnd': windowEnd,
        }),
        ReturnValues: 'ALL_NEW',
      }));

      const item = updateResult.Attributes ? unmarshall(updateResult.Attributes) : null;
      const currentCount = item?.requestCount || 0;
      
      // Check if limit exceeded
      const allowed = currentCount <= limit.requests;
      const remaining = Math.max(0, limit.requests - currentCount);
      const resetTime = windowEnd;
      
      const result: RateLimitResult = {
        allowed,
        remaining,
        resetTime,
      };

      // Add retry-after if rate limit exceeded
      if (!allowed) {
        result.retryAfter = resetTime - now;
      }

      return result;

    } catch (error) {
      console.error('Rate limit check failed:', error);
      
      // Fail open - allow request if rate limiter is down
      return {
        allowed: true,
        remaining: limit.requests,
        resetTime: windowEnd,
      };
    }
  }

  /**
   * Get current rate limit status without incrementing
   */
  async getRateLimitStatus(options: Omit<RateLimitOptions, 'increment'>): Promise<RateLimitResult> {
    const { identifier, action, userRole = 'free' } = options;
    
    const limit = RATE_LIMITS[userRole][action];
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % limit.window);
    const windowEnd = windowStart + limit.window;
    const partitionKey = `${identifier}:${action}:${windowStart}`;

    try {
      const result = await dynamodb.send(new GetItemCommand({
        TableName: this.tableName,
        Key: marshall({
          pk: partitionKey,
        }),
      }));

      const item = result.Item ? unmarshall(result.Item) : null;
      const currentCount = item?.requestCount || 0;
      
      const allowed = currentCount < limit.requests;
      const remaining = Math.max(0, limit.requests - currentCount);
      
      return {
        allowed,
        remaining,
        resetTime: windowEnd,
        retryAfter: allowed ? undefined : windowEnd - now,
      };

    } catch (error) {
      console.error('Rate limit status check failed:', error);
      
      // Return optimistic values on error
      return {
        allowed: true,
        remaining: limit.requests,
        resetTime: windowEnd,
      };
    }
  }

  /**
   * Reset rate limit for a specific identifier and action (admin only)
   */
  async resetRateLimit(identifier: string, action: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 3600); // Assume hourly window
    const partitionKey = `${identifier}:${action}:${windowStart}`;

    try {
      await dynamodb.send(new UpdateItemCommand({
        TableName: this.tableName,
        Key: marshall({
          pk: partitionKey,
        }),
        UpdateExpression: 'SET #count = :zero',
        ExpressionAttributeNames: {
          '#count': 'requestCount',
        },
        ExpressionAttributeValues: marshall({
          ':zero': 0,
        }),
      }));
    } catch (error) {
      console.error('Rate limit reset failed:', error);
      throw error;
    }
  }

  /**
   * Get rate limit configuration for a user role
   */
  static getRateLimitConfig(userRole: 'free' | 'premium' | 'admin' = 'free') {
    return RATE_LIMITS[userRole];
  }

  /**
   * Hash IP address for privacy
   */
  static hashIdentifier(identifier: string): string {
    const crypto = require('crypto');
    const salt = process.env.RATE_LIMIT_SALT || 'default-salt';
    return crypto.createHash('sha256').update(identifier + salt).digest('hex').substring(0, 16);
  }
}

/**
 * Middleware function for Lambda handlers
 */
export async function withRateLimit(
  options: RateLimitOptions,
  tableName: string = process.env.RATE_LIMIT_TABLE_NAME || ''
): Promise<RateLimitResult> {
  const rateLimiter = new RateLimiter(tableName);
  
  // Hash identifier for privacy
  const hashedIdentifier = RateLimiter.hashIdentifier(options.identifier);
  
  return rateLimiter.checkRateLimit({
    ...options,
    identifier: hashedIdentifier,
  });
}

/**
 * Create rate limit headers for HTTP responses
 */
export function createRateLimitHeaders(result: RateLimitResult): Record<string, string> {
  const headers: Record<string, string> = {
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.resetTime.toString(),
  };

  if (result.retryAfter) {
    headers['Retry-After'] = result.retryAfter.toString();
  }

  return headers;
}