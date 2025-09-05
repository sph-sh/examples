import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, QueryCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { z } from 'zod';

// Initialize DynamoDB client
const dynamodb = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  requestHandler: {
    connectionTimeout: 1000,
    requestTimeout: 5000, // Longer timeout for analytics queries
  },
});

// Query parameters validation
const AnalyticsQuerySchema = z.object({
  period: z.enum(['1h', '24h', '7d', '30d']).optional().default('24h'),
  granularity: z.enum(['hour', 'day']).optional().default('hour'),
  includeEvents: z.enum(['all', 'success', 'failures']).optional().default('all'),
});

interface AnalyticsData {
  totalClicks: number;
  uniqueClicks: number;
  period: string;
  granularity: string;
  timeline: TimelineEntry[];
  referrers: ReferrerStats[];
  countries: CountryStats[];
  devices: DeviceStats;
  browsers: BrowserStats[];
  summary: AnalyticsSummary;
}

interface TimelineEntry {
  timestamp: number;
  clicks: number;
  uniqueClicks: number;
  period: string;
}

interface ReferrerStats {
  referrer: string;
  clicks: number;
  percentage: number;
}

interface CountryStats {
  country: string;
  clicks: number;
  percentage: number;
}

interface DeviceStats {
  desktop: number;
  mobile: number;
  tablet: number;
  unknown: number;
}

interface BrowserStats {
  browser: string;
  version: string;
  clicks: number;
  percentage: number;
}

interface AnalyticsSummary {
  createdAt: string;
  firstClick?: string;
  lastClick?: string;
  peakHour: string;
  peakClicks: number;
  avgClicksPerHour: number;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const startTime = Date.now();
  const shortCode = event.pathParameters?.shortCode;

  if (!shortCode) {
    return createErrorResponse(400, 'Short code is required');
  }

  try {
    // Validate query parameters
    const queryParams = AnalyticsQuerySchema.parse(event.queryStringParameters || {});
    const { period, granularity, includeEvents } = queryParams;

    // Check if the link exists
    const linkExists = await checkLinkExists(shortCode);
    if (!linkExists) {
      return createErrorResponse(404, 'Short link not found');
    }

    // Calculate time range
    const timeRange = calculateTimeRange(period);
    
    // Fetch analytics data
    const [
      clickEvents,
      linkMetadata,
    ] = await Promise.all([
      fetchClickEvents(shortCode, timeRange, includeEvents),
      fetchLinkMetadata(shortCode),
    ]);

    // Process analytics data
    const analyticsData = await processAnalyticsData(
      clickEvents,
      linkMetadata,
      period,
      granularity,
      timeRange
    );

    // Log performance metrics
    const responseTime = Date.now() - startTime;
    console.log(JSON.stringify({
      action: 'get_analytics',
      shortCode,
      period,
      granularity,
      eventsCount: clickEvents.length,
      responseTime,
      success: true,
    }));

    return createSuccessResponse(analyticsData);

  } catch (error) {
    console.error('Analytics error:', error);
    
    if (error instanceof z.ZodError) {
      return createErrorResponse(400, `Invalid query parameters: ${error.errors[0].message}`);
    }
    
    // Log error for monitoring
    console.log(JSON.stringify({
      action: 'get_analytics',
      shortCode,
      responseTime: Date.now() - startTime,
      success: false,
      error: error.message,
    }));

    return createErrorResponse(500, 'Internal server error');
  }
};

async function checkLinkExists(shortCode: string): Promise<boolean> {
  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: process.env.LINKS_TABLE_NAME!,
      Key: { shortCode: { S: shortCode } },
      ProjectionExpression: 'shortCode',
    }));

    return !!result.Item;
  } catch (error) {
    console.error('Error checking link existence:', error);
    return false;
  }
}

async function fetchLinkMetadata(shortCode: string): Promise<any> {
  try {
    const result = await dynamodb.send(new GetItemCommand({
      TableName: process.env.LINKS_TABLE_NAME!,
      Key: { shortCode: { S: shortCode } },
      ProjectionExpression: 'originalUrl, createdAt, clickCount, lastClickAt, userId, metadata',
    }));

    if (!result.Item) {
      throw new Error('Link not found');
    }

    return unmarshall(result.Item);
  } catch (error) {
    console.error('Error fetching link metadata:', error);
    throw error;
  }
}

