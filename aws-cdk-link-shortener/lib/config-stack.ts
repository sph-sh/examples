import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface EnvironmentConfig {
  environment: string;
  region: string;
  domainName?: string;
  enableWaf: boolean;
  enableCustomDomain: boolean;
  enableMultiRegion: boolean;
  
  // Lambda configuration
  lambda: {
    memorySize: number;
    timeout: number;
    reservedConcurrency?: number;
    provisionedConcurrency?: number;
  };
  
  // DynamoDB configuration
  dynamodb: {
    billingMode: 'PAY_PER_REQUEST' | 'PROVISIONED';
    readCapacity?: number;
    writeCapacity?: number;
    pointInTimeRecovery: boolean;
    enableStreams: boolean;
    globalTables: boolean;
  };
  
  // Monitoring configuration
  monitoring: {
    enableDetailedMetrics: boolean;
    logRetentionDays: number;
    alarmEmail?: string;
    slackWebhook?: string;
  };
  
  // Cost optimization
  costOptimization: {
    cloudfrontPriceClass: string;
    enableCaching: boolean;
    cacheDefaultTtl: number;
    enableCompression: boolean;
  };
}

interface ConfigStackProps extends cdk.StackProps {
  environment: string;
}

export class ConfigStack extends cdk.Stack {
  public readonly config: EnvironmentConfig;

  constructor(scope: Construct, id: string, props: ConfigStackProps) {
    super(scope, id, props);

    const { environment } = props;

    // Define environment-specific configurations
    this.config = this.getEnvironmentConfig(environment);

    // Store configuration in SSM Parameter Store
    this.createSSMParameters();

    // Create secrets in Secrets Manager
    this.createSecrets();

    // Output configuration values
    this.createOutputs();
  }

  private getEnvironmentConfig(environment: string): EnvironmentConfig {
    const baseConfig = {
      environment,
      region: this.region,
      
      lambda: {
        memorySize: 512,
        timeout: 30,
      },
      
      dynamodb: {
        billingMode: 'PAY_PER_REQUEST' as const,
        pointInTimeRecovery: true,
        enableStreams: true,
        globalTables: false,
      },
      
      monitoring: {
        enableDetailedMetrics: true,
        logRetentionDays: 7,
      },
      
      costOptimization: {
        cloudfrontPriceClass: 'PriceClass_100', // US, Europe only
        enableCaching: true,
        cacheDefaultTtl: 300, // 5 minutes
        enableCompression: true,
      },
    };

    switch (environment) {
      case 'dev':
        return {
          ...baseConfig,
          enableWaf: false,
          enableCustomDomain: false,
          enableMultiRegion: false,
          
          lambda: {
            ...baseConfig.lambda,
            memorySize: 256, // Lower memory for cost
            reservedConcurrency: 10, // Limit concurrent executions
          },
          
          monitoring: {
            ...baseConfig.monitoring,
            enableDetailedMetrics: false,
            logRetentionDays: 3,
          },
          
          costOptimization: {
            ...baseConfig.costOptimization,
            enableCaching: false, // Disable for easier debugging
          },
        };

      case 'staging':
        return {
          ...baseConfig,
          enableWaf: true,
          enableCustomDomain: false,
          enableMultiRegion: false,
          
          lambda: {
            ...baseConfig.lambda,
            memorySize: 512,
            reservedConcurrency: 50,
          },
          
          monitoring: {
            ...baseConfig.monitoring,
            logRetentionDays: 7,
          },
        };

      case 'pre-prod':
        return {
          ...baseConfig,
          enableWaf: true,
          enableCustomDomain: true,
          enableMultiRegion: false,
          domainName: 'preprod.yourdomain.com',
          
          lambda: {
            ...baseConfig.lambda,
            memorySize: 1024,
            reservedConcurrency: 100,
            provisionedConcurrency: 10, // Warm lambdas for testing
          },
          
          dynamodb: {
            ...baseConfig.dynamodb,
            billingMode: 'PROVISIONED',
            readCapacity: 25,
            writeCapacity: 25,
          },
          
          monitoring: {
            ...baseConfig.monitoring,
            logRetentionDays: 14,
            alarmEmail: 'alerts+preprod@yourdomain.com',
          },
        };

      case 'prod':
        return {
          ...baseConfig,
          enableWaf: true,
          enableCustomDomain: true,
          enableMultiRegion: true,
          domainName: 'yourdomain.com',
          
          lambda: {
            ...baseConfig.lambda,
            memorySize: 1024, // Optimal for performance
            timeout: 10, // Shorter timeout for redirects
            reservedConcurrency: 1000,
            provisionedConcurrency: 50, // Always warm
          },
          
          dynamodb: {
            ...baseConfig.dynamodb,
            billingMode: 'PROVISIONED',
            readCapacity: 100, // Conservative start
            writeCapacity: 50,
            globalTables: true, // Multi-region
          },
          
          monitoring: {
            ...baseConfig.monitoring,
            enableDetailedMetrics: true,
            logRetentionDays: 30,
            alarmEmail: 'alerts@yourdomain.com',
          },
          
          costOptimization: {
            ...baseConfig.costOptimization,
            cloudfrontPriceClass: 'PriceClass_All', // Global distribution
            cacheDefaultTtl: 3600, // 1 hour for production
          },
        };

      default:
        throw new Error(`Unknown environment: ${environment}`);
    }
  }

