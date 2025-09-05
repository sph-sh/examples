import * as cdk from 'aws-cdk-lib';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface SecurityStackProps extends cdk.StackProps {
  environment: string;
  config: any;
  restApi: apigateway.RestApi;
}

export class SecurityStack extends cdk.Stack {
  public readonly webAcl: wafv2.CfnWebACL;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { environment, config, restApi } = props;

    // Create CloudWatch log group for WAF logs
    const wafLogGroup = new logs.LogGroup(this, 'WafLogGroup', {
      logGroupName: `/aws/wafv2/LinkShortener-${environment}`,
      retention: environment === 'prod' 
        ? logs.RetentionDays.ONE_MONTH 
        : logs.RetentionDays.ONE_WEEK,
      removalPolicy: environment === 'prod' 
        ? cdk.RemovalPolicy.RETAIN 
        : cdk.RemovalPolicy.DESTROY,
    });

    // Create WAF Web ACL
    this.webAcl = new wafv2.CfnWebACL(this, 'WebACL', {
      name: `LinkShortener-WAF-${environment}`,
      scope: 'REGIONAL', // For API Gateway
      defaultAction: { allow: {} },
      
      // WAF Rules
      rules: [
        // Rule 1: AWS Managed Rule - Common Rule Set
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              excludedRules: [
                // Allow legitimate requests that might be blocked
                { name: 'SizeRestrictions_BODY' }, // Allow larger request bodies for bulk operations
                { name: 'GenericRFI_BODY' }, // Allow some legitimate file inclusions
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CommonRuleSetMetric',
          },
        },

        // Rule 2: AWS Managed Rule - Known Bad Inputs
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'KnownBadInputsMetric',
          },
        },

        // Rule 3: AWS Managed Rule - Amazon IP Reputation List
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 3,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'IpReputationMetric',
          },
        },

        // Rule 4: Rate Limiting Rule
        {
          name: 'RateLimitRule',
          priority: 4,
          action: { 
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: 'RateLimitExceededBody',
              }
            }
          },
          statement: {
            rateBasedStatement: {
              limit: 2000, // 2000 requests per 5 minutes per IP
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                // Apply rate limiting to all API requests
                byteMatchStatement: {
                  searchString: '/api',
                  fieldToMatch: { uriPath: {} },
                  textTransformations: [
                    {
                      priority: 0,
                      type: 'LOWERCASE',
                    },
                  ],
                  positionalConstraint: 'STARTS_WITH',
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitMetric',
          },
        },

        // Rule 5: Geo-blocking (if needed in production)
        ...(environment === 'prod' && config.blockedCountries?.length ? [{
          name: 'GeoBlockingRule',
          priority: 5,
          action: { 
            block: {
              customResponse: {
                responseCode: 403,
                customResponseBodyKey: 'GeoBlockedBody',
              }
            }
          },
          statement: {
            geoMatchStatement: {
              countryCodes: config.blockedCountries,
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'GeoBlockingMetric',
          },
        }] : []),

        // Rule 6: Custom SQL Injection Protection
        {
          name: 'CustomSQLInjectionRule',
          priority: 6,
          action: { 
            block: {
              customResponse: {
                responseCode: 400,
                customResponseBodyKey: 'SQLInjectionBlockedBody',
              }
            }
          },
          statement: {
            orStatement: {
              statements: [
                {
                  sqliMatchStatement: {
                    fieldToMatch: { queryString: {} },
                    textTransformations: [
                      { priority: 1, type: 'URL_DECODE' },
                      { priority: 2, type: 'HTML_ENTITY_DECODE' },
                    ],
                  },
                },
                {
                  sqliMatchStatement: {
                    fieldToMatch: { body: {} },
                    textTransformations: [
                      { priority: 1, type: 'URL_DECODE' },
                      { priority: 2, type: 'HTML_ENTITY_DECODE' },
                    ],
                  },
                },
              ],
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'CustomSQLInjectionMetric',
          },
        },

        // Rule 7: Block suspicious user agents
        {
          name: 'BlockSuspiciousUserAgents',
          priority: 7,
          action: { 
            block: {
              customResponse: {
                responseCode: 403,
                customResponseBodyKey: 'SuspiciousUserAgentBody',
              }
            }
          },
          statement: {
            byteMatchStatement: {
              searchString: 'sqlmap',
              fieldToMatch: {
                singleHeader: { name: 'user-agent' },
              },
              textTransformations: [
                { priority: 0, type: 'LOWERCASE' },
              ],
              positionalConstraint: 'CONTAINS',
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'SuspiciousUserAgentMetric',
          },
        },
      ],

      // Custom response bodies
      customResponseBodies: {
        RateLimitExceededBody: {
          contentType: 'APPLICATION_JSON',
          content: JSON.stringify({
            error: 'Rate limit exceeded',
            message: 'Too many requests. Please try again later.',
            retryAfter: 300,
          }),
        },
        GeoBlockedBody: {
          contentType: 'APPLICATION_JSON',
          content: JSON.stringify({
            error: 'Access denied',
            message: 'Access from your location is not permitted.',
          }),
        },
        SQLInjectionBlockedBody: {
          contentType: 'APPLICATION_JSON',
          content: JSON.stringify({
            error: 'Invalid request',
            message: 'Request contains potentially malicious content.',
          }),
        },
        SuspiciousUserAgentBody: {
          contentType: 'APPLICATION_JSON',
          content: JSON.stringify({
            error: 'Access denied',
            message: 'Suspicious user agent detected.',
          }),
        },
      },

      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: `LinkShortener-WAF-${environment}`,
      },
    });

    // Enable WAF logging
    new wafv2.CfnLoggingConfiguration(this, 'WafLoggingConfig', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [wafLogGroup.logGroupArn],
      loggingFilter: {
        defaultBehavior: 'KEEP',
        filters: [
          {
            behavior: 'DROP',
            conditions: [
              {
                actionCondition: { action: 'ALLOW' },
              },
            ],
            requirement: 'MEETS_ALL',
          },
        ],
      },
    });

    // Associate WAF with API Gateway
    new wafv2.CfnWebACLAssociation(this, 'WebACLAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${restApi.restApiId}/stages/${environment}`,
      webAclArn: this.webAcl.attrArn,
    });

    // Outputs
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: this.webAcl.attrArn,
      exportName: `LinkShortener-WebAclArn-${environment}`,
      description: 'WAF Web ACL ARN',
    });

    new cdk.CfnOutput(this, 'WafLogGroupName', {
      value: wafLogGroup.logGroupName,
      exportName: `LinkShortener-WafLogGroup-${environment}`,
      description: 'WAF Log Group Name',
    });

    // Tags
    cdk.Tags.of(this.webAcl).add('Component', 'Security');
    cdk.Tags.of(this.webAcl).add('CostCenter', 'LinkShortener');
  }
}