async function fetchClickEvents(
  shortCode: string,
  timeRange: { startTime: number; endTime: number },
  includeEvents: string
): Promise<any[]> {
  const events: any[] = [];
  let lastEvaluatedKey: any = undefined;

  try {
    do {
      const result = await dynamodb.send(new QueryCommand({
        TableName: process.env.ANALYTICS_TABLE_NAME!,
        KeyConditionExpression: 'shortCode = :shortCode AND #timestamp BETWEEN :startTime AND :endTime',
        ExpressionAttributeNames: {
          '#timestamp': 'timestamp',
        },
        ExpressionAttributeValues: {
          ':shortCode': { S: shortCode },
          ':startTime': { N: timeRange.startTime.toString() },
          ':endTime': { N: timeRange.endTime.toString() },
        },
        
        // Filter by event type if specified
        ...(includeEvents !== 'all' && {
          FilterExpression: includeEvents === 'success' 
            ? 'eventType = :eventType'
            : 'eventType <> :eventType',
          ExpressionAttributeValues: {
            ...{
              ':shortCode': { S: shortCode },
              ':startTime': { N: timeRange.startTime.toString() },
              ':endTime': { N: timeRange.endTime.toString() },
            },
            ':eventType': { S: 'SUCCESS' },
          },
        }),

        Limit: 1000, // Process in batches
        ExclusiveStartKey: lastEvaluatedKey,
      }));

      if (result.Items) {
        events.push(...result.Items.map(item => unmarshall(item)));
      }

      lastEvaluatedKey = result.LastEvaluatedKey;
      
      // Prevent infinite loops
      if (events.length > 10000) {
        console.warn(`Too many events for ${shortCode}, limiting to 10000`);
        break;
      }
      
    } while (lastEvaluatedKey);

    return events;
  } catch (error) {
    console.error('Error fetching click events:', error);
    return [];
  }
}

function calculateTimeRange(period: string): { startTime: number; endTime: number } {
  const endTime = Date.now();
  let startTime: number;

  switch (period) {
    case '1h':
      startTime = endTime - (60 * 60 * 1000);
      break;
    case '24h':
      startTime = endTime - (24 * 60 * 60 * 1000);
      break;
    case '7d':
      startTime = endTime - (7 * 24 * 60 * 60 * 1000);
      break;
    case '30d':
      startTime = endTime - (30 * 24 * 60 * 60 * 1000);
      break;
    default:
      startTime = endTime - (24 * 60 * 60 * 1000);
  }

  return { startTime, endTime };
}

async function processAnalyticsData(
  events: any[],
  linkMetadata: any,
  period: string,
  granularity: string,
  timeRange: { startTime: number; endTime: number }
): Promise<AnalyticsData> {
  
  // Filter successful events for most analytics
  const successEvents = events.filter(event => event.eventType === 'SUCCESS');
  
  // Calculate unique clicks (by IP hash)
  const uniqueIPs = new Set(successEvents.map(event => event.ipHash));
  const uniqueClicks = uniqueIPs.size;

  // Generate timeline data
  const timeline = generateTimeline(successEvents, timeRange, granularity);

  // Calculate referrer statistics
  const referrers = calculateReferrerStats(successEvents);

  // Calculate country statistics
  const countries = calculateCountryStats(successEvents);

  // Calculate device statistics
  const devices = calculateDeviceStats(successEvents);

  // Calculate browser statistics
  const browsers = calculateBrowserStats(successEvents);

  // Generate summary
  const summary = generateSummary(successEvents, linkMetadata, timeline);

  return {
    totalClicks: successEvents.length,
    uniqueClicks,
    period,
    granularity,
    timeline,
    referrers,
    countries,
    devices,
    browsers,
    summary,
  };
}

