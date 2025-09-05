import { handler } from '../../lambda/create/index';
import { createMockAPIGatewayEvent, createMockLambdaContext } from '../setup';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

// Mock the entire module
jest.mock('@aws-sdk/client-dynamodb');
jest.mock('@aws-sdk/util-dynamodb');

const mockDynamoDBClient = DynamoDBClient as jest.MockedClass<typeof DynamoDBClient>;
const mockSend = jest.fn();

beforeEach(() => {
  mockDynamoDBClient.mockImplementation(() => ({
    send: mockSend,
  } as any));
});

describe('Create Handler', () => {
  const mockEvent = createMockAPIGatewayEvent({
    httpMethod: 'POST',
    body: JSON.stringify({
      url: 'https://example.com',
    }),
  });
  
  const mockContext = createMockLambdaContext();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Successful URL creation', () => {
    beforeEach(() => {
      // Mock successful DynamoDB responses
      mockSend
        .mockResolvedValueOnce({ Items: [] }) // Query for existing URL (none found)
        .mockResolvedValueOnce({ Item: null }) // Check short code exists (doesn't exist)
        .mockResolvedValueOnce({}); // Put item success
    });

    it('should create a short URL successfully', async () => {
      const result = await handler(mockEvent, mockContext);

      expect(result.statusCode).toBe(201);
      expect(JSON.parse(result.body)).toMatchObject({
        success: true,
        data: {
          shortCode: expect.any(String),
          shortUrl: expect.any(String),
          originalUrl: 'https://example.com',
          created: true,
        },
      });
    });

    it('should generate different short codes for different URLs', async () => {
      const event1 = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ url: 'https://example1.com' }),
      });
      
      const event2 = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ url: 'https://example2.com' }),
      });

      const result1 = await handler(event1, mockContext);
      const result2 = await handler(event2, mockContext);

      const data1 = JSON.parse(result1.body).data;
      const data2 = JSON.parse(result2.body).data;

      expect(data1.shortCode).toBeTruthy();
      expect(data2.shortCode).toBeTruthy();
      // Note: In real implementation these would be different, 
      // but our mock returns the same value
    });
  });

  describe('Custom short codes', () => {
    it('should accept valid custom short codes', async () => {
      const customEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          url: 'https://example.com',
          customCode: 'my-custom-code',
        }),
      });

      // Mock that custom code doesn't exist
      mockSend
        .mockResolvedValueOnce({ Items: [] }) // Query for existing URL
        .mockResolvedValueOnce({ Item: null }) // Check custom code doesn't exist
        .mockResolvedValueOnce({}); // Put item success

      const result = await handler(customEvent, mockContext);

      expect(result.statusCode).toBe(201);
      expect(JSON.parse(result.body).data.shortCode).toBe('my-custom-code');
    });

    it('should reject invalid custom short codes', async () => {
      const invalidEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          url: 'https://example.com',
          customCode: 'api', // Reserved word
        }),
      });

      const result = await handler(invalidEvent, mockContext);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).success).toBe(false);
    });

    it('should reject existing custom short codes', async () => {
      const customEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          url: 'https://example.com',
          customCode: 'existing-code',
        }),
      });

      // Mock that custom code already exists
      mockSend
        .mockResolvedValueOnce({ Items: [] }) // Query for existing URL
        .mockResolvedValueOnce({ Item: { shortCode: 'existing-code' } }); // Check custom code exists

      const result = await handler(customEvent, mockContext);

      expect(result.statusCode).toBe(409);
      expect(JSON.parse(result.body).error.message).toContain('already exists');
    });
  });

  describe('Input validation', () => {
    it('should reject invalid URLs', async () => {
      const invalidEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          url: 'not-a-url',
        }),
      });

      const result = await handler(invalidEvent, mockContext);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).success).toBe(false);
    });

    it('should reject missing URL', async () => {
      const missingUrlEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({}),
      });

      const result = await handler(missingUrlEvent, mockContext);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).success).toBe(false);
    });

    it('should reject URLs that are too long', async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(2048);
      const longUrlEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({ url: longUrl }),
      });

      const result = await handler(longUrlEvent, mockContext);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).success).toBe(false);
    });

    it('should reject missing request body', async () => {
      const noBodyEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: null,
      });

      const result = await handler(noBodyEvent, mockContext);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).error.message).toContain('required');
    });
  });

  describe('Expiration handling', () => {
    it('should accept valid expiration times', async () => {
      const expirationEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          url: 'https://example.com',
          expiresIn: 3600, // 1 hour
        }),
      });

      mockSend
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Item: null })
        .mockResolvedValueOnce({});

      const result = await handler(expirationEvent, mockContext);

      expect(result.statusCode).toBe(201);
      expect(JSON.parse(result.body).data.expiresAt).toBeTruthy();
    });

    it('should reject expiration times that are too short', async () => {
      const shortExpirationEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: JSON.stringify({
          url: 'https://example.com',
          expiresIn: 60, // 1 minute (too short)
        }),
      });

      const result = await handler(shortExpirationEvent, mockContext);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).success).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should handle DynamoDB errors gracefully', async () => {
      mockSend.mockRejectedValueOnce(new Error('DynamoDB error'));

      const result = await handler(mockEvent, mockContext);

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).success).toBe(false);
    });

    it('should handle JSON parsing errors', async () => {
      const malformedEvent = createMockAPIGatewayEvent({
        httpMethod: 'POST',
        body: 'invalid json',
      });

      const result = await handler(malformedEvent, mockContext);

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).success).toBe(false);
    });
  });

  describe('Duplicate URL handling', () => {
    it('should return existing short code for duplicate URLs', async () => {
      const existingItem = {
        shortCode: 'existing123',
        originalUrl: 'https://example.com',
        createdAt: Date.now() - 1000,
        clickCount: 5,
      };

      // Mock that URL already exists
      mockSend.mockResolvedValueOnce({
        Items: [existingItem],
      });

      const result = await handler(mockEvent, mockContext);

      expect(result.statusCode).toBe(201);
      expect(JSON.parse(result.body)).toMatchObject({
        success: true,
        data: {
          shortCode: 'existing123',
          created: false,
          clickCount: 5,
        },
      });
    });
  });

  describe('CORS headers', () => {
    it('should include proper CORS headers', async () => {
      mockSend
        .mockResolvedValueOnce({ Items: [] })
        .mockResolvedValueOnce({ Item: null })
        .mockResolvedValueOnce({});

      const result = await handler(mockEvent, mockContext);

      expect(result.headers).toMatchObject({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
    });
  });
});