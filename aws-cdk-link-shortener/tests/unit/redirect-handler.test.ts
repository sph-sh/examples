import { handler } from '../../lambda/redirect/index';
import { createMockAPIGatewayEvent, createMockLambdaContext } from '../setup';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/util-dynamodb');

const mockDynamoDBClient = DynamoDBClient as jest.MockedClass<typeof DynamoDBClient>;
const mockSend = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  mockDynamoDBClient.mockImplementation(() => ({
    send: mockSend,
  } as any));
});

describe('Redirect Handler', () => {
  const mockContext = createMockLambdaContext();

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock successful DynamoDB responses by default
    mockSend.mockResolvedValue({});
  });

  describe('Successful redirects', () => {
    const mockLinkItem = {
      shortCode: 'abc123',
      originalUrl: 'https://example.com',
      clickCount: 5,
      createdAt: Date.now() - 86400000, // 1 day ago
    };

    beforeEach(() => {
      mockSend
        .mockResolvedValueOnce({ Item: mockLinkItem }) // GetItem for redirect
        .mockResolvedValueOnce({}) // PutItem for analytics
        .mockResolvedValueOnce({}); // UpdateItem for click count
    });

    it('should redirect to original URL', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(301);
      expect(result.headers?.Location).toBe('https://example.com');
      expect(result.headers?.['Cache-Control']).toBe('public, max-age=300');
    });

    it('should include response time in headers', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
      });

      const result = await handler(event);

      expect(result.headers?.['X-Response-Time']).toMatch(/\d+ms/);
      expect(result.headers?.['X-Short-Code']).toBe('abc123');
    });

    it('should track analytics asynchronously', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Referer': 'https://google.com',
        },
        requestContext: {
          ...createMockAPIGatewayEvent().requestContext,
          identity: {
            ...createMockAPIGatewayEvent().requestContext.identity,
            sourceIp: '192.168.1.1',
          },
        },
      });

      await handler(event);

      // Check that analytics was tracked (PutItem call)
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TableName: 'LinkShortener-Analytics-test',
          }),
        })
      );
    });

    it('should update click count', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
      });

      await handler(event);

      // Check that click count was updated (UpdateItem call)
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TableName: 'LinkShortener-Links-test',
            UpdateExpression: 'ADD clickCount :inc SET lastClickAt = :timestamp',
          }),
        })
      );
    });
  });

  describe('Link not found', () => {
    beforeEach(() => {
      mockSend
        .mockResolvedValueOnce({ Item: null }) // GetItem returns null
        .mockResolvedValueOnce({}); // PutItem for analytics (NOT_FOUND event)
    });

    it('should return 404 for non-existent short codes', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'nonexistent' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(404);
      expect(result.headers?.['Content-Type']).toBe('text/html; charset=utf-8');
      expect(result.body).toContain('Link Not Found');
      expect(result.body).toContain('nonexistent');
    });

    it('should track 404 events in analytics', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'notfound' },
      });

      await handler(event);

      // Check that NOT_FOUND event was tracked
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            TableName: 'LinkShortener-Analytics-test',
            Item: expect.objectContaining({
              eventType: 'NOT_FOUND',
            }),
          }),
        })
      );
    });

    it('should include proper cache headers for 404s', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'notfound' },
      });

      const result = await handler(event);

      expect(result.headers?.['Cache-Control']).toBe('no-cache, no-store, must-revalidate');
    });
  });

  describe('Expired links', () => {
    const expiredLinkItem = {
      shortCode: 'expired123',
      originalUrl: 'https://example.com',
      expiresAt: Date.now() - 3600000, // Expired 1 hour ago
      clickCount: 2,
    };

    beforeEach(() => {
      mockSend
        .mockResolvedValueOnce({ Item: expiredLinkItem }) // GetItem returns expired link
        .mockResolvedValueOnce({}); // PutItem for analytics (EXPIRED event)
    });

    it('should return 410 for expired links', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'expired123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(410);
      expect(result.headers?.['Content-Type']).toBe('text/html; charset=utf-8');
      expect(result.body).toContain('Link Expired');
    });

    it('should track expired events in analytics', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'expired123' },
      });

      await handler(event);

      // Check that EXPIRED event was tracked
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Item: expect.objectContaining({
              eventType: 'EXPIRED',
            }),
          }),
        })
      );
    });
  });

  describe('Input validation', () => {
    it('should return 400 for missing short code', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: null,
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error.message).toContain('required');
    });

    it('should return 400 for empty short code', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: '' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(400);
    });
  });

  describe('Error handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB connection error'));

      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
      });

      const result = await handler(event);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error.message).toBe('Internal server error');
    });

    it('should not fail redirect if analytics fails', async () => {
      const mockLinkItem = {
        shortCode: 'abc123',
        originalUrl: 'https://example.com',
        clickCount: 5,
      };

      mockSend
        .mockResolvedValueOnce({ Item: mockLinkItem }) // GetItem succeeds
        .mockRejectedValueOnce(new Error('Analytics failure')) // PutItem fails
        .mockResolvedValueOnce({}); // UpdateItem succeeds

      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
      });

      const result = await handler(event);

      // Should still redirect successfully
      expect(result.statusCode).toBe(301);
      expect(result.headers?.Location).toBe('https://example.com');
    });

    it('should not fail redirect if click count update fails', async () => {
      const mockLinkItem = {
        shortCode: 'abc123',
        originalUrl: 'https://example.com',
        clickCount: 5,
      };

      mockSend
        .mockResolvedValueOnce({ Item: mockLinkItem }) // GetItem succeeds
        .mockResolvedValueOnce({}) // PutItem succeeds
        .mockRejectedValueOnce(new Error('Update failure')); // UpdateItem fails

      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
      });

      const result = await handler(event);

      // Should still redirect successfully
      expect(result.statusCode).toBe(301);
      expect(result.headers?.Location).toBe('https://example.com');
    });
  });

  describe('Analytics data collection', () => {
    const mockLinkItem = {
      shortCode: 'abc123',
      originalUrl: 'https://example.com',
      clickCount: 5,
    };

    beforeEach(() => {
      mockSend
        .mockResolvedValueOnce({ Item: mockLinkItem })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
    });

    it('should collect user agent data', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      await handler(event);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Item: expect.objectContaining({
              userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            }),
          }),
        })
      );
    });

    it('should collect referer data', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
        headers: {
          'Referer': 'https://google.com/search?q=test',
        },
      });

      await handler(event);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Item: expect.objectContaining({
              referer: 'https://google.com/search?q=test',
            }),
          }),
        })
      );
    });

    it('should hash IP addresses for privacy', async () => {
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
        requestContext: {
          ...createMockAPIGatewayEvent().requestContext,
          identity: {
            ...createMockAPIGatewayEvent().requestContext.identity,
            sourceIp: '192.168.1.100',
          },
        },
      });

      await handler(event);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Item: expect.objectContaining({
              ipHash: expect.any(String),
            }),
          }),
        })
      );
    });
  });

  describe('Performance logging', () => {
    const mockLinkItem = {
      shortCode: 'abc123',
      originalUrl: 'https://example.com',
    };

    beforeEach(() => {
      mockSend
        .mockResolvedValueOnce({ Item: mockLinkItem })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
    });

    it('should log performance metrics', async () => {
      const consoleSpy = jest.spyOn(console, 'log');
      
      const event = createMockAPIGatewayEvent({
        pathParameters: { shortCode: 'abc123' },
      });

      await handler(event);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"redirect"')
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('"responseTime"')
      );
    });
  });
});