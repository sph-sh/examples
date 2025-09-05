import { APIGatewayProxyEvent, APIGatewayProxyResult, SQSEvent } from 'aws-lambda';
import { SQSClient, SendMessageCommand, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { v4 as uuidv4 } from 'uuid';
import { ValidationHelper, CreateLinkSchema } from '../shared/validation';
import { withRateLimit, createRateLimitHeaders } from '../shared/rate-limiter';

// AWS clients
const sqs = new SQSClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
});

const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
});

// Environment variables
const QUEUE_URL = process.env.BULK_QUEUE_URL!;
const LINKS_TABLE = process.env.LINKS_TABLE!;
const JOBS_TABLE = process.env.JOBS_TABLE!;

interface BulkCreateRequest {
  urls: {
    url: string;
    customCode?: string;
    metadata?: {
      title?: string;
      description?: string;
      tags?: string[];
    };
  }[];
  userId?: string;
  jobName?: string;
}

interface BulkJob {
  jobId: string;
  userId: string;
  jobName: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  totalUrls: number;
  processedUrls: number;
  successfulUrls: number;
  failedUrls: number;
  createdAt: string;
  completedAt?: string;
  results?: {
    successful: Array<{
      originalUrl: string;
      shortCode: string;
      shortUrl: string;
    }>;
    failed: Array<{
      originalUrl: string;
      error: string;
    }>;
  };
}

/**
 * API Gateway handler for bulk operations
 */
export const apiHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Bulk API event:', JSON.stringify(event, null, 2));

  try {
    const method = event.httpMethod;
    const path = event.path;

    // Get user context from authorizer
    const userId = event.requestContext.authorizer?.userId || 'anonymous';
    const userRole = event.requestContext.authorizer?.role || 'free';

    // Rate limiting
    const clientIp = event.requestContext.identity?.sourceIp || 'unknown';
    const rateLimitResult = await withRateLimit({
      identifier: userId !== 'anonymous' ? userId : clientIp,
      action: 'create', // Bulk operations count as create actions
      userRole: userRole as 'free' | 'premium' | 'admin',
      increment: method === 'POST' ? 5 : 1, // Bulk operations cost more
    });

    const rateLimitHeaders = createRateLimitHeaders(rateLimitResult);

    if (!rateLimitResult.allowed) {
      return {
        statusCode: 429,
        headers: {
          'Content-Type': 'application/json',
          ...rateLimitHeaders,
        },
        body: JSON.stringify({
          error: 'Rate limit exceeded',
          message: 'Too many requests. Please try again later.',
          retryAfter: rateLimitResult.retryAfter,
        }),
      };
    }

    // Route requests
    if (method === 'POST' && path.endsWith('/bulk')) {
      return await handleBulkCreate(event, userId, rateLimitHeaders);
    } else if (method === 'GET' && path.includes('/bulk/')) {
      const jobId = path.split('/').pop();
      return await handleGetJob(jobId!, userId, rateLimitHeaders);
    }

    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Not found' }),
    };

  } catch (error) {
    console.error('Bulk API error:', error);
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Internal server error',
        message: 'Failed to process bulk request',
      }),
    };
  }
};

/**
 * Handle bulk URL creation request
 */
async function handleBulkCreate(
  event: APIGatewayProxyEvent,
  userId: string,
  rateLimitHeaders: Record<string, string>
): Promise<APIGatewayProxyResult> {
  if (!event.body) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Request body is required' }),
    };
  }

  try {
    const request: BulkCreateRequest = JSON.parse(event.body);

    // Validate request
    if (!request.urls || !Array.isArray(request.urls) || request.urls.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'urls array is required and must not be empty' }),
      };
    }

    // Limit batch size based on user role
    const maxBatchSize = userId === 'admin' ? 1000 : userId === 'premium' ? 100 : 10;
    if (request.urls.length > maxBatchSize) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          error: 'Batch too large',
          message: `Maximum batch size is ${maxBatchSize} URLs`,
        }),
      };
    }

    // Validate each URL
    for (let i = 0; i < request.urls.length; i++) {
      const urlData = request.urls[i];
      const validation = ValidationHelper.validateUrl(urlData.url);
      
      if (!validation.isValid) {
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error: 'Invalid URL',
            message: `URL at index ${i}: ${validation.error}`,
          }),
        };
      }
    }

    // Create bulk job
    const jobId = uuidv4();
    const job: BulkJob = {
      jobId,
      userId,
      jobName: request.jobName || `Bulk job ${new Date().toISOString()}`,
      status: 'pending',
      totalUrls: request.urls.length,
      processedUrls: 0,
      successfulUrls: 0,
      failedUrls: 0,
      createdAt: new Date().toISOString(),
    };

    // Save job to DynamoDB
    await dynamodb.send(new PutItemCommand({
      TableName: JOBS_TABLE,
      Item: marshall(job),
    }));

    // Send URLs to SQS for processing
    const messages = request.urls.map((urlData, index) => ({
      Id: `${jobId}-${index}`,
      MessageBody: JSON.stringify({
        jobId,
        userId,
        index,
        ...urlData,
      }),
      MessageGroupId: jobId, // For FIFO queues
      MessageDeduplicationId: `${jobId}-${index}-${Date.now()}`,
    }));

    // Send messages in batches of 10 (SQS limit)
    const batches = [];
    for (let i = 0; i < messages.length; i += 10) {
      batches.push(messages.slice(i, i + 10));
    }

    for (const batch of batches) {
      await sqs.send(new SendMessageBatchCommand({
        QueueUrl: QUEUE_URL,
        Entries: batch,
      }));
    }

    return {
      statusCode: 202,
      headers: {
        'Content-Type': 'application/json',
        ...rateLimitHeaders,
      },
      body: JSON.stringify({
        jobId,
        status: 'pending',
        message: 'Bulk job created successfully',
        totalUrls: request.urls.length,
        statusUrl: `/api/bulk/${jobId}`,
      }),
    };

  } catch (error) {
    console.error('Bulk create error:', error);
    
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request format' }),
    };
  }
}

