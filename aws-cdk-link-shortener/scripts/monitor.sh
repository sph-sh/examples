#!/bin/bash

# AWS CDK Link Shortener - Monitoring Script
# Usage: ./scripts/monitor.sh [environment] [command]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="${1:-dev}"
COMMAND="${2:-dashboard}"

echo -e "${BLUE}🔍 Link Shortener Monitoring - ${ENVIRONMENT}${NC}"
echo "========================================"

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    echo -e "${RED}❌ Invalid environment: ${ENVIRONMENT}${NC}"
    echo "Valid environments: dev, staging, prod"
    exit 1
fi

# Check if AWS CLI is available
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI is not installed${NC}"
    exit 1
fi

# Get AWS account and region
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "unknown")
AWS_REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")

echo "Environment: $ENVIRONMENT"
echo "AWS Account: $AWS_ACCOUNT"
echo "AWS Region: $AWS_REGION"
echo ""

case $COMMAND in
    "dashboard"|"dash")
        echo -e "${BLUE}📊 Opening CloudWatch Dashboard...${NC}"
        DASHBOARD_URL="https://console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}#dashboards:name=LinkShortener-${ENVIRONMENT}"
        echo "Dashboard URL: $DASHBOARD_URL"
        
        # Try to open in browser (macOS/Linux)
        if command -v open &> /dev/null; then
            open "$DASHBOARD_URL"
        elif command -v xdg-open &> /dev/null; then
            xdg-open "$DASHBOARD_URL"
        else
            echo "Please open the URL above in your browser"
        fi
        ;;

    "logs"|"log")
        echo -e "${BLUE}📝 Fetching recent logs...${NC}"
        
        # Lambda function logs
        FUNCTIONS=("LinkShortener-Create-${ENVIRONMENT}" "LinkShortener-Redirect-${ENVIRONMENT}" "LinkShortener-Analytics-${ENVIRONMENT}")
        
        for func in "${FUNCTIONS[@]}"; do
            echo -e "\n${YELLOW}📋 Logs for $func:${NC}"
            aws logs tail "/aws/lambda/$func" --since 1h --follow=false --format short | head -20 || echo "  No recent logs found"
        done
        
        # API Gateway logs
        echo -e "\n${YELLOW}📋 API Gateway Logs:${NC}"
        aws logs tail "/aws/apigateway/LinkShortener-${ENVIRONMENT}" --since 1h --follow=false --format short | head -20 || echo "  No recent logs found"
        ;;

    "metrics"|"metric")
        echo -e "${BLUE}📈 Fetching key metrics...${NC}"
        
        # Get current time
        END_TIME=$(date -u +"%Y-%m-%dT%H:%M:%S")
        START_TIME=$(date -u -d '1 hour ago' +"%Y-%m-%dT%H:%M:%S")
        
        echo "Time range: $START_TIME to $END_TIME"
        echo ""
        
        # API Gateway metrics
        echo -e "${YELLOW}🌐 API Gateway Metrics:${NC}"
        aws cloudwatch get-metric-statistics \
            --namespace AWS/ApiGateway \
            --metric-name Count \
            --dimensions Name=ApiName,Value="Link Shortener API - ${ENVIRONMENT}" \
            --start-time "$START_TIME" \
            --end-time "$END_TIME" \
            --period 3600 \
            --statistics Sum \
            --query 'Datapoints[0].Sum' \
            --output text 2>/dev/null | xargs -I {} echo "  Total Requests: {}"
            
        aws cloudwatch get-metric-statistics \
            --namespace AWS/ApiGateway \
            --metric-name 4XXError \
            --dimensions Name=ApiName,Value="Link Shortener API - ${ENVIRONMENT}" \
            --start-time "$START_TIME" \
            --end-time "$END_TIME" \
            --period 3600 \
            --statistics Sum \
            --query 'Datapoints[0].Sum' \
            --output text 2>/dev/null | xargs -I {} echo "  4XX Errors: {}"
            
        aws cloudwatch get-metric-statistics \
            --namespace AWS/ApiGateway \
            --metric-name 5XXError \
            --dimensions Name=ApiName,Value="Link Shortener API - ${ENVIRONMENT}" \
            --start-time "$START_TIME" \
            --end-time "$END_TIME" \
            --period 3600 \
            --statistics Sum \
            --query 'Datapoints[0].Sum' \
            --output text 2>/dev/null | xargs -I {} echo "  5XX Errors: {}"
        
        # Lambda metrics
        echo -e "\n${YELLOW}⚡ Lambda Metrics:${NC}"
        for func in "${FUNCTIONS[@]}"; do
            INVOCATIONS=$(aws cloudwatch get-metric-statistics \
                --namespace AWS/Lambda \
                --metric-name Invocations \
                --dimensions Name=FunctionName,Value="$func" \
                --start-time "$START_TIME" \
                --end-time "$END_TIME" \
                --period 3600 \
                --statistics Sum \
                --query 'Datapoints[0].Sum' \
                --output text 2>/dev/null || echo "0")
            
            ERRORS=$(aws cloudwatch get-metric-statistics \
                --namespace AWS/Lambda \
                --metric-name Errors \
                --dimensions Name=FunctionName,Value="$func" \
                --start-time "$START_TIME" \
                --end-time "$END_TIME" \
                --period 3600 \
                --statistics Sum \
                --query 'Datapoints[0].Sum' \
                --output text 2>/dev/null || echo "0")
            
            DURATION=$(aws cloudwatch get-metric-statistics \
                --namespace AWS/Lambda \
                --metric-name Duration \
                --dimensions Name=FunctionName,Value="$func" \
                --start-time "$START_TIME" \
                --end-time "$END_TIME" \
                --period 3600 \
                --statistics Average \
                --query 'Datapoints[0].Average' \
                --output text 2>/dev/null || echo "0")
            
            echo "  $func:"
            echo "    Invocations: $INVOCATIONS"
            echo "    Errors: $ERRORS"
            echo "    Avg Duration: ${DURATION}ms"
        done
        
        # DynamoDB metrics
        echo -e "\n${YELLOW}🗃️  DynamoDB Metrics:${NC}"
        TABLES=("LinkShortener-Links-${ENVIRONMENT}" "LinkShortener-Analytics-${ENVIRONMENT}")
        
        for table in "${TABLES[@]}"; do
            READ_CAPACITY=$(aws cloudwatch get-metric-statistics \
                --namespace AWS/DynamoDB \
                --metric-name ConsumedReadCapacityUnits \
                --dimensions Name=TableName,Value="$table" \
                --start-time "$START_TIME" \
                --end-time "$END_TIME" \
                --period 3600 \
                --statistics Sum \
                --query 'Datapoints[0].Sum' \
                --output text 2>/dev/null || echo "0")
            
            WRITE_CAPACITY=$(aws cloudwatch get-metric-statistics \
                --namespace AWS/DynamoDB \
                --metric-name ConsumedWriteCapacityUnits \
                --dimensions Name=TableName,Value="$table" \
                --start-time "$START_TIME" \
                --end-time "$END_TIME" \
                --period 3600 \
                --statistics Sum \
                --query 'Datapoints[0].Sum' \
                --output text 2>/dev/null || echo "0")
            
            echo "  $table:"
            echo "    Read Capacity: $READ_CAPACITY"
            echo "    Write Capacity: $WRITE_CAPACITY"
        done
        ;;

    "alarms"|"alarm")
        echo -e "${BLUE}🚨 Checking alarms...${NC}"
        
        aws cloudwatch describe-alarms \
            --alarm-name-prefix "LinkShortener" \
            --state-value ALARM \
            --query 'MetricAlarms[].{Name:AlarmName,State:StateValue,Reason:StateReason}' \
            --output table || echo "No active alarms found"
        ;;

    "health"|"status")
        echo -e "${BLUE}🏥 Health check...${NC}"
        
        # Try to get API endpoint from CloudFormation outputs
        API_URL=$(aws cloudformation describe-stacks \
            --stack-name "LinkShortener-Api-${ENVIRONMENT}" \
            --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
            --output text 2>/dev/null || echo "")
        
        if [[ -n "$API_URL" ]]; then
            echo "Testing API endpoint: ${API_URL}api/health"
            
            if curl -s "${API_URL}api/health" | jq -e '.status == "healthy"' > /dev/null 2>&1; then
                echo -e "${GREEN}✅ API is healthy${NC}"
            else
                echo -e "${RED}❌ API health check failed${NC}"
            fi
        else
            echo -e "${YELLOW}⚠️  Could not determine API URL${NC}"
        fi
        
        # Check Lambda function status
        for func in "${FUNCTIONS[@]}"; do
            STATE=$(aws lambda get-function \
                --function-name "$func" \
                --query 'Configuration.State' \
                --output text 2>/dev/null || echo "Unknown")
            
            if [[ "$STATE" == "Active" ]]; then
                echo -e "${GREEN}✅ $func is active${NC}"
            else
                echo -e "${RED}❌ $func state: $STATE${NC}"
            fi
        done
        
        # Check DynamoDB table status
        for table in "${TABLES[@]}"; do
            STATUS=$(aws dynamodb describe-table \
                --table-name "$table" \
                --query 'Table.TableStatus' \
                --output text 2>/dev/null || echo "Unknown")
            
            if [[ "$STATUS" == "ACTIVE" ]]; then
                echo -e "${GREEN}✅ $table is active${NC}"
            else
                echo -e "${RED}❌ $table status: $STATUS${NC}"
            fi
        done
        ;;

    "costs"|"cost")
        echo -e "${BLUE}💰 Cost analysis...${NC}"
        
        # Get costs for the last 7 days
        START_DATE=$(date -u -d '7 days ago' +"%Y-%m-%d")
        END_DATE=$(date -u +"%Y-%m-%d")
        
        echo "Cost analysis from $START_DATE to $END_DATE"
        echo ""
        
        aws ce get-cost-and-usage \
            --time-period Start="$START_DATE",End="$END_DATE" \
            --granularity DAILY \
            --metrics BlendedCost \
            --group-by Type=DIMENSION,Key=SERVICE \
            --filter '{"Dimensions":{"Key":"SERVICE","Values":["Amazon DynamoDB","AWS Lambda","Amazon API Gateway","Amazon CloudFront","Amazon Route 53"]}}' \
            --query 'ResultsByTime[-1].Groups[].[Keys[0],Metrics.BlendedCost.Amount]' \
            --output table 2>/dev/null || echo "Cost data not available"
        ;;

    "cleanup"|"clean")
        echo -e "${BLUE}🧹 Cleanup old logs...${NC}"
        
        if [[ "$ENVIRONMENT" != "prod" ]]; then
            echo "Cleaning up old CloudWatch logs for $ENVIRONMENT environment"
            
            for func in "${FUNCTIONS[@]}"; do
                LOG_GROUP="/aws/lambda/$func"
                echo "Cleaning old log streams for $LOG_GROUP"
                
                # Delete log streams older than 7 days (dev/staging only)
                aws logs describe-log-streams \
                    --log-group-name "$LOG_GROUP" \
                    --order-by LastEventTime \
                    --query "logStreams[?lastEventTime < $(date -d '7 days ago' +%s)000].[logStreamName]" \
                    --output text | \
                while read -r stream; do
                    if [[ -n "$stream" ]]; then
                        aws logs delete-log-stream --log-group-name "$LOG_GROUP" --log-stream-name "$stream"
                        echo "  Deleted log stream: $stream"
                    fi
                done
            done
        else
            echo -e "${YELLOW}⚠️  Cleanup not performed in production environment${NC}"
        fi
        ;;

    "help"|*)
        echo "Available commands:"
        echo "  dashboard, dash    - Open CloudWatch dashboard"
        echo "  logs, log         - Show recent logs"
        echo "  metrics, metric   - Show key metrics"
        echo "  alarms, alarm     - Show active alarms"
        echo "  health, status    - Check service health"
        echo "  costs, cost       - Show cost analysis"
        echo "  cleanup, clean    - Clean up old logs (dev/staging only)"
        echo "  help             - Show this help"
        echo ""
        echo "Usage: ./scripts/monitor.sh [environment] [command]"
        echo "Example: ./scripts/monitor.sh prod metrics"
        ;;
esac

echo ""
echo -e "${GREEN}✅ Monitoring completed${NC}"