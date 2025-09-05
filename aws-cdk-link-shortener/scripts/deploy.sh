#!/bin/bash

# AWS CDK Link Shortener - Deployment Script
# Usage: ./scripts/deploy.sh [environment] [options]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="${1:-dev}"
SKIP_TESTS="${SKIP_TESTS:-false}"
SKIP_BUILD="${SKIP_BUILD:-false}"
DRY_RUN="${DRY_RUN:-false}"

echo -e "${BLUE}🚀 Starting deployment for environment: ${ENVIRONMENT}${NC}"
echo "----------------------------------------"

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    echo -e "${RED}❌ Invalid environment: ${ENVIRONMENT}${NC}"
    echo "Valid environments: dev, staging, prod"
    exit 1
fi

# Check prerequisites
echo -e "${BLUE}📋 Checking prerequisites...${NC}"

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed${NC}"
    exit 1
fi

# Check if CDK is installed
if ! command -v cdk &> /dev/null; then
    echo -e "${RED}❌ AWS CDK is not installed${NC}"
    echo "Install with: npm install -g aws-cdk"
    exit 1
fi

# Check if Node.js is the correct version
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo -e "${RED}❌ Node.js 18 or higher is required${NC}"
    exit 1
fi

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}❌ AWS credentials not configured${NC}"
    exit 1
fi

# Load environment variables
if [[ -f ".env.${ENVIRONMENT}" ]]; then
    echo -e "${GREEN}✅ Loading environment variables from .env.${ENVIRONMENT}${NC}"
    export $(grep -v '^#' ".env.${ENVIRONMENT}" | xargs)
else
    echo -e "${YELLOW}⚠️  No environment file found: .env.${ENVIRONMENT}${NC}"
fi

# Install dependencies
if [[ "$SKIP_BUILD" != "true" ]]; then
    echo -e "${BLUE}📦 Installing dependencies...${NC}"
    npm install
    
    echo -e "${BLUE}🔨 Building TypeScript...${NC}"
    npm run build
fi

# Run tests
if [[ "$SKIP_TESTS" != "true" ]]; then
    echo -e "${BLUE}🧪 Running tests...${NC}"
    npm test
    
    if [[ "$ENVIRONMENT" == "prod" ]]; then
        echo -e "${BLUE}🔍 Running integration tests...${NC}"
        npm run test:integration
    fi
fi

# Validate CDK app
echo -e "${BLUE}✅ Validating CDK app...${NC}"
cdk synth --context environment="$ENVIRONMENT" > /dev/null

# Bootstrap CDK (if needed)
echo -e "${BLUE}🏗️  Checking CDK bootstrap...${NC}"
if ! aws cloudformation describe-stacks --stack-name CDKToolkit &> /dev/null; then
    echo -e "${YELLOW}⚠️  CDK not bootstrapped. Running bootstrap...${NC}"
    cdk bootstrap --context environment="$ENVIRONMENT"
fi

# Show deployment plan
echo -e "${BLUE}📋 Deployment plan:${NC}"
cdk diff --context environment="$ENVIRONMENT" || true

# Confirm deployment
if [[ "$DRY_RUN" == "true" ]]; then
    echo -e "${YELLOW}🔍 Dry run mode - stopping before deployment${NC}"
    exit 0
fi

if [[ "$ENVIRONMENT" == "prod" ]]; then
    echo -e "${YELLOW}⚠️  You are about to deploy to PRODUCTION${NC}"
    read -p "Are you sure you want to continue? (yes/no): " -r
    if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
        echo -e "${YELLOW}🚫 Deployment cancelled${NC}"
        exit 0
    fi
fi

# Deploy
echo -e "${BLUE}🚀 Starting CDK deployment...${NC}"
START_TIME=$(date +%s)

if [[ "$ENVIRONMENT" == "prod" ]]; then
    # Production deployment with manual approval
    cdk deploy --all \
        --context environment="$ENVIRONMENT" \
        --require-approval never \
        --outputs-file "outputs-${ENVIRONMENT}.json" \
        --progress events
else
    # Development deployment
    cdk deploy --all \
        --context environment="$ENVIRONMENT" \
        --require-approval never \
        --outputs-file "outputs-${ENVIRONMENT}.json"
fi

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo -e "${GREEN}✅ Deployment completed successfully!${NC}"
echo "Duration: ${DURATION} seconds"

# Show outputs
if [[ -f "outputs-${ENVIRONMENT}.json" ]]; then
    echo -e "${BLUE}📤 Deployment outputs:${NC}"
    cat "outputs-${ENVIRONMENT}.json" | jq '.'
fi

# Post-deployment health checks
echo -e "${BLUE}🏥 Running health checks...${NC}"

# Extract API endpoint from outputs
API_URL=$(cat "outputs-${ENVIRONMENT}.json" 2>/dev/null | jq -r '.[] | select(.ApiUrl) | .ApiUrl' || echo "")

if [[ -n "$API_URL" ]]; then
    echo "Testing health endpoint: ${API_URL}api/health"
    
    # Wait a moment for the API to be ready
    sleep 5
    
    HEALTH_RESPONSE=$(curl -s "${API_URL}api/health" || echo "")
    if echo "$HEALTH_RESPONSE" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Health check passed${NC}"
    else
        echo -e "${YELLOW}⚠️  Health check failed or endpoint not ready${NC}"
        echo "Response: $HEALTH_RESPONSE"
    fi
else
    echo -e "${YELLOW}⚠️  Could not determine API URL for health check${NC}"
fi

# Final summary
echo ""
echo -e "${GREEN}🎉 Deployment Summary${NC}"
echo "----------------------------------------"
echo "Environment: $ENVIRONMENT"
echo "Duration: ${DURATION} seconds"
echo "Status: SUCCESS"

if [[ -n "$API_URL" ]]; then
    echo "API URL: $API_URL"
fi

# Show monitoring links
if [[ "$ENVIRONMENT" == "prod" ]]; then
    echo ""
    echo -e "${BLUE}📊 Monitoring Links:${NC}"
    echo "CloudWatch Dashboard: https://console.aws.amazon.com/cloudwatch/home#dashboards:name=LinkShortener-${ENVIRONMENT}"
    echo "Lambda Functions: https://console.aws.amazon.com/lambda/home#/functions"
    echo "DynamoDB Tables: https://console.aws.amazon.com/dynamodb/home#tables:"
fi

echo ""
echo -e "${GREEN}🚀 Deployment completed successfully!${NC}"