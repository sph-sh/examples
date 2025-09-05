import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface ApiStackProps extends cdk.StackProps {
  environment: string;
  config: any;
  createHandler: lambda.Function;
  redirectHandler: lambda.Function;
  analyticsHandler: lambda.Function;
}

export class ApiStack extends cdk.Stack {
  public readonly restApi: apigateway.RestApi;
  public readonly requestValidator: apigateway.RequestValidator;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { environment, config, createHandler, redirectHandler, analyticsHandler } = props;

    // Create API Gateway with optimized settings
    this.restApi = new apigateway.RestApi(this, 'LinkShortenerApi', {
      restApiName: `Link Shortener API - ${environment}`,
      description: `Production link shortener API for ${environment} environment`,
      
      // Performance optimizations
      minCompressionSize: cdk.Size.kibibytes(1), // Compress responses > 1KB
      binaryMediaTypes: ['*/*'], // Support all binary types
      
      // CORS configuration for web clients
      defaultCorsPreflightOptions: {
        allowOrigins: environment === 'prod' 
          ? [
              'https://yourdomain.com',
              'https://www.yourdomain.com',
              `https://${config.domainName}`,
            ]
          : apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
          'X-Amz-Security-Token',
          'X-Requested-With',
        ],
        maxAge: cdk.Duration.hours(1),
        allowCredentials: true,
      },

      // API Gateway deployment configuration
      deployOptions: {
        stageName: environment,
        
        // Detailed metrics for monitoring
        metricsEnabled: true,
        loggingLevel: environment === 'prod' 
          ? apigateway.MethodLoggingLevel.ERROR 
          : apigateway.MethodLoggingLevel.INFO,
        
        // Don't log request/response data in production for privacy
        dataTraceEnabled: environment !== 'prod',
        
        // Throttling configuration
        throttlingBurstLimit: 2000,
        throttlingRateLimit: 1000,
        
        // Caching configuration for GET requests
        cachingEnabled: environment === 'prod',
        cacheClusterEnabled: environment === 'prod',
        cacheClusterSize: environment === 'prod' ? '0.5' : undefined,
        cacheTtl: cdk.Duration.minutes(5),
      },

      // CloudWatch logs
      cloudWatchRole: true,

      // Enable API key for additional security if needed
      apiKeySourceType: apigateway.ApiKeySourceType.HEADER,
    });

    // Create request validator for input validation
    this.requestValidator = new apigateway.RequestValidator(this, 'RequestValidator', {
      restApi: this.restApi,
      requestValidatorName: `LinkShortener-Validator-${environment}`,
      validateRequestBody: true,
      validateRequestParameters: true,
    });

    // Create models for request/response validation
    const createLinkRequestModel = new apigateway.Model(this, 'CreateLinkRequestModel', {
      restApi: this.restApi,
      modelName: 'CreateLinkRequest',
      contentType: 'application/json',
      schema: {
        type: apigateway.JsonSchemaType.OBJECT,
        properties: {
          url: {
            type: apigateway.JsonSchemaType.STRING,
            pattern: '^https?://.+',
            minLength: 10,
            maxLength: 2048,
            description: 'The URL to shorten',
          },
          customCode: {
            type: apigateway.JsonSchemaType.STRING,
            pattern: '^[a-zA-Z0-9-_]{3,20}$',
            description: 'Optional custom short code',
          },
          expiresIn: {
            type: apigateway.JsonSchemaType.NUMBER,
            minimum: 3600, // 1 hour minimum
            maximum: 31536000, // 1 year maximum
            description: 'Optional expiration time in seconds',
          },
          userId: {
            type: apigateway.JsonSchemaType.STRING,
            minLength: 1,
            maxLength: 100,
            description: 'Optional user ID for link ownership',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    });

    // Lambda integrations with optimized settings
    const createIntegration = new apigateway.LambdaIntegration(createHandler, {
      proxy: true,
      allowTestInvoke: environment !== 'prod', // Disable test invoke in production
      integrationResponses: [
        {
          statusCode: '200',
          responseTemplates: {
            'application/json': '', // Pass through response
          },
        },
        {
          statusCode: '400',
          selectionPattern: '4\\d{2}',
          responseTemplates: {
            'application/json': '{"error": "Bad Request"}',
          },
        },
        {
          statusCode: '500',
          selectionPattern: '5\\d{2}',
          responseTemplates: {
            'application/json': '{"error": "Internal Server Error"}',
          },
        },
      ],
    });

    const redirectIntegration = new apigateway.LambdaIntegration(redirectHandler, {
      proxy: true,
      allowTestInvoke: false, // Never allow test invoke for redirects
    });

    const analyticsIntegration = new apigateway.LambdaIntegration(analyticsHandler, {
      proxy: true,
      allowTestInvoke: environment !== 'prod',
    });

    // API Routes
    
    // POST /api/shorten - Create shortened URL
    const apiResource = this.restApi.root.addResource('api');
    const shortenResource = apiResource.addResource('shorten');
    
    shortenResource.addMethod('POST', createIntegration, {
      requestModels: {
        'application/json': createLinkRequestModel,
      },
      requestValidator: this.requestValidator,
      methodResponses: [
        {
          statusCode: '201',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
          responseParameters: {
            'method.response.header.Access-Control-Allow-Origin': true,
          },
        },
        {
          statusCode: '400',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL,
          },
        },
        {
          statusCode: '409',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL,
          },
        },
        {
          statusCode: '500',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL,
          },
        },
      ],
    });

    // GET /{shortCode} - Redirect to original URL
    const shortCodeResource = this.restApi.root.addResource('{shortCode}');
    shortCodeResource.addMethod('GET', redirectIntegration, {
      requestParameters: {
        'method.request.path.shortCode': true,
      },
      methodResponses: [
        {
          statusCode: '301',
          responseParameters: {
            'method.response.header.Location': true,
            'method.response.header.Cache-Control': true,
          },
        },
        {
          statusCode: '404',
          responseModels: {
            'text/html': apigateway.Model.EMPTY_MODEL,
          },
        },
        {
          statusCode: '410',
          responseModels: {
            'text/html': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // GET /api/analytics/{shortCode} - Get analytics data
    const analyticsResource = apiResource.addResource('analytics');
    const analyticsCodeResource = analyticsResource.addResource('{shortCode}');
    
    analyticsCodeResource.addMethod('GET', analyticsIntegration, {
      requestParameters: {
        'method.request.path.shortCode': true,
        'method.request.querystring.period': false,
        'method.request.querystring.granularity': false,
      },
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
        {
          statusCode: '404',
          responseModels: {
            'application/json': apigateway.Model.ERROR_MODEL,
          },
        },
      ],
    });

    // GET /api/health - Health check endpoint
    const healthResource = apiResource.addResource('health');
    healthResource.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [
        {
          statusCode: '200',
          responseTemplates: {
            'application/json': JSON.stringify({
              status: 'healthy',
              timestamp: '$context.requestTime',
              environment,
            }),
          },
        },
      ],
      requestTemplates: {
        'application/json': '{"statusCode": 200}',
      },
    }), {
      methodResponses: [
        {
          statusCode: '200',
          responseModels: {
            'application/json': apigateway.Model.EMPTY_MODEL,
          },
        },
      ],
    });

    // Create API Key and Usage Plan for premium features (optional)
    if (environment === 'prod') {
      const apiKey = new apigateway.ApiKey(this, 'ApiKey', {
        apiKeyName: `LinkShortener-ApiKey-${environment}`,
        description: 'API key for Link Shortener premium features',
      });

      const usagePlan = new apigateway.UsagePlan(this, 'UsagePlan', {
        name: `LinkShortener-UsagePlan-${environment}`,
        description: 'Usage plan for Link Shortener API',
        apiStages: [
          {
            api: this.restApi,
            stage: this.restApi.deploymentStage,
          },
        ],
        throttle: {
          rateLimit: 1000,
          burstLimit: 2000,
        },
        quota: {
          limit: 100000,
          period: apigateway.Period.MONTH,
        },
      });

      usagePlan.addApiKey(apiKey);
    }

    // Add WAF protection in production
    if (environment === 'prod') {
      // WAF configuration would go here
      // This is a placeholder for Web Application Firewall rules
    }

    // Outputs
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.restApi.url,
      exportName: `LinkShortener-ApiUrl-${environment}`,
      description: 'API Gateway URL',
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.restApi.restApiId,
      exportName: `LinkShortener-ApiId-${environment}`,
      description: 'API Gateway ID',
    });

    // Tags for cost allocation
    cdk.Tags.of(this.restApi).add('Component', 'API');
    cdk.Tags.of(this.restApi).add('CostCenter', 'LinkShortener');
  }
}