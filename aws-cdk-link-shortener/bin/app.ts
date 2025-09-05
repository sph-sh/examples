#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { DatabaseStack } from '../lib/database-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { ApiStack } from '../lib/api-stack';
import { CdnStack } from '../lib/cdn-stack';
import { DnsStack } from '../lib/dns-stack';
import { MonitoringStack } from '../lib/monitoring-stack';

const app = new cdk.App();

// Get environment from context or default to 'dev'
const environment = app.node.tryGetContext('environment') || 'dev';
const config = app.node.tryGetContext(environment);

if (!config) {
  throw new Error(`Configuration not found for environment: ${environment}`);
}

const stackProps: cdk.StackProps = {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
  tags: {
    Project: 'LinkShortener',
    Environment: environment,
    ManagedBy: 'CDK',
  },
};

// Database Stack - DynamoDB tables and indexes
const databaseStack = new DatabaseStack(app, `LinkShortener-Database-${environment}`, {
  ...stackProps,
  environment,
  config,
});

// Lambda Stack - Function definitions and layers
const lambdaStack = new LambdaStack(app, `LinkShortener-Lambda-${environment}`, {
  ...stackProps,
  environment,
  config,
  linksTable: databaseStack.linksTable,
  analyticsTable: databaseStack.analyticsTable,
});

// API Stack - API Gateway and integrations
const apiStack = new ApiStack(app, `LinkShortener-Api-${environment}`, {
  ...stackProps,
  environment,
  config,
  createHandler: lambdaStack.createHandler,
  redirectHandler: lambdaStack.redirectHandler,
  analyticsHandler: lambdaStack.analyticsHandler,
});

// DNS Stack - Route53 custom domain (only for production)
let dnsStack: DnsStack | undefined;
if (config.domainName && config.hostedZoneId) {
  dnsStack = new DnsStack(app, `LinkShortener-Dns-${environment}`, {
    ...stackProps,
    environment,
    config,
    restApi: apiStack.restApi,
  });
}

// CDN Stack - CloudFront distribution
const cdnStack = new CdnStack(app, `LinkShortener-Cdn-${environment}`, {
  ...stackProps,
  environment,
  config,
  restApi: apiStack.restApi,
  customDomain: dnsStack?.customDomain,
});

// Monitoring Stack - CloudWatch dashboards and alarms
const monitoringStack = new MonitoringStack(app, `LinkShortener-Monitoring-${environment}`, {
  ...stackProps,
  environment,
  config,
  restApi: apiStack.restApi,
  createHandler: lambdaStack.createHandler,
  redirectHandler: lambdaStack.redirectHandler,
  analyticsHandler: lambdaStack.analyticsHandler,
  linksTable: databaseStack.linksTable,
  analyticsTable: databaseStack.analyticsTable,
  distribution: cdnStack.distribution,
});

// Stack dependencies
lambdaStack.addDependency(databaseStack);
apiStack.addDependency(lambdaStack);
if (dnsStack) {
  cdnStack.addDependency(dnsStack);
}
cdnStack.addDependency(apiStack);
monitoringStack.addDependency(apiStack);
monitoringStack.addDependency(lambdaStack);
monitoringStack.addDependency(databaseStack);
monitoringStack.addDependency(cdnStack);

// Output important values
new cdk.CfnOutput(apiStack, 'ApiEndpoint', {
  value: apiStack.restApi.url,
  description: 'API Gateway endpoint URL',
});

if (cdnStack.distribution) {
  new cdk.CfnOutput(cdnStack, 'CloudFrontDomain', {
    value: cdnStack.distribution.distributionDomainName,
    description: 'CloudFront distribution domain',
  });
}

if (config.domainName) {
  new cdk.CfnOutput(cdnStack, 'CustomDomain', {
    value: `https://${config.domainName}`,
    description: 'Custom domain URL',
  });
}