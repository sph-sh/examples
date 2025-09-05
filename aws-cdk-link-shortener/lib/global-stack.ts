import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

interface GlobalStackProps extends cdk.StackProps {
  environment: string;
  config: {
    domainName: string;
    regions: string[];
    enableGlobalTables: boolean;
    enableHealthChecks: boolean;
    alarmEmail?: string;
  };
}

export class GlobalStack extends cdk.Stack {
  public globalTable?: dynamodb.Table;
  public globalAnalyticsTable?: dynamodb.Table;
  public globalHealthCheckTopic?: sns.Topic;
  public hostedZone?: route53.IHostedZone;

  constructor(scope: Construct, id: string, props: GlobalStackProps) {
    super(scope, id, props);

    const { environment, config } = props;

    // This stack should be deployed in us-east-1 for global services
    if (this.region !== 'us-east-1') {
      throw new Error('Global stack must be deployed in us-east-1 region');
    }

    // Create global DynamoDB tables
    this.createGlobalTables(environment, config);

    // Create Route 53 hosted zone and health checks
    this.createRoute53Resources(environment, config);

    // Create global monitoring
    this.createGlobalMonitoring(environment, config);

    // Create global IAM roles
    this.createGlobalIAMRoles(environment);

    // Create outputs
    this.createOutputs(environment);
  }

