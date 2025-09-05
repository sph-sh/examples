import { jest } from '@jest/globals';

// Mock AWS SDK calls for unit tests
jest.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: jest.fn().mockImplementation(() => ({
    send: jest.fn(),
  })),
  GetItemCommand: jest.fn(),
  PutItemCommand: jest.fn(),
  UpdateItemCommand: jest.fn(),
  QueryCommand: jest.fn(),
  ScanCommand: jest.fn(),
}));

jest.mock('@aws-sdk/util-dynamodb', () => ({
  marshall: jest.fn((obj) => obj),
  unmarshall: jest.fn((obj) => obj),
}));

// Mock nanoid for predictable IDs in tests
jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'test-id-12345'),
  customAlphabet: jest.fn(() => () => 'test-code'),
}));

// Mock crypto for consistent hashing in tests
jest.mock('crypto', () => ({
  createHash: jest.fn(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn(() => 'test-hash-12345678901234567890123456789012'),
  })),
}));

// Mock console methods to reduce test noise
const originalConsole = global.console;
global.console = {
  ...originalConsole,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn().mockImplementation((...args) => {
    // Allow error logs to pass through for debugging
    originalConsole.error(...args);
  }),
  info: jest.fn(),
  debug: jest.fn(),
};

// Restore console for specific tests that need it
export const restoreConsole = () => {
  global.console = originalConsole;
};

// Helper to create mock API Gateway event
export const createMockAPIGatewayEvent = (
  overrides: Partial<any> = {}
): any => ({
  httpMethod: 'GET',
  path: '/test',
  pathParameters: null,
  queryStringParameters: null,
  headers: {
    'User-Agent': 'test-user-agent',
  },
  body: null,
  isBase64Encoded: false,
  requestContext: {
    accountId: 'test-account',
    apiId: 'test-api',
    domainName: 'test-domain',
    domainPrefix: 'test',
    httpMethod: 'GET',
    path: '/test',
    protocol: 'HTTP/1.1',
    requestId: 'test-request-id',
    requestTime: '2024-01-01T00:00:00Z',
    requestTimeEpoch: 1704067200000,
    resourceId: 'test-resource',
    resourcePath: '/test',
    stage: 'test',
    identity: {
      sourceIp: '127.0.0.1',
      userAgent: 'test-user-agent',
      accessKey: null,
      accountId: null,
      apiKey: null,
      apiKeyId: null,
      caller: null,
      cognitoAuthenticationProvider: null,
      cognitoAuthenticationType: null,
      cognitoIdentityId: null,
      cognitoIdentityPoolId: null,
      principalOrgId: null,
      user: null,
      userArn: null,
    },
    authorizer: {},
  },
  resource: '/test',
  stageVariables: null,
  multiValueHeaders: {},
  multiValueQueryStringParameters: null,
  ...overrides,
});

// Helper to create mock Lambda context
export const createMockLambdaContext = (): any => ({
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'test-function',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:test-function',
  memoryLimitInMB: '128',
  awsRequestId: 'test-request-id',
  logGroupName: '/aws/lambda/test-function',
  logStreamName: 'test-stream',
  getRemainingTimeInMillis: jest.fn(() => 30000),
  done: jest.fn(),
  fail: jest.fn(),
  succeed: jest.fn(),
});

// Global test setup
beforeEach(() => {
  jest.clearAllMocks();
  
  // Reset environment variables that might be modified during tests
  process.env.LINKS_TABLE_NAME = 'LinkShortener-Links-test';
  process.env.ANALYTICS_TABLE_NAME = 'LinkShortener-Analytics-test';
});

afterEach(() => {
  jest.resetModules();
});