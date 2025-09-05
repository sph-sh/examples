import { z } from 'zod';

// URL validation schema
export const UrlSchema = z.string()
  .url('Invalid URL format')
  .min(10, 'URL must be at least 10 characters')
  .max(2048, 'URL must be less than 2048 characters')
  .refine(url => url.startsWith('http://') || url.startsWith('https://'), {
    message: 'URL must start with http:// or https://'
  })
  .refine(url => {
    try {
      const parsed = new URL(url);
      // Block localhost and private IPs in production
      if (process.env.ENVIRONMENT === 'prod') {
        const hostname = parsed.hostname.toLowerCase();
        if (
          hostname === 'localhost' ||
          hostname.startsWith('127.') ||
          hostname.startsWith('192.168.') ||
          hostname.startsWith('10.') ||
          (hostname.startsWith('172.') && 
           parseInt(hostname.split('.')[1]) >= 16 && 
           parseInt(hostname.split('.')[1]) <= 31)
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }, {
    message: 'Invalid URL or localhost/private IPs not allowed in production'
  });

// Short code validation schema
export const ShortCodeSchema = z.string()
  .regex(/^[a-zA-Z0-9-_]{3,20}$/, 'Short code must be 3-20 characters, alphanumeric, hyphens, or underscores only')
  .refine(code => {
    // Block reserved words and API routes
    const reservedWords = [
      'api', 'www', 'admin', 'root', 'help', 'support', 'contact',
      'about', 'terms', 'privacy', 'login', 'signup', 'auth',
      'health', 'status', 'metrics', 'analytics', 'dashboard',
      'docs', 'documentation', 'blog', 'news', 'static', 'assets',
      'public', 'private', 'test', 'staging', 'dev', 'prod',
      'null', 'undefined', 'true', 'false', 'delete', 'remove',
    ];
    return !reservedWords.includes(code.toLowerCase());
  }, {
    message: 'Short code cannot be a reserved word'
  });

// Request body schemas
export const CreateLinkSchema = z.object({
  url: UrlSchema,
  customCode: ShortCodeSchema.optional(),
  expiresIn: z.number()
    .min(3600, 'Minimum expiration is 1 hour (3600 seconds)')
    .max(31536000, 'Maximum expiration is 1 year (31536000 seconds)')
    .optional(),
  userId: z.string().min(1).max(100).optional(),
  metadata: z.object({
    title: z.string().max(200).optional(),
    description: z.string().max(500).optional(),
    tags: z.array(z.string().max(50)).max(10).optional(),
  }).optional(),
});

// Analytics query parameters schema
export const AnalyticsQuerySchema = z.object({
  period: z.enum(['1h', '24h', '7d', '30d']).optional().default('24h'),
  granularity: z.enum(['hour', 'day']).optional().default('hour'),
  includeEvents: z.enum(['all', 'success', 'failures']).optional().default('all'),
  timezone: z.string().optional().default('UTC'),
});

// User agent validation
export const UserAgentSchema = z.string().max(500);

// IP address validation
export const IpAddressSchema = z.string().ip();

// Validation helper functions
export class ValidationHelper {
  
  /**
   * Validate URL and extract metadata
   */
  static validateUrl(url: string): { isValid: boolean; parsed?: URL; error?: string } {
    try {
      const result = UrlSchema.parse(url);
      const parsed = new URL(result);
      return { isValid: true, parsed };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { isValid: false, error: error.errors[0].message };
      }
      return { isValid: false, error: 'Invalid URL' };
    }
  }

  /**
   * Validate short code
   */
  static validateShortCode(code: string): { isValid: boolean; error?: string } {
    try {
      ShortCodeSchema.parse(code);
      return { isValid: true };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { isValid: false, error: error.errors[0].message };
      }
      return { isValid: false, error: 'Invalid short code' };
    }
  }

  /**
   * Sanitize user input
   */
  static sanitizeInput(input: string): string {
    return input
      .trim()
      .replace(/[<>\"'&]/g, '') // Remove potentially dangerous characters
      .substring(0, 1000); // Limit length
  }

  /**
   * Validate and sanitize user agent
   */
  static sanitizeUserAgent(userAgent?: string): string {
    if (!userAgent) return 'unknown';
    
    try {
      return UserAgentSchema.parse(userAgent.substring(0, 500));
    } catch {
      return 'invalid';
    }
  }

  /**
   * Check if URL is safe (not on blocklist)
   */
  static async isUrlSafe(url: string): Promise<{ isSafe: boolean; reason?: string }> {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // Check against known malicious domains (simplified example)
      const blocklist = [
        'malware.com',
        'phishing.com',
        'spam.com',
        // In production, use a real threat intelligence service
      ];

      if (blocklist.includes(hostname)) {
        return { isSafe: false, reason: 'Domain is on blocklist' };
      }

      // Check for suspicious patterns
      if (hostname.includes('bit.ly') || hostname.includes('tinyurl.com')) {
        return { isSafe: false, reason: 'Nested URL shorteners not allowed' };
      }

      // Check URL length
      if (url.length > 2048) {
        return { isSafe: false, reason: 'URL too long' };
      }

      return { isSafe: true };
    } catch {
      return { isSafe: false, reason: 'Invalid URL format' };
    }
  }

  /**
   * Rate limiting check (simplified)
   */
  static checkRateLimit(ip: string, action: string): { allowed: boolean; resetTime?: number } {
    // In production, implement proper rate limiting with Redis or DynamoDB
    // This is a simplified example
    
    const limits = {
      'create': { requests: 10, window: 60 * 1000 }, // 10 requests per minute
      'redirect': { requests: 100, window: 60 * 1000 }, // 100 requests per minute
      'analytics': { requests: 20, window: 60 * 1000 }, // 20 requests per minute
    };

    const limit = limits[action as keyof typeof limits];
    if (!limit) {
      return { allowed: true };
    }

    // For demo purposes, always allow
    // In production, implement with a proper rate limiting service
    return { allowed: true };
  }

  /**
   * Detect potential spam patterns
   */
  static detectSpamPatterns(url: string, userAgent?: string, referer?: string): boolean {
    // Check for suspicious URL patterns
    const suspiciousPatterns = [
      /bit\.ly/i,
      /tinyurl/i,
      /goo\.gl/i,
      /t\.co/i,
      /ow\.ly/i,
      /short\.link/i,
      /viagra/i,
      /casino/i,
      /porn/i,
      /xxx/i,
    ];

    if (suspiciousPatterns.some(pattern => pattern.test(url))) {
      return true;
    }

    // Check user agent patterns
    if (userAgent) {
      const botPatterns = [
        /bot/i,
        /crawler/i,
        /spider/i,
        /scraper/i,
      ];

      if (botPatterns.some(pattern => pattern.test(userAgent))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate safe random string
   */
  static generateSafeId(length: number = 8): string {
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz';
    let result = '';
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }

  /**
   * Hash sensitive data
   */
  static hashSensitiveData(data: string, salt?: string): string {
    const crypto = require('crypto');
    const actualSalt = salt || process.env.IP_SALT || 'default-salt';
    return crypto.createHash('sha256').update(data + actualSalt).digest('hex').substring(0, 16);
  }
}