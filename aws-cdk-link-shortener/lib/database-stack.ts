import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface DatabaseStackProps extends cdk.StackProps {
  environment: string;
  config: any;
}

export class DatabaseStack extends cdk.Stack {
  public readonly linksTable: dynamodb.Table;
  public readonly analyticsTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    const { environment, config } = props;

    // Links table - main storage for shortened URLs
    this.linksTable = new dynamodb.Table(this, 'LinksTable', {
      tableName: `LinkShortener-Links-${environment}`,
      partitionKey: {
        name: 'shortCode',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.ON_DEMAND, // Better for unpredictable traffic
      
      // Enable point-in-time recovery for production
      pointInTimeRecovery: environment === 'prod',
      
      // Backup configuration
      ...(environment === 'prod' && {
        backupTable: {
          backup: dynamodb.BackupProps.daily(),
        },
      }),

      // Encryption at rest
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      
      // Enable streams for analytics and monitoring
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // GSI for deduplication - find existing URLs to prevent duplicates
    this.linksTable.addGlobalSecondaryIndex({
      indexName: 'OriginalUrlIndex',
      partitionKey: {
        name: 'originalUrlHash',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // GSI for user management - list URLs by user
    this.linksTable.addGlobalSecondaryIndex({
      indexName: 'UserIndex',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Analytics table - stores click events and metrics
    this.analyticsTable = new dynamodb.Table(this, 'AnalyticsTable', {
      tableName: `LinkShortener-Analytics-${environment}`,
      partitionKey: {
        name: 'shortCode',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      billingMode: dynamodb.BillingMode.ON_DEMAND,
      
      // TTL for automatic cleanup of old analytics data
      timeToLiveAttribute: 'expiresAt',
      
      // Enable point-in-time recovery for production
      pointInTimeRecovery: environment === 'prod',
      
      // Encryption at rest
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // GSI for time-based analytics queries - get clicks by time range
    this.analyticsTable.addGlobalSecondaryIndex({
      indexName: 'TimeRangeIndex',
      partitionKey: {
        name: 'hourPartition', // shortCode#hour for efficient partitioning
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI for geographic analytics - analyze clicks by country
    this.analyticsTable.addGlobalSecondaryIndex({
      indexName: 'GeographicIndex',
      partitionKey: {
        name: 'country',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.INCLUDE,
      nonKeyAttributes: ['shortCode', 'userAgent', 'referer'],
    });

    // Outputs for other stacks
    new cdk.CfnOutput(this, 'LinksTableName', {
      value: this.linksTable.tableName,
      exportName: `LinkShortener-LinksTable-${environment}`,
      description: 'Links DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'AnalyticsTableName', {
      value: this.analyticsTable.tableName,
      exportName: `LinkShortener-AnalyticsTable-${environment}`,
      description: 'Analytics DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'LinksTableArn', {
      value: this.linksTable.tableArn,
      exportName: `LinkShortener-LinksTableArn-${environment}`,
      description: 'Links DynamoDB table ARN',
    });

    new cdk.CfnOutput(this, 'AnalyticsTableArn', {
      value: this.analyticsTable.tableArn,
      exportName: `LinkShortener-AnalyticsTableArn-${environment}`,
      description: 'Analytics DynamoDB table ARN',
    });

    // Tags for cost allocation
    cdk.Tags.of(this.linksTable).add('Component', 'Storage');
    cdk.Tags.of(this.analyticsTable).add('Component', 'Analytics');
    cdk.Tags.of(this.linksTable).add('CostCenter', 'LinkShortener');
    cdk.Tags.of(this.analyticsTable).add('CostCenter', 'LinkShortener');
  }
}