import { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Optimized DynamoDB client configuration
const dynamoConfig: DynamoDBClientConfig = {
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 3000,
  },
  
  // Use local DynamoDB for development
  ...(process.env.NODE_ENV === 'development' && process.env.DYNAMODB_LOCAL_ENDPOINT && {
    endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
    credentials: {
      accessKeyId: process.env.DYNAMODB_LOCAL_ACCESS_KEY_ID || 'local',
      secretAccessKey: process.env.DYNAMODB_LOCAL_SECRET_ACCESS_KEY || 'local',
    },
  }),
};

// Create base DynamoDB client
export const dynamoClient = new DynamoDBClient(dynamoConfig);

// Create document client for easier operations
export const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    convertEmptyValues: false,
    removeUndefinedValues: true,
    convertClassInstanceToMap: false,
  },
  unmarshallOptions: {
    wrapNumbers: false,
  },
});

// Table names from environment variables
export const TABLES = {
  LINKS: process.env.LINKS_TABLE_NAME!,
  ANALYTICS: process.env.ANALYTICS_TABLE_NAME!,
} as const;

// Common DynamoDB operations
export class DynamoDBHelper {
  
  /**
   * Put item with automatic retry and error handling
   */
  static async putItem(tableName: string, item: any, conditionExpression?: string): Promise<void> {
    const params: any = {
      TableName: tableName,
      Item: item,
    };

    if (conditionExpression) {
      params.ConditionExpression = conditionExpression;
    }

    try {
      await docClient.send(new PutItemCommand(params));
    } catch (error) {
      console.error(`Error putting item to ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Get item with projection and consistent read options
   */
  static async getItem(
    tableName: string, 
    key: any, 
    projectionExpression?: string,
    consistentRead = false
  ): Promise<any | null> {
    const params: any = {
      TableName: tableName,
      Key: key,
      ConsistentRead: consistentRead,
    };

    if (projectionExpression) {
      params.ProjectionExpression = projectionExpression;
    }

    try {
      const result = await docClient.send(new GetItemCommand(params));
      return result.Item || null;
    } catch (error) {
      console.error(`Error getting item from ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Query with pagination support
   */
  static async queryItems(
    tableName: string,
    keyConditionExpression: string,
    expressionAttributeValues: any,
    options: {
      indexName?: string;
      projectionExpression?: string;
      filterExpression?: string;
      limit?: number;
      scanIndexForward?: boolean;
      exclusiveStartKey?: any;
    } = {}
  ): Promise<{ items: any[]; lastEvaluatedKey?: any }> {
    const params: any = {
      TableName: tableName,
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ...options,
    };

    try {
      const result = await docClient.send(new QueryCommand(params));
      return {
        items: result.Items || [],
        lastEvaluatedKey: result.LastEvaluatedKey,
      };
    } catch (error) {
      console.error(`Error querying ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Update item with condition checking
   */
  static async updateItem(
    tableName: string,
    key: any,
    updateExpression: string,
    expressionAttributeValues: any,
    conditionExpression?: string
  ): Promise<any> {
    const params: any = {
      TableName: tableName,
      Key: key,
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    };

    if (conditionExpression) {
      params.ConditionExpression = conditionExpression;
    }

    try {
      const result = await docClient.send(new UpdateItemCommand(params));
      return result.Attributes;
    } catch (error) {
      console.error(`Error updating item in ${tableName}:`, error);
      throw error;
    }
  }

  /**
   * Batch write operations with automatic retry
   */
  static async batchWrite(requests: any[]): Promise<void> {
    const batchSize = 25; // DynamoDB batch limit
    const batches = [];

    for (let i = 0; i < requests.length; i += batchSize) {
      batches.push(requests.slice(i, i + batchSize));
    }

    for (const batch of batches) {
      const params = {
        RequestItems: batch.reduce((acc: any, request: any) => {
          const tableName = request.tableName;
          if (!acc[tableName]) {
            acc[tableName] = [];
          }
          acc[tableName].push({
            PutRequest: { Item: request.item }
          });
          return acc;
        }, {}),
      };

      try {
        await docClient.send(new BatchWriteItemCommand(params));
      } catch (error) {
        console.error('Error in batch write:', error);
        throw error;
      }
    }
  }

  /**
   * Check if item exists
   */
  static async itemExists(tableName: string, key: any): Promise<boolean> {
    try {
      const result = await docClient.send(new GetItemCommand({
        TableName: tableName,
        Key: key,
        ProjectionExpression: Object.keys(key)[0], // Only get the key field
      }));
      return !!result.Item;
    } catch (error) {
      console.error(`Error checking if item exists in ${tableName}:`, error);
      return false;
    }
  }

  /**
   * Get multiple items by keys
   */
  static async batchGetItems(tableName: string, keys: any[]): Promise<any[]> {
    if (keys.length === 0) return [];

    const batchSize = 100; // DynamoDB batch limit for BatchGetItem
    const results: any[] = [];

    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      
      const params = {
        RequestItems: {
          [tableName]: {
            Keys: batch,
          },
        },
      };

      try {
        const result = await docClient.send(new BatchGetItemCommand(params));
        if (result.Responses && result.Responses[tableName]) {
          results.push(...result.Responses[tableName]);
        }
      } catch (error) {
        console.error(`Error in batch get from ${tableName}:`, error);
        throw error;
      }
    }

    return results;
  }
}

// Import required commands
import { 
  PutItemCommand, 
  GetItemCommand, 
  QueryCommand, 
  UpdateItemCommand,
  BatchWriteItemCommand,
  BatchGetItemCommand,
} from '@aws-sdk/client-dynamodb';