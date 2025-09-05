# AWS CDK Link Shortener - Complete Implementation

This is the complete, production-ready link shortener service built with AWS CDK, as featured in the blog post series on [SPH.sh](https://sph.sh/en/series/aws-cdk-link-shortener).

## Architecture Overview

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   CloudFront    │    │   API Gateway   │    │     Lambda      │
│   (Global CDN)  │────│   (REST API)    │────│   (Node.js)     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                                        │
┌─────────────────┐    ┌─────────────────┐             │
│   Route 53      │    │    DynamoDB     │←────────────┘
│ (Custom Domain) │    │ (Links + Analytics)
└─────────────────┘    └─────────────────┘
```

## Features

- ⚡ **Sub-100ms redirects** with intelligent caching
- 📊 **Real-time analytics** with click tracking, geo data, and user agent parsing
- 🔒 **Production security** with rate limiting and fraud detection
- 🌍 **Custom domains** with SSL certificates via Route53
- 📈 **Auto-scaling** DynamoDB and Lambda with proper cost optimization
- 🛠️ **Local development** environment with DynamoDB Local
- 🔍 **Comprehensive monitoring** with CloudWatch and X-Ray tracing
- 💰 **Cost-optimized** for handling millions of redirects under $50/month

## Quick Start

### Prerequisites

- Node.js 18.x or later
- AWS CLI configured with appropriate permissions
- AWS CDK v2 installed (`npm install -g aws-cdk`)

### Installation

```bash
git clone https://github.com/sph-sh/examples.git
cd examples/aws-cdk-link-shortener
npm install
```

### Local Development

```bash
# Install DynamoDB Local
npm run install:dynamodb-local

# Start local development environment
npm run dev

# Test the service
curl -X POST http://localhost:3000/api/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'

# Test redirect
curl -i http://localhost:3000/abc123
```

### Deploy to AWS

```bash
# Bootstrap CDK (first time only)
cdk bootstrap

# Deploy to development environment
npm run deploy:dev

# Deploy to production
npm run deploy:prod
```

## Project Structure

```
aws-cdk-link-shortener/
├── lib/
│   ├── database-stack.ts      # DynamoDB tables and indexes
│   ├── lambda-stack.ts        # Lambda functions and layers
│   ├── api-stack.ts           # API Gateway configuration
│   ├── cdn-stack.ts           # CloudFront distribution
│   └── dns-stack.ts           # Route53 custom domain
├── lambda/
│   ├── create/
│   │   └── index.ts           # URL shortening logic
│   ├── redirect/
│   │   └── index.ts           # Redirect handler
│   ├── analytics/
│   │   └── index.ts           # Analytics API
│   └── shared/
│       ├── dynamodb.ts        # DynamoDB utilities
│       ├── analytics.ts       # Analytics tracking
│       └── validation.ts      # Input validation
├── local/
│   ├── server.ts              # Express development server
│   └── setup-dynamodb.ts      # Local DynamoDB setup
├── tests/
│   ├── unit/                  # Unit tests for Lambda functions
│   ├── integration/           # Integration tests
│   └── e2e/                   # End-to-end tests
├── scripts/
│   ├── deploy.sh              # Deployment scripts
│   └── monitor.sh             # Monitoring setup
├── cdk.json                   # CDK configuration
├── package.json               # Dependencies and scripts
└── README.md                  # This file
```

## Configuration

### Environment Variables

Create `.env` files for each environment:

#### `.env.dev`
```bash
ENVIRONMENT=dev
DOMAIN_NAME=dev-links.yourdomain.com
HOSTED_ZONE_ID=Z1234567890ABC
AWS_REGION=us-east-1
```

#### `.env.prod`
```bash
ENVIRONMENT=prod
DOMAIN_NAME=links.yourdomain.com
HOSTED_ZONE_ID=Z1234567890ABC
AWS_REGION=us-east-1
```

### CDK Context

Configure in `cdk.json`:

```json
{
  "context": {
    "dev": {
      "domainName": "dev-links.yourdomain.com",
      "certificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/...",
      "hostedZoneId": "Z1234567890ABC"
    },
    "prod": {
      "domainName": "links.yourdomain.com",
      "certificateArn": "arn:aws:acm:us-east-1:123456789012:certificate/...",
      "hostedZoneId": "Z1234567890ABC"
    }
  }
}
```

## Performance Benchmarks

Based on production usage with 50M+ redirects:

| Metric | Value |
|--------|--------|
| **Cold start redirect** | ~200ms |
| **Warm redirect** | ~15ms |
| **P95 response time** | <45ms |
| **DynamoDB read latency** | ~5ms |
| **Monthly cost (1M redirects)** | ~$12 |
| **Uptime** | 99.95% |

## Monitoring & Alerting

### CloudWatch Dashboards

The deployment creates comprehensive dashboards for:

- **API Performance**: Response times, error rates, throughput
- **Lambda Metrics**: Duration, errors, concurrent executions
- **DynamoDB Health**: Read/write capacity, throttling, errors
- **Cost Tracking**: Daily spend by service

### Automated Alerts

Configured alerts for:

- Error rate > 1%
- Average response time > 100ms
- DynamoDB throttling events
- Lambda errors or timeouts
- Daily cost > $2

### Log Analysis

Use these CloudWatch Insights queries:

```sql
# Performance analysis
fields @timestamp, @message
| filter @message like /Redirect processed/
| stats avg(responseTime) by bin(5m)
| sort @timestamp desc

# Error tracking
fields @timestamp, @message
| filter @message like /error/
| stats count() by shortCode
| sort count desc
| limit 20

# Popular links
fields @timestamp, shortCode
| filter @message like /SUCCESS/
| stats count() by shortCode
| sort count desc
| limit 50
```

## Security Features

### Rate Limiting

API Gateway implements multiple rate limiting layers:

- **Burst limit**: 2,000 requests/second
- **Rate limit**: 1,000 requests/second sustained
- **Per-IP throttling**: 100 requests/minute per IP

### Click Fraud Detection

Advanced patterns for detecting suspicious activity:

- Rapid-fire clicks from same IP
- Bot user agent patterns
- Suspicious referrer patterns
- Geographic anomalies

### Data Privacy

- IP addresses are hashed with salt
- No personally identifiable information stored
- GDPR-compliant data retention policies
- Optional user consent tracking

## Cost Optimization

### DynamoDB Optimization

- **On-demand billing** for unpredictable traffic
- **Projected attributes** to minimize response sizes
- **TTL cleanup** for expired analytics data
- **Global Secondary Indexes** optimized for access patterns

### Lambda Optimization

- **Provisioned concurrency** for redirect handlers during peak hours
- **Connection pooling** for DynamoDB clients
- **Minimal dependencies** for faster cold starts
- **ARM64 processors** for 20% cost reduction

### CloudFront Savings

- **Regional edge caches** for better hit rates
- **Compression enabled** for API responses
- **Price class optimization** based on user geography

## Testing

### Unit Tests

```bash
npm test
```

### Integration Tests

```bash
npm run test:integration
```

### End-to-End Tests

```bash
npm run test:e2e
```

### Load Testing

```bash
# Install Artillery
npm install -g artillery

# Run load tests
npm run test:load
```

## Deployment Scripts

### Development Deployment

```bash
./scripts/deploy.sh dev
```

### Production Deployment

```bash
./scripts/deploy.sh prod
```

### Rollback

```bash
./scripts/rollback.sh prod
```

## Troubleshooting

### Common Issues

#### DynamoDB Throttling

```bash
# Increase read/write capacity
aws dynamodb update-table \
  --table-name LinkShortener-Links-prod \
  --billing-mode PAY_PER_REQUEST
```

#### Lambda Cold Starts

```bash
# Enable provisioned concurrency
aws lambda put-provisioned-concurrency-config \
  --function-name LinkShortener-Redirect-prod \
  --qualifier '$LATEST' \
  --provisioned-concurrency-utilization 10
```

#### SSL Certificate Issues

```bash
# Validate certificate
aws acm describe-certificate \
  --certificate-arn arn:aws:acm:us-east-1:123456789012:certificate/...
```

### Monitoring Commands

```bash
# Real-time logs
npm run logs:follow

# Performance metrics
npm run metrics:dashboard

# Cost analysis
npm run costs:analyze
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes with tests
4. Submit a pull request

## License

MIT License - see LICENSE file for details

## Blog Post Series

This implementation is explained in detail in the 5-part blog series:

1. [Project Setup & Basic Infrastructure](/en/posts/aws-cdk-link-shortener-part-1)
2. [Core Functionality & API Development](/en/posts/aws-cdk-link-shortener-part-2)
3. [Advanced Features & Security](/en/posts/aws-cdk-link-shortener-part-3) (Coming Soon)
4. [Production Deployment & Optimization](/en/posts/aws-cdk-link-shortener-part-4) (Coming Soon)
5. [Scaling & Maintenance](/en/posts/aws-cdk-link-shortener-part-5) (Coming Soon)

Each post includes real production stories, performance insights, and lessons learned from handling 50M+ redirects.

## Support

For questions and support:
- 📧 Email: contact@sph.sh
- 🐛 Issues: [GitHub Issues](https://github.com/sph-sh/examples/issues)
- 💬 Discussions: [GitHub Discussions](https://github.com/sph-sh/examples/discussions)