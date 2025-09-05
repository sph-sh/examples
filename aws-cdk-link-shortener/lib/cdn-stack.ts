import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';

interface CdnStackProps extends cdk.StackProps {
  environment: string;
  config: any;
  restApi: apigateway.RestApi;
  customDomain?: route53.IHostedZone;
}

export class CdnStack extends cdk.Stack {
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnStackProps) {
    super(scope, id, props);

    const { environment, config, restApi, customDomain } = props;

    // Create CloudFront distribution
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Link Shortener CDN - ${environment}`,
      
      // Default behavior - API Gateway origin
      defaultBehavior: {
        origin: new origins.RestApiOrigin(restApi, {
          originPath: `/${restApi.deploymentStage.stageName}`,
        }),
        
        // Caching configuration optimized for redirects
        cachePolicy: new cloudfront.CachePolicy(this, 'RedirectCachePolicy', {
          cachePolicyName: `LinkShortener-Redirects-${environment}`,
          comment: 'Cache policy optimized for URL redirects',
          
          // Cache short codes for 5 minutes, but allow cache invalidation
          defaultTtl: cdk.Duration.minutes(5),
          maxTtl: cdk.Duration.hours(24),
          minTtl: cdk.Duration.seconds(0),
          
          // Cache key configuration
          headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
            'User-Agent', 
            'Referer',
            'Accept-Language',
            'CloudFront-Viewer-Country'
          ),
          queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
          cookieBehavior: cloudfront.CacheCookieBehavior.none(),
          
          // Enable compression
          enableAcceptEncodingGzip: true,
          enableAcceptEncodingBrotli: true,
        }),
        
        // Origin request policy
        originRequestPolicy: new cloudfront.OriginRequestPolicy(this, 'RedirectOriginPolicy', {
          originRequestPolicyName: `LinkShortener-Origin-${environment}`,
          comment: 'Origin request policy for link shortener',
          
          headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
            'User-Agent',
            'Referer',
            'Accept',
            'Accept-Language',
            'Authorization',
            'CloudFront-Viewer-Country',
            'CloudFront-Viewer-Country-Region',
            'CloudFront-Viewer-City'
          ),
          queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
          cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
        }),
        
        // Response headers policy for security
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
          responseHeadersPolicyName: `LinkShortener-Security-${environment}`,
          comment: 'Security headers for link shortener',
          
          securityHeadersBehavior: {
            contentTypeOptions: { override: true },
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            referrerPolicy: { 
              referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, 
              override: true 
            },
            strictTransportSecurity: {
              accessControlMaxAge: cdk.Duration.seconds(31536000),
              includeSubdomains: true,
              preload: true,
              override: true,
            },
          },
          
          customHeadersBehavior: {
            'X-Service': { value: 'LinkShortener', override: true },
            'X-Environment': { value: environment, override: true },
          },
        }),
        
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      
      // Additional behaviors for API endpoints
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.RestApiOrigin(restApi, {
            originPath: `/${restApi.deploymentStage.stageName}`,
          }),
          
          // Different caching for API endpoints
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
          
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        },
      },
      
      // Geographic restrictions (if needed)
      geoRestriction: environment === 'prod' 
        ? cloudfront.GeoRestriction.denylist() // Can add specific countries to block
        : cloudfront.GeoRestriction.allowlist(), // Allow all for dev
      
      // HTTP versions
      httpVersion: cloudfront.HttpVersion.HTTP2,
      
      // Price class optimization
      priceClass: environment === 'prod' 
        ? cloudfront.PriceClass.PRICE_CLASS_ALL 
        : cloudfront.PriceClass.PRICE_CLASS_100,
      
      // Error pages
      errorResponses: [
        {
          httpStatus: 404,
          responseHttpStatus: 404,
          responsePagePath: '/error.html',
          ttl: cdk.Duration.minutes(5),
        },
        {
          httpStatus: 500,
          responseHttpStatus: 500, 
          responsePagePath: '/error.html',
          ttl: cdk.Duration.minutes(1),
        },
      ],
      
      // Enable logging in production
      enableLogging: environment === 'prod',
      logBucket: environment === 'prod' 
        ? new s3.Bucket(this, 'CloudFrontLogsBucket', {
            bucketName: `linkshortener-cf-logs-${environment}-${this.account}`,
            lifecycleRules: [{
              expiration: cdk.Duration.days(90),
              id: 'DeleteOldLogs',
            }],
          })
        : undefined,
      logFilePrefix: 'cloudfront-logs/',
      
      // Domain names
      domainNames: config.domainName ? [config.domainName] : undefined,
      certificate: config.certificateArn 
        ? acm.Certificate.fromCertificateArn(this, 'Certificate', config.certificateArn)
        : undefined,
    });

    // Create Route53 alias record if custom domain is provided
    if (customDomain && config.domainName) {
      new route53.ARecord(this, 'AliasRecord', {
        zone: customDomain,
        recordName: config.domainName.split('.')[0], // Extract subdomain
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.distribution)
        ),
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'DistributionId', {
      value: this.distribution.distributionId,
      exportName: `LinkShortener-DistributionId-${environment}`,
      description: 'CloudFront distribution ID',
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: this.distribution.distributionDomainName,
      exportName: `LinkShortener-DistributionDomain-${environment}`,
      description: 'CloudFront distribution domain name',
    });

    if (config.domainName) {
      new cdk.CfnOutput(this, 'CustomDomainUrl', {
        value: `https://${config.domainName}`,
        exportName: `LinkShortener-CustomDomainUrl-${environment}`,
        description: 'Custom domain URL',
      });
    }

    // Tags
    cdk.Tags.of(this.distribution).add('Component', 'CDN');
    cdk.Tags.of(this.distribution).add('CostCenter', 'LinkShortener');
  }
}

// Import required modules at the top
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';