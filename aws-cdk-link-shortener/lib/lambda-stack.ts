import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

interface LambdaStackProps extends cdk.StackProps {
  environment: string;
  config: any;
  linksTable: dynamodb.Table;
  analyticsTable: dynamodb.Table;
}

export class LambdaStack extends cdk.Stack {
  public readonly createHandler: lambda.Function;
  public readonly redirectHandler: lambda.Function;
  public readonly analyticsHandler: lambda.Function;
  public readonly sharedLayer: lambda.LayerVersion;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const { environment, config, linksTable, analyticsTable } = props;

    // Shared Lambda layer for common dependencies
    this.sharedLayer = new lambda.LayerVersion(this, 'SharedLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '../layers/shared')),
      compatibleRuntimes: [lambda.Runtime.NODEJS_18_X],
      description: 'Shared dependencies for Link Shortener Lambda functions',
    });

    // Common environment variables
    const commonEnvVars = {
      LINKS_TABLE_NAME: linksTable.tableName,
      ANALYTICS_TABLE_NAME: analyticsTable.tableName,
      AWS_REGION: this.region,
      ENVIRONMENT: environment,
      CUSTOM_DOMAIN: config.domainName,
      IP_SALT: 'change-this-in-production-' + environment,
    };

    // Common Lambda function configuration
    const commonLambdaProps: Partial<lambda.FunctionProps> = {
      runtime: lambda.Runtime.NODEJS_18_X,
      architecture: lambda.Architecture.ARM_64, // 20% cost reduction
      layers: [this.sharedLayer],
      environment: commonEnvVars,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256, // Optimized for our workload
      logRetention: environment === 'prod' 
        ? logs.RetentionDays.ONE_MONTH 
        : logs.RetentionDays.ONE_WEEK,
      
      // Enable X-Ray tracing for observability
      tracing: config.enableXRay ? lambda.Tracing.ACTIVE : lambda.Tracing.DISABLED,
      
      // Enable insights for detailed metrics
      insightsVersion: config.enableDetailedMetrics 
        ? lambda.LambdaInsightsVersion.VERSION_1_0_229_0 
        : undefined,
    };

    // Create Handler - POST /api/shorten
    this.createHandler = new lambda.Function(this, 'CreateHandler', {
      ...commonLambdaProps,
      functionName: `LinkShortener-Create-${environment}`,
      description: 'Creates shortened URLs',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/create')),
      handler: 'index.handler',
      memorySize: 512, // More memory for URL metadata fetching
      timeout: cdk.Duration.seconds(15), // Allow time for metadata fetching
      
      // Environment variables specific to create function
      environment: {
        ...commonEnvVars,
        ENABLE_METADATA_FETCH: 'true',
        MAX_URL_LENGTH: '2048',
      },
    });

    // Redirect Handler - GET /{shortCode}
    this.redirectHandler = new lambda.Function(this, 'RedirectHandler', {
      ...commonLambdaProps,
      functionName: `LinkShortener-Redirect-${environment}`,
      description: 'Handles URL redirects and analytics tracking',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/redirect')),
      handler: 'index.handler',
      memorySize: 256, // Minimal memory for fast redirects
      timeout: cdk.Duration.seconds(5), // Quick redirects only
      
      // Enable provisioned concurrency in production for consistent performance
      ...(environment === 'prod' && {
        reservedConcurrentExecutions: 100,
      }),
    });

    // Analytics Handler - GET /api/analytics/{shortCode}
    this.analyticsHandler = new lambda.Function(this, 'AnalyticsHandler', {
      ...commonLambdaProps,
      functionName: `LinkShortener-Analytics-${environment}`,
      description: 'Provides analytics data and reports',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda/analytics')),
      handler: 'index.handler',
      memorySize: 512, // More memory for data processing
      timeout: cdk.Duration.seconds(30), // Allow time for complex queries
    });

    // Grant DynamoDB permissions
    linksTable.grantReadWriteData(this.createHandler);
    linksTable.grantReadWriteData(this.redirectHandler);
    linksTable.grantReadData(this.analyticsHandler);
    
    analyticsTable.grantWriteData(this.redirectHandler);
    analyticsTable.grantReadData(this.analyticsHandler);

    // Grant additional permissions for GSI access
    [this.createHandler, this.analyticsHandler].forEach(func => {
      func.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'dynamodb:Query',
          'dynamodb:BatchGetItem',
        ],
        resources: [
          `${linksTable.tableArn}/index/*`,
          `${analyticsTable.tableArn}/index/*`,
        ],
      }));
    });

    // CloudWatch permissions for custom metrics
    [this.createHandler, this.redirectHandler, this.analyticsHandler].forEach(func => {
      func.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cloudwatch:PutMetricData',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'cloudwatch:namespace': 'LinkShortener',
          },
        },
      }));
    });

    // Add event source mappings for real-time processing (if needed)
    if (environment === 'prod') {
      // DynamoDB Stream for real-time analytics processing
      const streamEventSource = new lambda.EventSourceMapping(this, 'LinksStreamProcessor', {
        eventSourceArn: linksTable.tableStreamArn!,
        target: this.analyticsHandler,
        batchSize: 10,
        maxBatchingWindow: cdk.Duration.seconds(5),
        parallelizationFactor: 2,
        retryAttempts: 3,
        startingPosition: lambda.StartingPosition.LATEST,
      });
    }

    // Create Lambda aliases for blue/green deployments
    if (environment === 'prod') {
      const createAlias = this.createHandler.addAlias('live', {
        version: this.createHandler.currentVersion,
        description: 'Live version of create handler',
      });

      const redirectAlias = this.redirectHandler.addAlias('live', {
        version: this.redirectHandler.currentVersion,
        description: 'Live version of redirect handler',
        
        // Enable provisioned concurrency for consistent performance
        provisionedConcurrencyConfig: {
          provisionedConcurrentExecutions: 10,
        },
      });

      const analyticsAlias = this.analyticsHandler.addAlias('live', {
        version: this.analyticsHandler.currentVersion,
        description: 'Live version of analytics handler',
      });
    }

    // Custom CloudWatch metrics
    this.createCustomMetrics();

    // Output Lambda function ARNs
    new cdk.CfnOutput(this, 'CreateHandlerArn', {
      value: this.createHandler.functionArn,
      exportName: `LinkShortener-CreateHandlerArn-${environment}`,
      description: 'Create handler Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'RedirectHandlerArn', {
      value: this.redirectHandler.functionArn,
      exportName: `LinkShortener-RedirectHandlerArn-${environment}`,
      description: 'Redirect handler Lambda function ARN',
    });

    new cdk.CfnOutput(this, 'AnalyticsHandlerArn', {
      value: this.analyticsHandler.functionArn,
      exportName: `LinkShortener-AnalyticsHandlerArn-${environment}`,
      description: 'Analytics handler Lambda function ARN',
    });

    // Tags for cost allocation and management
    cdk.Tags.of(this.createHandler).add('Component', 'CreateAPI');
    cdk.Tags.of(this.redirectHandler).add('Component', 'RedirectEngine');
    cdk.Tags.of(this.analyticsHandler).add('Component', 'Analytics');
  }

  private createCustomMetrics(): void {
    // Custom metrics will be published from Lambda functions
    // This method can be used to create CloudWatch dashboards
    // or set up additional monitoring infrastructure
  }
}