/**
 * Handle get job status request
 */
async function handleGetJob(
  jobId: string,
  userId: string,
  rateLimitHeaders: Record<string, string>
): Promise<APIGatewayProxyResult> {
  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: JOBS_TABLE,
      KeyConditionExpression: 'jobId = :jobId',
      ExpressionAttributeValues: marshall({
        ':jobId': jobId,
      }),
    }));

    if (!result.Items || result.Items.length === 0) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Job not found' }),
      };
    }

    const job = unmarshall(result.Items[0]) as BulkJob;

    // Check authorization (users can only see their own jobs, admins can see all)
    if (job.userId !== userId && userId !== 'admin') {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Access denied' }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        ...rateLimitHeaders,
      },
      body: JSON.stringify(job),
    };

  } catch (error) {
    console.error('Get job error:', error);
    
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to get job status' }),
    };
  }
}

/**
 * SQS handler for processing individual URLs
 */
export const sqsHandler = async (event: SQSEvent): Promise<void> => {
  console.log('SQS event:', JSON.stringify(event, null, 2));

  for (const record of event.Records) {
    try {
      const messageData = JSON.parse(record.body);
      const { jobId, userId, index, url, customCode, metadata } = messageData;

      console.log(`Processing URL ${index} for job ${jobId}: ${url}`);

      // Generate short code
      const shortCode = customCode || ValidationHelper.generateSafeId(8);

      // Create short link
      const shortUrl = `https://${process.env.DOMAIN_NAME}/${shortCode}`;
      const now = new Date().toISOString();

      const linkItem = {
        shortCode,
        originalUrl: url,
        userId,
        createdAt: now,
        clickCount: 0,
        isActive: true,
        metadata: metadata || {},
      };

      // Save to DynamoDB
      await dynamodb.send(new PutItemCommand({
        TableName: LINKS_TABLE,
        Item: marshall(linkItem),
        ConditionExpression: 'attribute_not_exists(shortCode)', // Prevent duplicates
      }));

      // Update job progress
      await updateJobProgress(jobId, index, {
        success: true,
        result: {
          originalUrl: url,
          shortCode,
          shortUrl,
        },
      });

      console.log(`Successfully processed URL ${index} for job ${jobId}`);

    } catch (error) {
      console.error(`Failed to process SQS record:`, error);
      
      // Update job with failure
      const messageData = JSON.parse(record.body);
      await updateJobProgress(messageData.jobId, messageData.index, {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        url: messageData.url,
      });
    }
  }
};

/**
 * Update job progress in DynamoDB
 */
async function updateJobProgress(
  jobId: string,
  index: number,
  result: {
    success: boolean;
    result?: { originalUrl: string; shortCode: string; shortUrl: string };
    error?: string;
    url?: string;
  }
): Promise<void> {
  try {
    // This would be more complex in production - you'd need to:
    // 1. Use atomic counters for processedUrls, successfulUrls, failedUrls
    // 2. Store individual results in a separate table or S3
    // 3. Update job status when all URLs are processed
    
    console.log(`Updating job ${jobId} progress: ${JSON.stringify(result)}`);
    
    // For now, just log the progress
    // In production, implement proper job progress tracking
    
  } catch (error) {
    console.error('Failed to update job progress:', error);
  }
}