  private createSSMParameters() {
    const config = this.config;

    // Store non-sensitive configuration in SSM
    new ssm.StringParameter(this, 'EnvironmentConfig', {
      parameterName: `/linkshortener/${config.environment}/config`,
      stringValue: JSON.stringify({
        environment: config.environment,
        region: config.region,
        enableWaf: config.enableWaf,
        enableCustomDomain: config.enableCustomDomain,
        enableMultiRegion: config.enableMultiRegion,
        lambda: config.lambda,
        dynamodb: config.dynamodb,
        costOptimization: config.costOptimization,
      }),
      description: `Configuration for LinkShortener ${config.environment} environment`,
      tier: ssm.ParameterTier.STANDARD,
    });

    // Individual parameters for easier access
    new ssm.StringParameter(this, 'Environment', {
      parameterName: `/linkshortener/${config.environment}/environment`,
      stringValue: config.environment,
    });

    new ssm.StringParameter(this, 'LambdaMemorySize', {
      parameterName: `/linkshortener/${config.environment}/lambda/memorySize`,
      stringValue: config.lambda.memorySize.toString(),
    });

    if (config.domainName) {
      new ssm.StringParameter(this, 'DomainName', {
        parameterName: `/linkshortener/${config.environment}/domain`,
        stringValue: config.domainName,
      });
    }
  }

  private createSecrets() {
    const config = this.config;

    // JWT Secret for authentication
    new secretsmanager.Secret(this, 'JwtSecret', {
      secretName: `linkshortener/${config.environment}/jwt-secret`,
      description: 'JWT signing secret for authentication',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ algorithm: 'HS256' }),
        generateStringKey: 'secret',
        excludeCharacters: '"\\/@',
        requireEachIncludedType: true,
        includeSpace: false,
        passwordLength: 64,
      },
    });

    // Rate limiting salt
    new secretsmanager.Secret(this, 'RateLimitSalt', {
      secretName: `linkshortener/${config.environment}/rate-limit-salt`,
      description: 'Salt for hashing IP addresses in rate limiting',
      generateSecretString: {
        excludeCharacters: '"\\/@',
        passwordLength: 32,
      },
    });

    // Database encryption key (for future use)
    new secretsmanager.Secret(this, 'DatabaseEncryptionKey', {
      secretName: `linkshortener/${config.environment}/db-encryption-key`,
      description: 'Encryption key for sensitive database fields',
      generateSecretString: {
        excludeCharacters: '"\\/@',
        passwordLength: 32,
      },
    });

    // API keys for external services
    if (config.environment === 'prod') {
      new secretsmanager.Secret(this, 'ExternalApiKeys', {
        secretName: `linkshortener/${config.environment}/external-api-keys`,
        description: 'API keys for external services',
        secretObjectValue: {
          threatIntelligence: cdk.SecretValue.unsafePlainText('placeholder'),
          geoLocation: cdk.SecretValue.unsafePlainText('placeholder'),
          analytics: cdk.SecretValue.unsafePlainText('placeholder'),
        },
      });
    }
  }

  private createOutputs() {
    const config = this.config;

    new cdk.CfnOutput(this, 'EnvironmentName', {
      value: config.environment,
      exportName: `LinkShortener-Environment-${config.environment}`,
    });

    new cdk.CfnOutput(this, 'ConfigParameterName', {
      value: `/linkshortener/${config.environment}/config`,
      exportName: `LinkShortener-ConfigParam-${config.environment}`,
    });

    if (config.domainName) {
      new cdk.CfnOutput(this, 'DomainName', {
        value: config.domainName,
        exportName: `LinkShortener-DomainName-${config.environment}`,
      });
    }

    // Cost optimization settings
    new cdk.CfnOutput(this, 'CloudFrontPriceClass', {
      value: config.costOptimization.cloudfrontPriceClass,
      exportName: `LinkShortener-CFPriceClass-${config.environment}`,
    });

    new cdk.CfnOutput(this, 'LambdaMemorySize', {
      value: config.lambda.memorySize.toString(),
      exportName: `LinkShortener-LambdaMemory-${config.environment}`,
    });

    // Tags for cost allocation
    cdk.Tags.of(this).add('Environment', config.environment);
    cdk.Tags.of(this).add('Component', 'Configuration');
    cdk.Tags.of(this).add('CostCenter', 'LinkShortener');
  }
}

/**
 * Helper function to get environment configuration
 */
export function getEnvironmentConfig(environment: string): EnvironmentConfig {
  const stack = new ConfigStack(new cdk.App(), 'temp', { environment });
  return stack.config;
}