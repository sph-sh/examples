import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';

interface DomainStackProps extends cdk.StackProps {
  environment: string;
  config: {
    domainName: string;
    hostedZoneId?: string;
    createHostedZone?: boolean;
    enableWildcard?: boolean;
  };
  restApi: apigateway.RestApi;
  distribution?: cloudfront.CloudFrontWebDistribution;
}

export class DomainStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;
  public readonly certificate: acm.Certificate;
  public readonly domainName: apigateway.DomainName;

  constructor(scope: Construct, id: string, props: DomainStackProps) {
    super(scope, id, props);

    const { environment, config, restApi, distribution } = props;

    // Get or create hosted zone
    if (config.hostedZoneId) {
      // Use existing hosted zone
      this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: config.hostedZoneId,
        zoneName: config.domainName,
      });
    } else if (config.createHostedZone) {
      // Create new hosted zone
      this.hostedZone = new route53.HostedZone(this, 'HostedZone', {
        zoneName: config.domainName,
        comment: `Hosted zone for Link Shortener ${environment} environment`,
      });
    } else {
      throw new Error('Either hostedZoneId or createHostedZone must be specified');
    }

    // Create SSL certificate
    // IMPORTANT: For CloudFront, certificate must be in us-east-1
    // For API Gateway regional, certificate must be in the same region
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: config.domainName,
      subjectAlternativeNames: config.enableWildcard ? [`*.${config.domainName}`] : undefined,
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
      certificateName: `LinkShortener-${environment}-Certificate`,
    });

    // Create API Gateway custom domain
    this.domainName = new apigateway.DomainName(this, 'ApiDomainName', {
      domainName: `api.${config.domainName}`,
      certificate: this.certificate,
      endpointType: apigateway.EndpointType.REGIONAL,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
    });

    // Add base path mapping
    this.domainName.addBasePathMapping(restApi, {
      basePath: environment === 'prod' ? undefined : environment, // Production at root, others at /dev or /staging
    });

    // Create DNS records
    
    // API subdomain (api.yourdomain.com) -> API Gateway
    new route53.ARecord(this, 'ApiAliasRecord', {
      zone: this.hostedZone,
      recordName: 'api',
      target: route53.RecordTarget.fromAlias(
        new route53Targets.ApiGatewayDomain(this.domainName)
      ),
      ttl: cdk.Duration.minutes(5),
      comment: `API Gateway alias for ${environment} environment`,
    });

    // Main domain (yourdomain.com) -> CloudFront or API Gateway
    if (distribution) {
      // Point main domain to CloudFront distribution
      new route53.ARecord(this, 'RootAliasRecord', {
        zone: this.hostedZone,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution)
        ),
        ttl: cdk.Duration.minutes(5),
        comment: `CloudFront alias for ${environment} environment`,
      });

      // Optional: www subdomain
      new route53.ARecord(this, 'WwwAliasRecord', {
        zone: this.hostedZone,
        recordName: 'www',
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(distribution)
        ),
        ttl: cdk.Duration.minutes(5),
        comment: `WWW CloudFront alias for ${environment} environment`,
      });
    } else {
      // Point main domain directly to API Gateway (not recommended for production)
      new route53.ARecord(this, 'RootAliasRecord', {
        zone: this.hostedZone,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.ApiGatewayDomain(this.domainName)
        ),
        ttl: cdk.Duration.minutes(5),
        comment: `Direct API Gateway alias for ${environment} environment`,
      });
    }

    // Health check for monitoring
    if (environment === 'prod') {
      const healthCheck = new route53.CfnHealthCheck(this, 'HealthCheck', {
        type: 'HTTPS',
        fullyQualifiedDomainName: `api.${config.domainName}`,
        resourcePath: '/api/health',
        port: 443,
        requestInterval: 30,
        failureThreshold: 3,
        tags: [
          {
            key: 'Name',
            value: `LinkShortener-${environment}-HealthCheck`,
          },
          {
            key: 'Environment',
            value: environment,
          },
        ],
      });

      // CloudWatch alarm for health check failures
      new cdk.aws_cloudwatch.Alarm(this, 'HealthCheckAlarm', {
        alarmName: `LinkShortener-${environment}-HealthCheckFailure`,
        alarmDescription: 'API health check is failing',
        metric: new cdk.aws_cloudwatch.Metric({
          namespace: 'AWS/Route53',
          metricName: 'HealthCheckStatus',
          dimensionsMap: {
            HealthCheckId: healthCheck.attrHealthCheckId,
          },
          statistic: 'Minimum',
        }),
        threshold: 1,
        evaluationPeriods: 2,
        treatMissingData: cdk.aws_cloudwatch.TreatMissingData.BREACHING,
      });
    }

    // MX record for email (optional)
    if (environment === 'prod') {
      new route53.MxRecord(this, 'MxRecord', {
        zone: this.hostedZone,
        values: [
          {
            hostName: 'aspmx.l.google.com',
            priority: 1,
          },
          {
            hostName: 'alt1.aspmx.l.google.com',
            priority: 5,
          },
          {
            hostName: 'alt2.aspmx.l.google.com',
            priority: 5,
          },
          {
            hostName: 'alt3.aspmx.l.google.com',
            priority: 10,
          },
          {
            hostName: 'alt4.aspmx.l.google.com',
            priority: 10,
          },
        ],
        ttl: cdk.Duration.hours(1),
      });

      // SPF record for email security
      new route53.TxtRecord(this, 'SpfRecord', {
        zone: this.hostedZone,
        values: ['v=spf1 include:_spf.google.com ~all'],
        ttl: cdk.Duration.hours(1),
      });

      // DMARC record for email security
      new route53.TxtRecord(this, 'DmarcRecord', {
        zone: this.hostedZone,
        recordName: '_dmarc',
        values: ['v=DMARC1; p=quarantine; rua=mailto:dmarc@' + config.domainName],
        ttl: cdk.Duration.hours(1),
      });
    }

    // CAA record for certificate authority authorization
    new route53.CaaRecord(this, 'CaaRecord', {
      zone: this.hostedZone,
      values: [
        {
          flag: 0,
          tag: route53.CaaTag.ISSUE,
          value: 'amazon.com',
        },
        {
          flag: 0,
          tag: route53.CaaTag.ISSUEWILD,
          value: 'amazon.com',
        },
      ],
      ttl: cdk.Duration.hours(1),
    });

    // Outputs
    new cdk.CfnOutput(this, 'HostedZoneId', {
      value: this.hostedZone.hostedZoneId,
      exportName: `LinkShortener-HostedZoneId-${environment}`,
      description: 'Route53 Hosted Zone ID',
    });

    new cdk.CfnOutput(this, 'NameServers', {
      value: cdk.Fn.join(', ', this.hostedZone.hostedZoneNameServers || []),
      exportName: `LinkShortener-NameServers-${environment}`,
      description: 'Route53 Name Servers',
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      exportName: `LinkShortener-CertificateArn-${environment}`,
      description: 'SSL Certificate ARN',
    });

    new cdk.CfnOutput(this, 'ApiDomainName', {
      value: this.domainName.domainName,
      exportName: `LinkShortener-ApiDomainName-${environment}`,
      description: 'API Gateway Custom Domain Name',
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: `https://${this.domainName.domainName}`,
      exportName: `LinkShortener-ApiUrl-${environment}`,
      description: 'API Base URL',
    });

    // Tags
    cdk.Tags.of(this).add('Component', 'Domain');
    cdk.Tags.of(this).add('CostCenter', 'LinkShortener');
  }
}