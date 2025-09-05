import * as cdk from 'aws-cdk-lib';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Construct } from 'constructs';

interface DnsStackProps extends cdk.StackProps {
  environment: string;
  config: any;
  restApi: apigateway.RestApi;
}

export class DnsStack extends cdk.Stack {
  public readonly hostedZone: route53.IHostedZone;
  public readonly certificate: acm.Certificate;
  public readonly customDomain: apigateway.DomainName;

  constructor(scope: Construct, id: string, props: DnsStackProps) {
    super(scope, id, props);

    const { environment, config, restApi } = props;

    if (!config.domainName || !config.hostedZoneId) {
      throw new Error('Domain name and hosted zone ID are required for DNS stack');
    }

    // Import existing hosted zone
    this.hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId: config.hostedZoneId,
      zoneName: this.extractRootDomain(config.domainName),
    });

    // Create SSL certificate for the domain
    this.certificate = new acm.Certificate(this, 'Certificate', {
      domainName: config.domainName,
      
      // Add wildcard for subdomains if this is a subdomain
      subjectAlternativeNames: this.isSubdomain(config.domainName) 
        ? [`*.${this.extractRootDomain(config.domainName)}`]
        : [`www.${config.domainName}`],
      
      validation: acm.CertificateValidation.fromDns(this.hostedZone),
      
      certificateName: `LinkShortener-${environment}`,
    });

    // Create custom domain for API Gateway
    this.customDomain = new apigateway.DomainName(this, 'CustomDomain', {
      domainName: config.domainName,
      certificate: this.certificate,
      
      // Use edge-optimized for better global performance
      endpointType: apigateway.EndpointType.EDGE,
      
      // Security policy
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2,
      
      // Mapping to API Gateway stage
      mapping: restApi,
    });

    // Create A record pointing to the custom domain
    new route53.ARecord(this, 'AliasRecord', {
      zone: this.hostedZone,
      recordName: this.extractSubdomain(config.domainName),
      target: route53.RecordTarget.fromAlias(
        new route53.targets.ApiGatewayDomain(this.customDomain)
      ),
      
      // TTL for DNS caching
      ttl: cdk.Duration.minutes(5),
    });

    // Create AAAA record for IPv6 support
    new route53.AaaaRecord(this, 'IPv6Record', {
      zone: this.hostedZone,
      recordName: this.extractSubdomain(config.domainName),
      target: route53.RecordTarget.fromAlias(
        new route53.targets.ApiGatewayDomain(this.customDomain)
      ),
    });

    // Create health check for monitoring
    if (environment === 'prod') {
      const healthCheck = new route53.CfnHealthCheck(this, 'HealthCheck', {
        name: `LinkShortener-HealthCheck-${environment}`,
        type: 'HTTPS',
        resourcePath: '/api/health',
        fullyQualifiedDomainName: config.domainName,
        port: 443,
        requestInterval: 30, // Check every 30 seconds
        failureThreshold: 3, // Fail after 3 consecutive failures
        
        // CloudWatch alarm integration
        alarmIdentifier: {
          name: `LinkShortener-HealthAlarm-${environment}`,
          region: this.region,
        },
        
        // Tags
        healthCheckTags: [
          {
            key: 'Name',
            value: `LinkShortener-HealthCheck-${environment}`,
          },
          {
            key: 'Environment',
            value: environment,
          },
        ],
      });

      // Output health check ID for monitoring
      new cdk.CfnOutput(this, 'HealthCheckId', {
        value: healthCheck.attrHealthCheckId,
        exportName: `LinkShortener-HealthCheckId-${environment}`,
        description: 'Route53 health check ID',
      });
    }

    // Create CAA record for certificate authority authorization
    new route53.CaaRecord(this, 'CaaRecord', {
      zone: this.hostedZone,
      recordName: this.extractSubdomain(config.domainName),
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
    });

    // Create TXT record for domain verification (if needed)
    if (environment === 'prod') {
      new route53.TxtRecord(this, 'VerificationRecord', {
        zone: this.hostedZone,
        recordName: this.extractSubdomain(config.domainName),
        values: [
          `v=spf1 include:amazonses.com -all`, // SPF for email if needed
          `LinkShortener-verification-${environment}`, // Custom verification
        ],
      });
    }

    // Outputs
    new cdk.CfnOutput(this, 'DomainName', {
      value: config.domainName,
      exportName: `LinkShortener-DomainName-${environment}`,
      description: 'Custom domain name',
    });

    new cdk.CfnOutput(this, 'CertificateArn', {
      value: this.certificate.certificateArn,
      exportName: `LinkShortener-CertificateArn-${environment}`,
      description: 'SSL certificate ARN',
    });

    new cdk.CfnOutput(this, 'CustomDomainName', {
      value: this.customDomain.domainNameAliasDomainName,
      exportName: `LinkShortener-CustomDomainAlias-${environment}`,
      description: 'Custom domain alias domain name',
    });

    new cdk.CfnOutput(this, 'CustomDomainTarget', {
      value: this.customDomain.domainNameAliasHostedZoneId,
      exportName: `LinkShortener-CustomDomainTarget-${environment}`,
      description: 'Custom domain alias hosted zone ID',
    });

    // Tags
    cdk.Tags.of(this.certificate).add('Component', 'DNS');
    cdk.Tags.of(this.customDomain).add('Component', 'DNS');
    cdk.Tags.of(this.certificate).add('CostCenter', 'LinkShortener');
    cdk.Tags.of(this.customDomain).add('CostCenter', 'LinkShortener');
  }

  private extractRootDomain(domainName: string): string {
    const parts = domainName.split('.');
    if (parts.length >= 2) {
      return parts.slice(-2).join('.');
    }
    return domainName;
  }

  private extractSubdomain(domainName: string): string {
    const parts = domainName.split('.');
    if (parts.length > 2) {
      return parts.slice(0, -2).join('.');
    }
    return '';
  }

  private isSubdomain(domainName: string): boolean {
    return domainName.split('.').length > 2;
  }
}

// Import required modules
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';