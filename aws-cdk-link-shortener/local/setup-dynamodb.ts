#!/usr/bin/env node

/**
 * DynamoDB Local Setup Script
 * Creates the required tables for local development
 */

import { DynamoDBClient, CreateTableCommand, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: '.env.dev' });

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT || 'http://localhost:8000',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.DYNAMODB_LOCAL_ACCESS_KEY_ID || 'local',
    secretAccessKey: process.env.DYNAMODB_LOCAL_SECRET_ACCESS_KEY || 'local',
  },
});

const LINKS_TABLE = process.env.LINKS_TABLE_NAME || 'LinkShortener-Links-dev';
const ANALYTICS_TABLE = process.env.ANALYTICS_TABLE_NAME || 'LinkShortener-Analytics-dev';

async function tableExists(tableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (error) {
    return false;
  }
}

async function createLinksTable(): Promise<void> {
  if (await tableExists(LINKS_TABLE)) {
    console.log(`✅ Links table ${LINKS_TABLE} already exists`);
    return;
  }

  console.log(`📝 Creating Links table: ${LINKS_TABLE}`);

  const command = new CreateTableCommand({
    TableName: LINKS_TABLE,
    AttributeDefinitions: [
      {
        AttributeName: 'shortCode',
        AttributeType: 'S',
      },
      {
        AttributeName: 'originalUrlHash',
        AttributeType: 'S',
      },
      {
        AttributeName: 'userId',
        AttributeType: 'S',
      },
      {
        AttributeName: 'createdAt',
        AttributeType: 'N',
      },
    ],
    KeySchema: [
      {
        AttributeName: 'shortCode',
        KeyType: 'HASH',
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    GlobalSecondaryIndexes: [
      {
        IndexName: 'OriginalUrlIndex',
        KeySchema: [
          {
            AttributeName: 'originalUrlHash',
            KeyType: 'HASH',
          },
        ],
        Projection: {
          ProjectionType: 'KEYS_ONLY',
        },
      },
      {
        IndexName: 'UserIndex',
        KeySchema: [
          {
            AttributeName: 'userId',
            KeyType: 'HASH',
          },
          {
            AttributeName: 'createdAt',
            KeyType: 'RANGE',
          },
        ],
        Projection: {
          ProjectionType: 'ALL',
        },
      },
    ],
    StreamSpecification: {
      StreamEnabled: true,
      StreamViewType: 'NEW_AND_OLD_IMAGES',
    },
    Tags: [
      {
        Key: 'Environment',
        Value: 'development',
      },
      {
        Key: 'Project',
        Value: 'LinkShortener',
      },
    ],
  });

  try {
    await client.send(command);
    console.log(`✅ Created Links table: ${LINKS_TABLE}`);
  } catch (error) {
    console.error(`❌ Failed to create Links table:`, error);
    throw error;
  }
}

async function createAnalyticsTable(): Promise<void> {
  if (await tableExists(ANALYTICS_TABLE)) {
    console.log(`✅ Analytics table ${ANALYTICS_TABLE} already exists`);
    return;
  }

  console.log(`📝 Creating Analytics table: ${ANALYTICS_TABLE}`);

  const command = new CreateTableCommand({
    TableName: ANALYTICS_TABLE,
    AttributeDefinitions: [
      {
        AttributeName: 'shortCode',
        AttributeType: 'S',
      },
      {
        AttributeName: 'timestamp',
        AttributeType: 'N',
      },
      {
        AttributeName: 'hourPartition',
        AttributeType: 'S',
      },
      {
        AttributeName: 'country',
        AttributeType: 'S',
      },
    ],
    KeySchema: [
      {
        AttributeName: 'shortCode',
        KeyType: 'HASH',
      },
      {
        AttributeName: 'timestamp',
        KeyType: 'RANGE',
      },
    ],
    BillingMode: 'PAY_PER_REQUEST',
    GlobalSecondaryIndexes: [
      {
        IndexName: 'TimeRangeIndex',
        KeySchema: [
          {
            AttributeName: 'hourPartition',
            KeyType: 'HASH',
          },
          {
            AttributeName: 'timestamp',
            KeyType: 'RANGE',
          },
        ],
        Projection: {
          ProjectionType: 'ALL',
        },
      },
      {
        IndexName: 'GeographicIndex',
        KeySchema: [
          {
            AttributeName: 'country',
            KeyType: 'HASH',
          },
          {
            AttributeName: 'timestamp',
            KeyType: 'RANGE',
          },
        ],
        Projection: {
          ProjectionType: 'INCLUDE',
          NonKeyAttributes: ['shortCode', 'userAgent', 'referer'],
        },
      },
    ],
    // TimeToLiveSpecification: {
    //   AttributeName: 'expiresAt',
    //   Enabled: true,
    // },
    Tags: [
      {
        Key: 'Environment',
        Value: 'development',
      },
      {
        Key: 'Project',
        Value: 'LinkShortener',
      },
    ],
  });

  try {
    await client.send(command);
    console.log(`✅ Created Analytics table: ${ANALYTICS_TABLE}`);
  } catch (error) {
    console.error(`❌ Failed to create Analytics table:`, error);
    throw error;
  }
}

async function waitForTableActive(tableName: string): Promise<void> {
  console.log(`⏳ Waiting for table ${tableName} to become active...`);
  
  let attempts = 0;
  const maxAttempts = 30; // 30 seconds max wait time
  
  while (attempts < maxAttempts) {
    try {
      const response = await client.send(new DescribeTableCommand({ TableName: tableName }));
      if (response.Table?.TableStatus === 'ACTIVE') {
        console.log(`✅ Table ${tableName} is now active`);
        return;
      }
    } catch (error) {
      // Table might not exist yet, continue waiting
    }
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    attempts++;
  }
  
  throw new Error(`Table ${tableName} did not become active within ${maxAttempts} seconds`);
}

async function populateTestData(): Promise<void> {
  console.log('📊 Adding test data...');
  
  const { PutItemCommand } = await import('@aws-sdk/client-dynamodb');
  const { marshall } = await import('@aws-sdk/util-dynamodb');
  
  const testLinks = [
    {
      shortCode: 'github',
      originalUrl: 'https://github.com',
      originalUrlHash: 'github-hash',
      createdAt: Date.now() - 86400000, // 1 day ago
      clickCount: 42,
      isCustom: true,
      userId: 'test-user-1',
    },
    {
      shortCode: 'google',
      originalUrl: 'https://google.com',
      originalUrlHash: 'google-hash',
      createdAt: Date.now() - 3600000, // 1 hour ago
      clickCount: 15,
      isCustom: true,
    },
    {
      shortCode: 'abc123',
      originalUrl: 'https://example.com/very/long/path/to/some/resource',
      originalUrlHash: 'example-hash',
      createdAt: Date.now() - 1800000, // 30 minutes ago
      clickCount: 7,
      isCustom: false,
    },
  ];

  for (const link of testLinks) {
    try {
      await client.send(new PutItemCommand({
        TableName: LINKS_TABLE,
        Item: marshall(link),
      }));
      console.log(`  ✅ Added test link: ${link.shortCode}`);
    } catch (error) {
      console.warn(`  ⚠️  Failed to add test link ${link.shortCode}:`, error instanceof Error ? error.message : String(error));
    }
  }

  // Add some analytics data
  const testAnalytics = [
    {
      shortCode: 'github',
      timestamp: Date.now() - 3600000,
      eventType: 'SUCCESS',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      referer: 'https://google.com',
      ipHash: 'hashed-ip-1',
      country: 'US',
      browser: 'Chrome',
      browserVersion: '91.0',
      os: 'macOS',
      device: 'desktop',
      hourPartition: `github#${Math.floor((Date.now() - 3600000) / (1000 * 60 * 60))}`,
      expiresAt: Math.floor((Date.now() + 90 * 24 * 60 * 60 * 1000) / 1000), // 90 days from now
    },
    {
      shortCode: 'google',
      timestamp: Date.now() - 1800000,
      eventType: 'SUCCESS',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      referer: 'direct',
      ipHash: 'hashed-ip-2',
      country: 'UK',
      browser: 'Firefox',
      browserVersion: '89.0',
      os: 'Windows',
      device: 'desktop',
      hourPartition: `google#${Math.floor((Date.now() - 1800000) / (1000 * 60 * 60))}`,
      expiresAt: Math.floor((Date.now() + 90 * 24 * 60 * 60 * 1000) / 1000),
    },
  ];

  for (const analytics of testAnalytics) {
    try {
      await client.send(new PutItemCommand({
        TableName: ANALYTICS_TABLE,
        Item: marshall(analytics),
      }));
      console.log(`  ✅ Added analytics for: ${analytics.shortCode}`);
    } catch (error) {
      console.warn(`  ⚠️  Failed to add analytics for ${analytics.shortCode}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

async function main(): Promise<void> {
  console.log('🚀 Setting up DynamoDB Local for Link Shortener');
  console.log('=====================================');
  console.log(`DynamoDB Endpoint: ${process.env.DYNAMODB_LOCAL_ENDPOINT}`);
  console.log(`AWS Region: ${process.env.AWS_REGION}`);
  console.log('');

  try {
    // Create tables
    await createLinksTable();
    await createAnalyticsTable();

    // Wait for tables to become active
    await waitForTableActive(LINKS_TABLE);
    await waitForTableActive(ANALYTICS_TABLE);

    // Populate test data
    await populateTestData();

    console.log('');
    console.log('🎉 DynamoDB Local setup completed successfully!');
    console.log('');
    console.log('Test your setup:');
    console.log(`  curl http://localhost:3000/github`);
    console.log(`  curl http://localhost:3000/api/analytics/github`);
    console.log('');
    console.log('DynamoDB Admin UI:');
    console.log(`  http://localhost:8000/shell (if using DynamoDB Local with GUI)`);
    
  } catch (error) {
    console.error('❌ Setup failed:', error);
    process.exit(1);
  }
}

// Run the setup if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { main as setupDynamoDBLocal };