import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface MonitoringStackProps extends cdk.StackProps {
  environment: string;
  config: any;
  restApi: apigateway.RestApi;
  createHandler: lambda.Function;
  redirectHandler: lambda.Function;
  analyticsHandler: lambda.Function;
  authHandler?: lambda.Function;
  bulkHandler?: lambda.Function;
  linksTable: dynamodb.Table;
  analyticsTable: dynamodb.Table;
  rateLimitTable?: dynamodb.Table;
  distribution?: cloudfront.Distribution;
  webAcl?: wafv2.CfnWebACL;
}

export class MonitoringStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    const {
      environment,
      config,
      restApi,
      createHandler,
      redirectHandler,
      analyticsHandler,
      linksTable,
      analyticsTable,
      distribution,
    } = props;

    // Create SNS topic for alarms
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `LinkShortener-Alarms-${environment}`,
      displayName: `Link Shortener Alarms - ${environment}`,
    });

    // Add email subscription for production
    if (environment === 'prod' && config.alarmEmail) {
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(config.alarmEmail)
      );
    }

    // Create CloudWatch Dashboard
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `LinkShortener-${environment}`,
      
      widgets: [
        // API Gateway Metrics Row
        [
          new cloudwatch.GraphWidget({
            title: 'API Gateway - Request Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: 'Count',
                dimensionsMap: {
                  ApiName: restApi.restApiName,
                  Stage: environment,
                },
                statistic: 'Sum',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: '4XXError',
                dimensionsMap: {
                  ApiName: restApi.restApiName,
                  Stage: environment,
                },
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: '5XXError',
                dimensionsMap: {
                  ApiName: restApi.restApiName,
                  Stage: environment,
                },
                statistic: 'Sum',
              }),
            ],
          }),
          
          new cloudwatch.GraphWidget({
            title: 'API Gateway - Response Times',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: 'Latency',
                dimensionsMap: {
                  ApiName: restApi.restApiName,
                  Stage: environment,
                },
                statistic: 'Average',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/ApiGateway',
                metricName: 'IntegrationLatency',
                dimensionsMap: {
                  ApiName: restApi.restApiName,
                  Stage: environment,
                },
                statistic: 'Average',
              }),
            ],
          }),
        ],

        // Lambda Functions Metrics Row
        [
          new cloudwatch.GraphWidget({
            title: 'Lambda - Function Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Invocations',
                dimensionsMap: {
                  FunctionName: createHandler.functionName,
                },
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Invocations',
                dimensionsMap: {
                  FunctionName: redirectHandler.functionName,
                },
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Invocations',
                dimensionsMap: {
                  FunctionName: analyticsHandler.functionName,
                },
                statistic: 'Sum',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Errors',
                dimensionsMap: {
                  FunctionName: createHandler.functionName,
                },
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Errors',
                dimensionsMap: {
                  FunctionName: redirectHandler.functionName,
                },
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Errors',
                dimensionsMap: {
                  FunctionName: analyticsHandler.functionName,
                },
                statistic: 'Sum',
              }),
            ],
          }),

          new cloudwatch.GraphWidget({
            title: 'Lambda - Performance Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'Duration',
                dimensionsMap: {
                  FunctionName: redirectHandler.functionName,
                },
                statistic: 'Average',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/Lambda',
                metricName: 'ConcurrentExecutions',
                dimensionsMap: {
                  FunctionName: redirectHandler.functionName,
                },
                statistic: 'Maximum',
              }),
            ],
          }),
        ],

        // DynamoDB Metrics Row
        [
          new cloudwatch.GraphWidget({
            title: 'DynamoDB - Read/Write Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'ConsumedReadCapacityUnits',
                dimensionsMap: {
                  TableName: linksTable.tableName,
                },
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'ConsumedWriteCapacityUnits',
                dimensionsMap: {
                  TableName: linksTable.tableName,
                },
                statistic: 'Sum',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'ThrottledRequests',
                dimensionsMap: {
                  TableName: linksTable.tableName,
                },
                statistic: 'Sum',
              }),
            ],
          }),

          new cloudwatch.GraphWidget({
            title: 'DynamoDB - Response Times',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'SuccessfulRequestLatency',
                dimensionsMap: {
                  TableName: linksTable.tableName,
                  Operation: 'GetItem',
                },
                statistic: 'Average',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/DynamoDB',
                metricName: 'SuccessfulRequestLatency',
                dimensionsMap: {
                  TableName: linksTable.tableName,
                  Operation: 'PutItem',
                },
                statistic: 'Average',
              }),
            ],
          }),
        ],

        // CloudFront Metrics Row (if distribution exists)
        ...(distribution ? [[
          new cloudwatch.GraphWidget({
            title: 'CloudFront - Request Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'Requests',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
                statistic: 'Sum',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: '4xxErrorRate',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
                statistic: 'Average',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: '5xxErrorRate',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
                statistic: 'Average',
              }),
            ],
          }),

          new cloudwatch.GraphWidget({
            title: 'CloudFront - Cache Performance',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'CacheHitRate',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
                statistic: 'Average',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'AWS/CloudFront',
                metricName: 'OriginLatency',
                dimensionsMap: {
                  DistributionId: distribution.distributionId,
                },
                statistic: 'Average',
              }),
            ],
          }),
        ]] : []),

        // Custom Business Metrics Row
        [
          new cloudwatch.GraphWidget({
            title: 'Business Metrics - Link Creation',
            left: [
              new cloudwatch.Metric({
                namespace: 'LinkShortener',
                metricName: 'LinksCreated',
                statistic: 'Sum',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'LinkShortener',
                metricName: 'CustomCodesUsed',
                statistic: 'Sum',
              }),
            ],
          }),

          new cloudwatch.GraphWidget({
            title: 'Business Metrics - Redirects',
            left: [
              new cloudwatch.Metric({
                namespace: 'LinkShortener',
                metricName: 'RedirectsProcessed',
                statistic: 'Sum',
              }),
            ],
            right: [
              new cloudwatch.Metric({
                namespace: 'LinkShortener',
                metricName: 'NotFoundRequests',
                statistic: 'Sum',
              }),
            ],
          }),
        ],

        // Security Metrics Row (if WAF is enabled)
        ...(props.webAcl ? [[
          new cloudwatch.GraphWidget({
            title: 'WAF - Security Metrics',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/WAFV2',
                metricName: 'BlockedRequests',
                dimensionsMap: {
                  WebACL: props.webAcl.name!,
                  Region: this.region,
                },
                statistic: 'Sum',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/WAFV2',
                metricName: 'AllowedRequests',
                dimensionsMap: {
                  WebACL: props.webAcl.name!,
                  Region: this.region,
                },
                statistic: 'Sum',
              }),
            ],
          }),

          new cloudwatch.GraphWidget({
            title: 'WAF - Rule-Specific Blocks',
            left: [
              new cloudwatch.Metric({
                namespace: 'AWS/WAFV2',
                metricName: 'BlockedRequests',
                dimensionsMap: {
                  WebACL: props.webAcl.name!,
                  Region: this.region,
                  Rule: 'RateLimitRule',
                },
                statistic: 'Sum',
                label: 'Rate Limited',
              }),
              new cloudwatch.Metric({
                namespace: 'AWS/WAFV2',
                metricName: 'BlockedRequests',
                dimensionsMap: {
                  WebACL: props.webAcl.name!,
                  Region: this.region,
                  Rule: 'AWSManagedRulesCommonRuleSet',
                },
                statistic: 'Sum',
                label: 'Common Rules',
              }),
            ],
          }),
        ]] : []),
      ],
    });

    // Create Alarms

    // API Gateway Error Rate Alarm
    const apiErrorAlarm = new cloudwatch.Alarm(this, 'ApiErrorRateAlarm', {
      alarmName: `LinkShortener-ApiErrorRate-${environment}`,
      alarmDescription: 'API Gateway error rate is too high',
      
      metric: new cloudwatch.MathExpression({
        expression: '(m1 + m2) / m3 * 100',
        usingMetrics: {
          m1: new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4XXError',
            dimensionsMap: {
              ApiName: restApi.restApiName,
              Stage: environment,
            },
            statistic: 'Sum',
          }),
          m2: new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensionsMap: {
              ApiName: restApi.restApiName,
              Stage: environment,
            },
            statistic: 'Sum',
          }),
          m3: new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Count',
            dimensionsMap: {
              ApiName: restApi.restApiName,
              Stage: environment,
            },
            statistic: 'Sum',
          }),
        },
      }),
      
      threshold: 5, // 5% error rate
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    apiErrorAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmTopic)
    );

    // Lambda Error Rate Alarm (Redirect Handler)
    const redirectErrorAlarm = new cloudwatch.Alarm(this, 'RedirectErrorAlarm', {
      alarmName: `LinkShortener-RedirectErrors-${environment}`,
      alarmDescription: 'Redirect handler error rate is too high',
      
      metric: new cloudwatch.MathExpression({
        expression: 'm1 / m2 * 100',
        usingMetrics: {
          m1: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Errors',
            dimensionsMap: {
              FunctionName: redirectHandler.functionName,
            },
            statistic: 'Sum',
          }),
          m2: new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Invocations',
            dimensionsMap: {
              FunctionName: redirectHandler.functionName,
            },
            statistic: 'Sum',
          }),
        },
      }),
      
      threshold: 1, // 1% error rate
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    redirectErrorAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmTopic)
    );

    // DynamoDB Throttling Alarm
    const dynamoThrottleAlarm = new cloudwatch.Alarm(this, 'DynamoThrottleAlarm', {
      alarmName: `LinkShortener-DynamoThrottle-${environment}`,
      alarmDescription: 'DynamoDB is being throttled',
      
      metric: new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ThrottledRequests',
        dimensionsMap: {
          TableName: linksTable.tableName,
        },
        statistic: 'Sum',
      }),
      
      threshold: 1,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });

    dynamoThrottleAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmTopic)
    );

    // Response Time Alarm
    const responseTimeAlarm = new cloudwatch.Alarm(this, 'ResponseTimeAlarm', {
      alarmName: `LinkShortener-ResponseTime-${environment}`,
      alarmDescription: 'API response time is too high',
      
      metric: new cloudwatch.Metric({
        namespace: 'AWS/ApiGateway',
        metricName: 'Latency',
        dimensionsMap: {
          ApiName: restApi.restApiName,
          Stage: environment,
        },
        statistic: 'Average',
      }),
      
      threshold: 1000, // 1 second
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    responseTimeAlarm.addAlarmAction(
      new cloudwatchActions.SnsAction(this.alarmTopic)
    );

    // WAF Security Alarms (if WAF is enabled)
    if (props.webAcl) {
      // High blocked requests alarm (potential attack)
      const wafBlockedRequestsAlarm = new cloudwatch.Alarm(this, 'WafBlockedRequestsAlarm', {
        alarmName: `LinkShortener-WAF-HighBlocked-${environment}`,
        alarmDescription: 'Unusually high number of blocked requests (potential attack)',
        
        metric: new cloudwatch.Metric({
          namespace: 'AWS/WAFV2',
          metricName: 'BlockedRequests',
          dimensionsMap: {
            WebACL: props.webAcl.name!,
            Region: this.region,
          },
          statistic: 'Sum',
        }),
        
        threshold: 1000, // 1000 blocked requests in 5 minutes
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      wafBlockedRequestsAlarm.addAlarmAction(
        new cloudwatchActions.SnsAction(this.alarmTopic)
      );

      // Rate limiting alarm
      const wafRateLimitAlarm = new cloudwatch.Alarm(this, 'WafRateLimitAlarm', {
        alarmName: `LinkShortener-WAF-RateLimit-${environment}`,
        alarmDescription: 'Rate limiting is being triggered frequently',
        
        metric: new cloudwatch.Metric({
          namespace: 'AWS/WAFV2',
          metricName: 'BlockedRequests',
          dimensionsMap: {
            WebACL: props.webAcl.name!,
            Region: this.region,
            Rule: 'RateLimitRule',
          },
          statistic: 'Sum',
        }),
        
        threshold: 100, // 100 rate-limited requests in 15 minutes
        evaluationPeriods: 1,
        datapointsToAlarm: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      wafRateLimitAlarm.addAlarmAction(
        new cloudwatchActions.SnsAction(this.alarmTopic)
      );
    }

    // Authentication errors alarm (if auth handler exists)
    if (props.authHandler) {
      const authErrorAlarm = new cloudwatch.Alarm(this, 'AuthErrorAlarm', {
        alarmName: `LinkShortener-AuthErrors-${environment}`,
        alarmDescription: 'High authentication error rate',
        
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Lambda',
          metricName: 'Errors',
          dimensionsMap: {
            FunctionName: props.authHandler.functionName,
          },
          statistic: 'Sum',
        }),
        
        threshold: 50, // 50 auth errors in 5 minutes
        evaluationPeriods: 2,
        datapointsToAlarm: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      });

      authErrorAlarm.addAlarmAction(
        new cloudwatchActions.SnsAction(this.alarmTopic)
      );
    }

    // Create log insights queries
    const logGroup = logs.LogGroup.fromLogGroupName(
      this, 
      'ApiLogGroup', 
      `/aws/apigateway/LinkShortener-${environment}`
    );

    // Outputs
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.dashboard.dashboardName}`,
      exportName: `LinkShortener-DashboardUrl-${environment}`,
      description: 'CloudWatch Dashboard URL',
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      exportName: `LinkShortener-AlarmTopicArn-${environment}`,
      description: 'SNS topic ARN for alarms',
    });

    // Tags
    cdk.Tags.of(this.dashboard).add('Component', 'Monitoring');
    cdk.Tags.of(this.alarmTopic).add('Component', 'Monitoring');
    cdk.Tags.of(this.dashboard).add('CostCenter', 'LinkShortener');
    cdk.Tags.of(this.alarmTopic).add('CostCenter', 'LinkShortener');
  }
}

// Import required modules
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';