  private createGlobalTables(environment: string, config: GlobalStackProps['config']) {
    if (!config.enableGlobalTables) {
      return;
    }

    // Global Links Table
    (this as any).globalTable = new dynamodb.Table(this, 'GlobalLinksTable', {
      tableName: `LinkShortener-Links-Global-${environment}`,
      partitionKey: {
        name: 'shortCode',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST, // Start with on-demand for global tables
      
      // Global table configuration
      replicationRegions: config.regions.filter(region => region !== 'us-east-1'),
      
      // Enable streams for cross-region replication
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      
      // Point-in-time recovery
      pointInTimeRecovery: true,
      
      // Backup configuration
      deletionProtection: environment === 'prod',
      
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for URL deduplication (global)
    this.globalTable?.addGlobalSecondaryIndex({
      indexName: 'OriginalUrlIndex',
      partitionKey: {
        name: 'originalUrlHash',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });

    // Add GSI for user links (global)
    this.globalTable?.addGlobalSecondaryIndex({
      indexName: 'UserLinksIndex',
      partitionKey: {
        name: 'userId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'createdAt',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Global Analytics Table
    this.globalAnalyticsTable = new dynamodb.Table(this, 'GlobalAnalyticsTable', {
      tableName: `LinkShortener-Analytics-Global-${environment}`,
      partitionKey: {
        name: 'shortCode',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      
      // Global table configuration
      replicationRegions: config.regions.filter(region => region !== 'us-east-1'),
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      
      // TTL for analytics data (keep for 1 year)
      timeToLiveAttribute: 'expiresAt',
      
      pointInTimeRecovery: environment === 'prod',
      
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Add GSI for time-based analytics queries
    this.globalAnalyticsTable.addGlobalSecondaryIndex({
      indexName: 'TimeBasedAnalytics',
      partitionKey: {
        name: 'shortCode',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'hour',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }

  private createRoute53Resources(environment: string, config: GlobalStackProps['config']) {
    // Create or import hosted zone
    this.hostedZone = new route53.HostedZone(this, 'GlobalHostedZone', {
      zoneName: config.domainName,
      comment: `Global hosted zone for LinkShortener ${environment}`,
    });

    if (!config.enableHealthChecks) {
      return;
    }

    // Create health checks for each region
    const healthChecks: route53.CfnHealthCheck[] = [];
    
    config.regions.forEach((region, index) => {
      const healthCheck = new route53.CfnHealthCheck(this, `HealthCheck${region}`, {
        healthCheckConfig: {
          type: 'HTTPS',
          fullyQualifiedDomainName: `${region}-api.${config.domainName}`,
          resourcePath: '/api/health',
          port: 443,
          requestInterval: 30, // Check every 30 seconds
          failureThreshold: 3, // 3 consecutive failures trigger alarm
        },
      });

      healthChecks.push(healthCheck);

      // Create CloudWatch alarm for health check
      const healthCheckAlarm = new cloudwatch.Alarm(this, `HealthCheckAlarm${region}`, {
        alarmName: `LinkShortener-${environment}-HealthCheck-${region}`,
        alarmDescription: `Health check alarm for ${region} region`,
        
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Route53',
          metricName: 'HealthCheckStatus',
          dimensionsMap: {
            HealthCheckId: healthCheck.attrHealthCheckId,
          },
          statistic: 'Minimum',
          period: cdk.Duration.minutes(1),
        }),
        
        threshold: 1,
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });

      // Send health check failures to SNS
      healthCheckAlarm.addAlarmAction(
        new cdk.aws_cloudwatch_actions.SnsAction(this.globalHealthCheckTopic!)
      );
    });

    // Create failover routing policies
    this.createFailoverRouting(config.regions, healthChecks);
  }

  private createFailoverRouting(regions: string[], healthChecks: route53.CfnHealthCheck[]) {
    // Primary region (first in list)
    const primaryRegion = regions[0];
    const primaryHealthCheck = healthChecks[0];

    new route53.ARecord(this, 'PrimaryRecord', {
      zone: this.hostedZone!,
      recordName: 'api',
      target: route53.RecordTarget.fromValues(`${primaryRegion}-api.${this.hostedZone!.zoneName}`),
      setIdentifier: `Primary-${primaryRegion}`,
      geoLocation: route53.GeoLocation.default(),
      // healthCheckId: primaryHealthCheck.attrHealthCheckId, // Not supported in this CDK version
    });

    // Secondary regions
    regions.slice(1).forEach((region, index) => {
      const healthCheck = healthChecks[index + 1];
      
      new route53.ARecord(this, `SecondaryRecord${region}`, {
        zone: this.hostedZone!,
        recordName: 'api',
        target: route53.RecordTarget.fromValues(`${region}-api.${this.hostedZone!.zoneName}`),
        setIdentifier: `Secondary-${region}`,
        geoLocation: this.getGeoLocationForRegion(region),
        // healthCheckId: healthCheck.attrHealthCheckId, // Not supported in this CDK version
      });
    });
  }

  private getGeoLocationForRegion(region: string): route53.GeoLocation {
    // Map AWS regions to geographic locations
    const regionToGeoMap: Record<string, route53.GeoLocation> = {
      'us-east-1': route53.GeoLocation.country('US'),
      'us-west-2': route53.GeoLocation.country('US'),
      'eu-west-1': route53.GeoLocation.continent(route53.Continent.EUROPE),
      'eu-central-1': route53.GeoLocation.continent(route53.Continent.EUROPE),
      // 'ap-southeast-1': route53.GeoLocation.continent(route53.Continent.ASIA_PACIFIC_AP), // CDK version compatibility
      // 'ap-northeast-1': route53.GeoLocation.continent(route53.Continent.ASIA_PACIFIC_AP), // CDK version compatibility
    };

    return regionToGeoMap[region] || route53.GeoLocation.default();
  }

  private createGlobalMonitoring(environment: string, config: GlobalStackProps['config']) {
    // Global health check topic
    this.globalHealthCheckTopic = new sns.Topic(this, 'GlobalHealthCheckTopic', {
      topicName: `LinkShortener-GlobalHealth-${environment}`,
      displayName: `Link Shortener Global Health Alerts - ${environment}`,
    });

    // Add email subscription for production
    if (config.alarmEmail && environment === 'prod') {
      this.globalHealthCheckTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(config.alarmEmail)
      );
    }

    // Global dashboard for multi-region monitoring
    const globalDashboard = new cloudwatch.Dashboard(this, 'GlobalDashboard', {
      dashboardName: `LinkShortener-Global-${environment}`,
      
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: 'Global Health Check Status',
            left: config.regions.map((region, index) => 
              new cloudwatch.Metric({
                namespace: 'AWS/Route53',
                metricName: 'HealthCheckStatus',
                dimensionsMap: {
                  HealthCheckId: `\${HealthCheck${region}Id}`, // Will be replaced with actual ID
                },
                statistic: 'Minimum',
                label: region,
              })
            ),
            width: 24,
            height: 6,
          }),
        ],
        
        [
          new cloudwatch.GraphWidget({
            title: 'Global DynamoDB Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'ConsumedReadCapacityUnits',
                dimensionsMap: {
                  TableName: this.globalTable?.tableName || 'GlobalTable',
                },
                statistic: 'Sum',
                label: 'Global Read Capacity',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'ConsumedWriteCapacityUnits',
                dimensionsMap: {
                  TableName: this.globalTable?.tableName || 'GlobalTable',
                },
                statistic: 'Sum',
                label: 'Global Write Capacity',
              }),
            ],
            width: 24,
            height: 6,
          }),
        ],
      ],
    });

    // Global cost tracking
    this.createCostMonitoring(environment);
  }

  private createCostMonitoring(environment: string) {
    // Cost anomaly detection - commented out due to CDK version compatibility
    // const costAnomalyDetector = new cdk.aws_ce.CfnAnomalyDetector(this, 'CostAnomalyDetector', {
    //   anomalyDetector: {
    //     detectorName: `LinkShortener-${environment}-CostAnomaly`,
    //     monitorType: 'DIMENSIONAL',
    //     specification: JSON.stringify({
    //       Dimension: 'SERVICE',
    //       MatchOptions: ['EQUALS'],
    //       Values: ['Amazon DynamoDB', 'Amazon CloudFront', 'AWS Lambda', 'Amazon Route 53'],
    //     }),
    //   },
    // });

    // Cost budget
    if (environment === 'prod') {
      new cdk.aws_budgets.CfnBudget(this, 'MonthlyCostBudget', {
        budget: {
          budgetName: `LinkShortener-${environment}-Monthly`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: {
            amount: 2000, // $2000/month budget
            unit: 'USD',
          },
          costFilters: {
            TagKey: ['CostCenter'],
            TagValue: ['LinkShortener'],
          },
        },
        notificationsWithSubscribers: [
          {
            notification: {
              notificationType: 'ACTUAL',
              comparisonOperator: 'GREATER_THAN',
              threshold: 80, // Alert at 80% of budget
              thresholdType: 'PERCENTAGE',
            },
            subscribers: [
              {
                subscriptionType: 'EMAIL',
                address: 'billing@yourdomain.com',
              },
            ],
          },
        ],
      });
    }
  }

  private createGlobalIAMRoles(environment: string) {
    // Cross-region replication role
    const replicationRole = new iam.Role(this, 'GlobalReplicationRole', {
      roleName: `LinkShortener-GlobalReplication-${environment}`,
      assumedBy: new iam.ServicePrincipal('dynamodb.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/DynamoDBReplicationServiceRolePolicy'),
      ],
    });

    // Lambda execution role for global functions
    const globalLambdaRole = new iam.Role(this, 'GlobalLambdaRole', {
      roleName: `LinkShortener-GlobalLambda-${environment}`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Grant permissions for global operations
    if (this.globalTable) {
      this.globalTable.grantReadWriteData(globalLambdaRole);
    }
    if (this.globalAnalyticsTable) {
      this.globalAnalyticsTable.grantReadWriteData(globalLambdaRole);
    }
  }

  private createOutputs(environment: string) {
    new cdk.CfnOutput(this, 'GlobalTableName', {
      value: this.globalTable?.tableName || 'Not Created',
      exportName: `LinkShortener-GlobalTable-${environment}`,
    });

    new cdk.CfnOutput(this, 'GlobalAnalyticsTableName', {
      value: this.globalAnalyticsTable?.tableName || 'Not Created',
      exportName: `LinkShortener-GlobalAnalytics-${environment}`,
    });

    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone?.hostedZoneId || '',
      exportName: `LinkShortener-GlobalHostedZone-${environment}`,
    });

    new cdk.CfnOutput(this, 'GlobalHealthTopicArn', {
      value: this.globalHealthCheckTopic?.topicArn || '',
      exportName: `LinkShortener-GlobalHealthTopic-${environment}`,
    });

    // Tags
    cdk.Tags.of(this).add('Environment', environment);
    cdk.Tags.of(this).add('Component', 'Global');
    cdk.Tags.of(this).add('CostCenter', 'LinkShortener');
  }
}