function generateTimeline(
  events: any[],
  timeRange: { startTime: number; endTime: number },
  granularity: string
): TimelineEntry[] {
  const intervalMs = granularity === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const timeline: TimelineEntry[] = [];

  // Create time buckets
  for (let time = timeRange.startTime; time < timeRange.endTime; time += intervalMs) {
    const bucketEvents = events.filter(
      event => event.timestamp >= time && event.timestamp < time + intervalMs
    );

    const uniqueIPs = new Set(bucketEvents.map(event => event.ipHash));

    timeline.push({
      timestamp: time,
      clicks: bucketEvents.length,
      uniqueClicks: uniqueIPs.size,
      period: new Date(time).toISOString(),
    });
  }

  return timeline;
}

function calculateReferrerStats(events: any[]): ReferrerStats[] {
  const referrerCounts: { [key: string]: number } = {};
  
  events.forEach(event => {
    const referrer = event.referer === 'direct' ? 'Direct' : 
                    event.referer ? new URL(event.referer).hostname : 'Unknown';
    referrerCounts[referrer] = (referrerCounts[referrer] || 0) + 1;
  });

  const total = events.length;
  
  return Object.entries(referrerCounts)
    .map(([referrer, clicks]) => ({
      referrer,
      clicks,
      percentage: total > 0 ? Math.round((clicks / total) * 100) : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10); // Top 10 referrers
}

function calculateCountryStats(events: any[]): CountryStats[] {
  const countryCounts: { [key: string]: number } = {};
  
  events.forEach(event => {
    const country = event.country || 'Unknown';
    countryCounts[country] = (countryCounts[country] || 0) + 1;
  });

  const total = events.length;
  
  return Object.entries(countryCounts)
    .map(([country, clicks]) => ({
      country,
      clicks,
      percentage: total > 0 ? Math.round((clicks / total) * 100) : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10); // Top 10 countries
}

function calculateDeviceStats(events: any[]): DeviceStats {
  const stats: DeviceStats = {
    desktop: 0,
    mobile: 0,
    tablet: 0,
    unknown: 0,
  };

  events.forEach(event => {
    const deviceType = event.device || 'unknown';
    switch (deviceType.toLowerCase()) {
      case 'mobile':
        stats.mobile++;
        break;
      case 'tablet':
        stats.tablet++;
        break;
      case 'desktop':
      case 'pc':
        stats.desktop++;
        break;
      default:
        stats.unknown++;
    }
  });

  return stats;
}

function calculateBrowserStats(events: any[]): BrowserStats[] {
  const browserCounts: { [key: string]: number } = {};
  
  events.forEach(event => {
    const browser = event.browser || 'Unknown';
    const version = event.browserVersion || '';
    const key = version ? `${browser} ${version}` : browser;
    browserCounts[key] = (browserCounts[key] || 0) + 1;
  });

  const total = events.length;
  
  return Object.entries(browserCounts)
    .map(([browserVersion, clicks]) => {
      const parts = browserVersion.split(' ');
      return {
        browser: parts[0],
        version: parts.slice(1).join(' ') || 'Unknown',
        clicks,
        percentage: total > 0 ? Math.round((clicks / total) * 100) : 0,
      };
    })
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10); // Top 10 browsers
}

function generateSummary(
  events: any[],
  linkMetadata: any,
  timeline: TimelineEntry[]
): AnalyticsSummary {
  const sortedEvents = events.sort((a, b) => a.timestamp - b.timestamp);
  const peakEntry = timeline.reduce((max, entry) => 
    entry.clicks > max.clicks ? entry : max, timeline[0] || { clicks: 0, period: '' }
  );

  const totalHours = timeline.length;
  const avgClicksPerHour = totalHours > 0 ? Math.round(events.length / totalHours) : 0;

  return {
    createdAt: new Date(linkMetadata.createdAt).toISOString(),
    firstClick: sortedEvents.length > 0 ? new Date(sortedEvents[0].timestamp).toISOString() : undefined,
    lastClick: sortedEvents.length > 0 ? new Date(sortedEvents[sortedEvents.length - 1].timestamp).toISOString() : undefined,
    peakHour: peakEntry.period,
    peakClicks: peakEntry.clicks,
    avgClicksPerHour,
  };
}

function createSuccessResponse(data: AnalyticsData): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-cache', // Analytics data should not be cached
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