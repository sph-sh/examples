// Test environment variables
process.env.AWS_REGION = 'us-east-1';
process.env.ENVIRONMENT = 'test';
process.env.NODE_ENV = 'test';

// DynamoDB Local configuration for tests
process.env.DYNAMODB_LOCAL_ENDPOINT = 'http://localhost:8000';
process.env.DYNAMODB_LOCAL_ACCESS_KEY_ID = 'test';
process.env.DYNAMODB_LOCAL_SECRET_ACCESS_KEY = 'test';

// Table names for testing
process.env.LINKS_TABLE_NAME = 'LinkShortener-Links-test';
process.env.ANALYTICS_TABLE_NAME = 'LinkShortener-Analytics-test';

// Other test configuration
process.env.CUSTOM_DOMAIN = 'test-links.example.com';
process.env.IP_SALT = 'test-salt-for-hashing';
process.env.ENABLE_METADATA_FETCH = 'false'; // Disable for tests
process.env.MAX_URL_LENGTH = '2048';