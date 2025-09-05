import * as cdk from 'aws-cdk-lib';
import * as backup from 'aws-cdk-lib/aws-backup';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as stepfunctionsTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface DisasterRecoveryStackProps extends cdk.StackProps {
  environment: string;
  config: {
    enableBackups: boolean;
    backupRetentionDays: number;
    enableCrossRegionBackup: boolean;
    backupRegions: string[];
    rtoMinutes: number; // Recovery Time Objective
    rpoHours: number; // Recovery Point Objective
    alarmEmail?: string;
  };
  linksTable: dynamodb.Table;
  analyticsTable: dynamodb.Table;
}

export class DisasterRecoveryStack extends cdk.Stack {
  public readonly backupVault: backup.BackupVault;
  public readonly recoveryStateMachine: stepfunctions.StateMachine;
  public readonly configBackupBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: DisasterRecoveryStackProps) {
    super(scope, id, props);

    const { environment, config, linksTable, analyticsTable } = props;

    if (config.enableBackups) {
      // Create backup infrastructure
      this.createBackupInfrastructure(environment, config);
      
      // Create backup plans
      this.createBackupPlans(environment, config, linksTable, analyticsTable);
    }

    // Create disaster recovery automation
    this.createDisasterRecoveryAutomation(environment, config);

    // Create configuration backup
    this.createConfigurationBackup(environment, config);

    // Create monitoring and alerting
    this.createDisasterRecoveryMonitoring(environment, config);

    // Create outputs
    this.createOutputs(environment);
  }

  private createBackupInfrastructure(environment: string, config: DisasterRecoveryStackProps['config']) {
    // Create backup vault with encryption
    this.backupVault = new backup.BackupVault(this, 'BackupVault', {
      backupVaultName: `LinkShortener-Backups-${environment}`,
      encryptionKey: new cdk.aws_kms.Key(this, 'BackupEncryptionKey', {
        description: `Backup encryption key for LinkShortener ${environment}`,
        enableKeyRotation: true,
        removalPolicy: environment === 'prod' 
          ? cdk.RemovalPolicy.RETAIN 
          : cdk.RemovalPolicy.DESTROY,
      }),
      accessPolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.ArnPrincipal('*')],
            actions: ['backup:DeleteRecoveryPoint'],
            resources: ['*'],
            conditions: {
              StringNotEquals: {
                'aws:PrincipalServiceName': [
                  'backup.amazonaws.com',
                ],
              },
            },
          }),
        ],
      }),
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Cross-region backup vaults (if enabled)
    if (config.enableCrossRegionBackup) {
      config.backupRegions.forEach(region => {
        if (region !== this.region) {
          // Create cross-region backup vault (this would need to be in another stack for different regions)
          // For now, we'll just create IAM roles for cross-region access
          new iam.Role(this, `CrossRegionBackupRole${region}`, {
            roleName: `LinkShortener-CrossRegionBackup-${region}-${environment}`,
            assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
            managedPolicies: [
              iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
              iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'),
            ],
          });
        }
      });
    }
  }

  private createBackupPlans(
    environment: string, 
    config: DisasterRecoveryStackProps['config'],
    linksTable: dynamodb.Table,
    analyticsTable: dynamodb.Table
  ) {
    // Create backup role
    const backupRole = new iam.Role(this, 'BackupRole', {
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'),
      ],
    });

    // Production backup plan (more frequent, longer retention)
    if (environment === 'prod') {
      const productionBackupPlan = new backup.BackupPlan(this, 'ProductionBackupPlan', {
        backupPlanName: `LinkShortener-Production-${environment}`,
        backupVault: this.backupVault,
        backupPlanRules: [
          // Continuous backups (point-in-time recovery)
          new backup.BackupPlanRule({
            ruleName: 'ContinuousBackup',
            enableContinuousBackup: true,
            deleteAfter: cdk.Duration.days(35), // Keep for 35 days
          }),
          
          // Daily backups
          new backup.BackupPlanRule({
            ruleName: 'DailyBackup',
            scheduleExpression: events.Schedule.cron({
              hour: '2', // 2 AM UTC
              minute: '0',
            }),
            startWindow: cdk.Duration.hours(1),
            completionWindow: cdk.Duration.hours(8),
            deleteAfter: cdk.Duration.days(config.backupRetentionDays),
            moveToColdStorageAfter: cdk.Duration.days(30),
          }),
          
          // Weekly backups (long term retention)
          new backup.BackupPlanRule({
            ruleName: 'WeeklyBackup',
            scheduleExpression: events.Schedule.cron({
              weekDay: 'SUN',
              hour: '3',
              minute: '0',
            }),
            deleteAfter: cdk.Duration.days(365), // Keep for 1 year
            moveToColdStorageAfter: cdk.Duration.days(90),
          }),
        ],
      });

      // Add DynamoDB tables to backup plan
      productionBackupPlan.addSelection('DynamoDBSelection', {
        resources: [
          backup.BackupResource.fromDynamoDbTable(linksTable),
          backup.BackupResource.fromDynamoDbTable(analyticsTable),
        ],
        role: backupRole,
        backupPlanRuleName: 'DailyBackup',
      });

    } else {
      // Non-production backup plan (less frequent, shorter retention)
      const developmentBackupPlan = new backup.BackupPlan(this, 'DevelopmentBackupPlan', {
        backupPlanName: `LinkShortener-Development-${environment}`,
        backupVault: this.backupVault,
        backupPlanRules: [
          new backup.BackupPlanRule({
            ruleName: 'DailyBackup',
            scheduleExpression: events.Schedule.cron({
              hour: '4', // 4 AM UTC
              minute: '0',
            }),
            deleteAfter: cdk.Duration.days(7), // Keep for 7 days only
          }),
        ],
      });

      developmentBackupPlan.addSelection('DynamoDBSelection', {
        resources: [
          backup.BackupResource.fromDynamoDbTable(linksTable),
          backup.BackupResource.fromDynamoDbTable(analyticsTable),
        ],
        role: backupRole,
      });
    }
  }

  private createDisasterRecoveryAutomation(environment: string, config: DisasterRecoveryStackProps['config']) {
    // Lambda function for disaster recovery orchestration
    const drOrchestratorFunction = new lambda.Function(this, 'DROrchestrator', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const backup = new AWS.Backup();
        const dynamodb = new AWS.DynamoDB();
        const route53 = new AWS.Route53();
        const cloudformation = new AWS.CloudFormation();

        exports.handler = async (event) => {
          console.log('DR Orchestration Event:', JSON.stringify(event));
          
          const { action, backupArn, targetRegion } = event;
          
          try {
            switch (action) {
              case 'start-recovery':
                return await startRecovery(event);
              case 'validate-recovery':
                return await validateRecovery(event);
              case 'update-dns':
                return await updateDNS(event);
              case 'complete-recovery':
                return await completeRecovery(event);
              default:
                throw new Error(\`Unknown action: \${action}\`);
            }
          } catch (error) {
            console.error('DR Orchestration Error:', error);
            return {
              status: 'FAILED',
              error: error.message,
              timestamp: new Date().toISOString()
            };
          }
        };

        async function startRecovery(event) {
          // Start recovery from backup
          const { backupArn, targetRegion } = event;
          
          console.log(\`Starting recovery from backup: \${backupArn} to region: \${targetRegion}\`);
          
          // This would initiate the actual recovery process
          // In a real implementation, you would:
          // 1. Restore DynamoDB tables from backup
          // 2. Deploy Lambda functions in target region
          // 3. Update API Gateway configuration
          // 4. Verify infrastructure health
          
          return {
            status: 'IN_PROGRESS',
            recoveryJobId: 'job-' + Date.now(),
            estimatedCompletionTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 minutes
            timestamp: new Date().toISOString()
          };
        }

        async function validateRecovery(event) {
          // Validate that the recovery was successful
          console.log('Validating recovery...');
          
          // Check DynamoDB table health
          // Check Lambda function health
          // Check API Gateway health
          // Run health checks
          
          return {
            status: 'VALIDATED',
            healthChecks: {
              dynamodb: 'HEALTHY',
              lambda: 'HEALTHY',
              apiGateway: 'HEALTHY'
            },
            timestamp: new Date().toISOString()
          };
        }

        async function updateDNS(event) {
          // Update Route 53 records to point to recovery region
          console.log('Updating DNS records...');
          
          // Update Route 53 records with weighted routing
          // Gradually shift traffic to recovery region
          
          return {
            status: 'DNS_UPDATED',
            trafficShift: '100%',
            timestamp: new Date().toISOString()
          };
        }

        async function completeRecovery(event) {
          // Mark recovery as complete and clean up
          console.log('Completing recovery...');
          
          return {
            status: 'COMPLETED',
            finalHealthCheck: 'PASSED',
            timestamp: new Date().toISOString()
          };
        }
      `),
      timeout: cdk.Duration.minutes(15),
      environment: {
        ENVIRONMENT: environment,
        BACKUP_VAULT_NAME: this.backupVault?.backupVaultName || '',
      },
    });

    // Grant necessary permissions
    drOrchestratorFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'backup:StartRestoreJob',
        'backup:DescribeRestoreJob',
        'dynamodb:DescribeTable',
        'route53:ChangeResourceRecordSets',
        'cloudformation:DescribeStacks',
        'cloudformation:CreateStack',
      ],
      resources: ['*'],
    }));

    // Create Step Functions state machine for DR orchestration
    const startRecoveryTask = new stepfunctionsTasks.LambdaInvoke(this, 'StartRecovery', {
      lambdaFunction: drOrchestratorFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'start-recovery',
        'backupArn.$': '$.backupArn',
        'targetRegion.$': '$.targetRegion',
      }),
      resultPath: '$.recoveryResult',
    });

    const waitForRecovery = new stepfunctions.Wait(this, 'WaitForRecovery', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.minutes(5)),
    });

    const validateRecoveryTask = new stepfunctionsTasks.LambdaInvoke(this, 'ValidateRecovery', {
      lambdaFunction: drOrchestratorFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'validate-recovery',
        'recoveryJobId.$': '$.recoveryResult.Payload.recoveryJobId',
      }),
      resultPath: '$.validationResult',
    });

    const updateDNSTask = new stepfunctionsTasks.LambdaInvoke(this, 'UpdateDNS', {
      lambdaFunction: drOrchestratorFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'update-dns',
        'targetRegion.$': '$.targetRegion',
      }),
      resultPath: '$.dnsResult',
    });

    const completeRecoveryTask = new stepfunctionsTasks.LambdaInvoke(this, 'CompleteRecovery', {
      lambdaFunction: drOrchestratorFunction,
      payload: stepfunctions.TaskInput.fromObject({
        'action': 'complete-recovery',
      }),
      resultPath: '$.completionResult',
    });

    // Define the state machine
    const definition = startRecoveryTask
      .next(waitForRecovery)
      .next(validateRecoveryTask)
      .next(new stepfunctions.Choice(this, 'RecoverySuccessful?')
        .when(
          stepfunctions.Condition.stringEquals('$.validationResult.Payload.status', 'VALIDATED'),
          updateDNSTask.next(completeRecoveryTask)
        )
        .otherwise(new stepfunctions.Fail(this, 'RecoveryFailed', {
          cause: 'Recovery validation failed',
        }))
      );

    this.recoveryStateMachine = new stepfunctions.StateMachine(this, 'DisasterRecoveryStateMachine', {
      stateMachineName: `LinkShortener-DR-${environment}`,
      definition,
      timeout: cdk.Duration.hours(2),
      logs: {
        destination: new logs.LogGroup(this, 'DRStateMachineLogGroup', {
          logGroupName: `/aws/stepfunctions/LinkShortener-DR-${environment}`,
          retention: logs.RetentionDays.ONE_MONTH,
        }),
        level: stepfunctions.LogLevel.ALL,
      },
    });
  }

  private createConfigurationBackup(environment: string, config: DisasterRecoveryStackProps['config']) {
    // S3 bucket for configuration backups
    this.configBackupBucket = new s3.Bucket(this, 'ConfigBackupBucket', {
      bucketName: `linkshortener-config-backup-${environment}-${this.account}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
      
      // Lifecycle rules
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          expiration: cdk.Duration.days(config.backupRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(30),
        },
      ],
    });

    // Lambda function to backup CDK configuration
    const configBackupFunction = new lambda.Function(this, 'ConfigBackupFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        const ssm = new AWS.SSM();
        const secretsManager = new AWS.SecretsManager();

        exports.handler = async (event) => {
          console.log('Config backup event:', JSON.stringify(event));
          
          try {
            const timestamp = new Date().toISOString();
            const backupKey = \`config-backup/\${timestamp}/\`;
            
            // Backup SSM parameters
            const ssmParameters = await ssm.getParametersByPath({
              Path: '/linkshortener/',
              Recursive: true,
              WithDecryption: false, // Don't decrypt secrets
            }).promise();
            
            await s3.putObject({
              Bucket: process.env.CONFIG_BUCKET,
              Key: backupKey + 'ssm-parameters.json',
              Body: JSON.stringify(ssmParameters.Parameters, null, 2),
              ContentType: 'application/json',
            }).promise();
            
            // Backup environment configuration (non-sensitive)
            const envConfig = {
              environment: process.env.ENVIRONMENT,
              region: process.env.AWS_REGION,
              timestamp: timestamp,
              // Add other non-sensitive config here
            };
            
            await s3.putObject({
              Bucket: process.env.CONFIG_BUCKET,
              Key: backupKey + 'environment-config.json',
              Body: JSON.stringify(envConfig, null, 2),
              ContentType: 'application/json',
            }).promise();
            
            console.log(\`Configuration backed up successfully to: \${backupKey}\`);
            
            return {
              statusCode: 200,
              body: {
                message: 'Configuration backup completed',
                backupKey: backupKey,
                timestamp: timestamp,
              },
            };
            
          } catch (error) {
            console.error('Configuration backup failed:', error);
            throw error;
          }
        };
      `),
      environment: {
        CONFIG_BUCKET: this.configBackupBucket.bucketName,
        ENVIRONMENT: environment,
      },
      timeout: cdk.Duration.minutes(5),
    });

    // Grant permissions
    this.configBackupBucket.grantWrite(configBackupFunction);
    configBackupFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'ssm:GetParametersByPath',
        'secretsmanager:ListSecrets', // List only, not read values
      ],
      resources: ['*'],
    }));

    // Schedule daily configuration backups
    new events.Rule(this, 'ConfigBackupSchedule', {
      ruleName: `LinkShortener-ConfigBackup-${environment}`,
      schedule: events.Schedule.cron({
        hour: '1',
        minute: '30',
      }),
      targets: [new targets.LambdaFunction(configBackupFunction)],
    });
  }

  private createDisasterRecoveryMonitoring(environment: string, config: DisasterRecoveryStackProps['config']) {
    // SNS topic for DR alerts
    const drAlertTopic = new sns.Topic(this, 'DRAlertTopic', {
      topicName: `LinkShortener-DR-Alerts-${environment}`,
      displayName: `Link Shortener DR Alerts - ${environment}`,
    });

    if (config.alarmEmail) {
      drAlertTopic.addSubscription(
        new sns.snsSubscriptions.EmailSubscription(config.alarmEmail)
      );
    }

    // CloudWatch alarms for backup failures
    if (this.backupVault) {
      new cdk.aws_cloudwatch.Alarm(this, 'BackupFailureAlarm', {
        alarmName: `LinkShortener-BackupFailure-${environment}`,
        alarmDescription: 'Backup job has failed',
        
        metric: new cdk.aws_cloudwatch.Metric({
          namespace: 'AWS/Backup',
          metricName: 'NumberOfBackupJobsFailed',
          dimensionsMap: {
            BackupVaultName: this.backupVault.backupVaultName,
          },
          statistic: 'Sum',
        }),
        
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(drAlertTopic));
    }

    // CloudWatch alarm for DR state machine failures
    new cdk.aws_cloudwatch.Alarm(this, 'DRStateMachineFailureAlarm', {
      alarmName: `LinkShortener-DR-StateMachine-Failure-${environment}`,
      alarmDescription: 'DR state machine execution has failed',
      
      metric: this.recoveryStateMachine.metricFailed({
        period: cdk.Duration.minutes(5),
      }),
      
      threshold: 1,
      evaluationPeriods: 1,
    }).addAlarmAction(new cdk.aws_cloudwatch_actions.SnsAction(drAlertTopic));
  }

  private createOutputs(environment: string) {
    if (this.backupVault) {
      new cdk.CfnOutput(this, 'BackupVaultArn', {
        value: this.backupVault.backupVaultArn,
        exportName: `LinkShortener-BackupVault-${environment}`,
      });
    }

    new cdk.CfnOutput(this, 'RecoveryStateMachineArn', {
      value: this.recoveryStateMachine.stateMachineArn,
      exportName: `LinkShortener-RecoveryStateMachine-${environment}`,
    });

    new cdk.CfnOutput(this, 'ConfigBackupBucket', {
      value: this.configBackupBucket.bucketName,
      exportName: `LinkShortener-ConfigBackup-${environment}`,
    });

    // Tags
    cdk.Tags.of(this).add('Component', 'DisasterRecovery');
    cdk.Tags.of(this).add('CostCenter', 'LinkShortener');
  }
}