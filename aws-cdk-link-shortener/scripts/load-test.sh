#!/bin/bash

# AWS CDK Link Shortener - Load Testing Script
# Usage: ./scripts/load-test.sh [environment] [test-type]

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
ENVIRONMENT="${1:-dev}"
TEST_TYPE="${2:-basic}"
API_URL=""

echo -e "${BLUE}🚀 Link Shortener Load Testing${NC}"
echo "=============================="

# Validate environment
if [[ ! "$ENVIRONMENT" =~ ^(dev|staging|prod)$ ]]; then
    echo -e "${RED}❌ Invalid environment: ${ENVIRONMENT}${NC}"
    echo "Valid environments: dev, staging, prod"
    exit 1
fi

# Check if curl is available
if ! command -v curl &> /dev/null; then
    echo -e "${RED}❌ curl is required for load testing${NC}"
    exit 1
fi

# Check if Apache Bench (ab) is available for some tests
if ! command -v ab &> /dev/null && [[ "$TEST_TYPE" == "stress" ]]; then
    echo -e "${YELLOW}⚠️  Apache Bench (ab) not found. Install with: brew install httpie (macOS) or apt-get install apache2-utils (Ubuntu)${NC}"
fi

# Determine API URL
if [[ "$ENVIRONMENT" == "dev" ]]; then
    API_URL="http://localhost:3000"
    echo "Using local development server"
else
    # Try to get API URL from CloudFormation
    API_URL=$(aws cloudformation describe-stacks \
        --stack-name "LinkShortener-Api-${ENVIRONMENT}" \
        --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' \
        --output text 2>/dev/null || echo "")
    
    if [[ -z "$API_URL" ]]; then
        echo -e "${RED}❌ Could not determine API URL for environment: ${ENVIRONMENT}${NC}"
        echo "Make sure the stack is deployed and try again"
        exit 1
    fi
fi

echo "API URL: $API_URL"
echo "Test Type: $TEST_TYPE"
echo ""

# Test data
TEST_URLS=(
    "https://github.com/microsoft/TypeScript"
    "https://aws.amazon.com/lambda/"
    "https://docs.aws.amazon.com/cdk/"
    "https://nodejs.org/en/docs/"
    "https://www.typescriptlang.org/"
)

# Helper function to create a short link
create_link() {
    local url="$1"
    local custom_code="$2"
    
    local payload="{\"url\":\"$url\""
    if [[ -n "$custom_code" ]]; then
        payload="$payload,\"customCode\":\"$custom_code\""
    fi
    payload="$payload}"
    
    curl -s -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$API_URL/api/shorten" | jq -r '.data.shortCode' 2>/dev/null || echo "error"
}

# Helper function to test redirect
test_redirect() {
    local short_code="$1"
    local max_redirects="${2:-0}"
    
    curl -s -w "%{http_code}:%{time_total}:%{redirect_url}" \
        -o /dev/null \
        --max-redirs "$max_redirects" \
        "$API_URL/$short_code"
}

# Helper function to get analytics
get_analytics() {
    local short_code="$1"
    
    curl -s "$API_URL/api/analytics/$short_code" | jq '.success' 2>/dev/null || echo "false"
}

case $TEST_TYPE in
    "basic"|"smoke")
        echo -e "${BLUE}🧪 Running basic smoke tests...${NC}"
        
        # Health check
        echo "1. Health check..."
        health_response=$(curl -s "$API_URL/api/health" | jq -r '.status' 2>/dev/null || echo "error")
        if [[ "$health_response" == "healthy" ]]; then
            echo -e "   ${GREEN}✅ Health check passed${NC}"
        else
            echo -e "   ${RED}❌ Health check failed${NC}"
            exit 1
        fi
        
        # Create a short link
        echo "2. Creating short link..."
        test_url="${TEST_URLS[0]}"
        short_code=$(create_link "$test_url")
        if [[ "$short_code" != "error" && -n "$short_code" ]]; then
            echo -e "   ${GREEN}✅ Link created: $short_code${NC}"
        else
            echo -e "   ${RED}❌ Failed to create link${NC}"
            exit 1
        fi
        
        # Test redirect
        echo "3. Testing redirect..."
        redirect_result=$(test_redirect "$short_code")
        status_code=$(echo "$redirect_result" | cut -d: -f1)
        response_time=$(echo "$redirect_result" | cut -d: -f2)
        redirect_url=$(echo "$redirect_result" | cut -d: -f3)
        
        if [[ "$status_code" == "301" ]]; then
            echo -e "   ${GREEN}✅ Redirect successful (${response_time}s to $redirect_url)${NC}"
        else
            echo -e "   ${RED}❌ Redirect failed (status: $status_code)${NC}"
            exit 1
        fi
        
        # Test analytics
        echo "4. Testing analytics..."
        sleep 2 # Wait for analytics to be processed
        analytics_success=$(get_analytics "$short_code")
        if [[ "$analytics_success" == "true" ]]; then
            echo -e "   ${GREEN}✅ Analytics working${NC}"
        else
            echo -e "   ${YELLOW}⚠️  Analytics may not be ready yet${NC}"
        fi
        
        echo -e "\n${GREEN}🎉 Basic smoke tests completed successfully!${NC}"
        ;;

    "performance"|"perf")
        echo -e "${BLUE}🏃 Running performance tests...${NC}"
        
        # Create multiple links for testing
        echo "Creating test links..."
        SHORT_CODES=()
        for i in "${!TEST_URLS[@]}"; do
            short_code=$(create_link "${TEST_URLS[$i]}" "perf-test-$i")
            if [[ "$short_code" != "error" ]]; then
                SHORT_CODES+=("$short_code")
                echo "  Created: $short_code"
            fi
        done
        
        if [[ ${#SHORT_CODES[@]} -eq 0 ]]; then
            echo -e "${RED}❌ No test links created${NC}"
            exit 1
        fi
        
        # Performance test - sequential redirects
        echo -e "\nTesting redirect performance (sequential)..."
        total_time=0
        success_count=0
        
        for i in {1..50}; do
            short_code="${SHORT_CODES[$((i % ${#SHORT_CODES[@]}))]}"
            redirect_result=$(test_redirect "$short_code")
            status_code=$(echo "$redirect_result" | cut -d: -f1)
            response_time=$(echo "$redirect_result" | cut -d: -f2)
            
            if [[ "$status_code" == "301" ]]; then
                success_count=$((success_count + 1))
                total_time=$(echo "$total_time + $response_time" | bc -l)
                echo -n "."
            else
                echo -n "x"
            fi
        done
        
        echo ""
        avg_time=$(echo "scale=3; $total_time / $success_count" | bc -l)
        success_rate=$(echo "scale=1; $success_count / 50 * 100" | bc -l)
        
        echo "Results:"
        echo "  Success Rate: ${success_rate}%"
        echo "  Average Response Time: ${avg_time}s"
        
        if (( $(echo "$avg_time < 0.1" | bc -l) )); then
            echo -e "  ${GREEN}✅ Excellent performance (<100ms)${NC}"
        elif (( $(echo "$avg_time < 0.5" | bc -l) )); then
            echo -e "  ${GREEN}✅ Good performance (<500ms)${NC}"
        elif (( $(echo "$avg_time < 1.0" | bc -l) )); then
            echo -e "  ${YELLOW}⚠️  Acceptable performance (<1s)${NC}"
        else
            echo -e "  ${RED}❌ Slow performance (>1s)${NC}"
        fi
        ;;

    "stress")
        if ! command -v ab &> /dev/null; then
            echo -e "${RED}❌ Apache Bench (ab) is required for stress testing${NC}"
            echo "Install with: brew install httpie (macOS) or apt-get install apache2-utils (Ubuntu)"
            exit 1
        fi
        
        echo -e "${BLUE}💪 Running stress tests...${NC}"
        echo -e "${YELLOW}⚠️  This will generate significant load on the API${NC}"
        
        if [[ "$ENVIRONMENT" == "prod" ]]; then
            read -p "Are you sure you want to run stress tests against production? (yes/no): " -r
            if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
                echo "Stress test cancelled"
                exit 0
            fi
        fi
        
        # Create a test link first
        test_url="${TEST_URLS[0]}"
        short_code=$(create_link "$test_url" "stress-test")
        if [[ "$short_code" == "error" ]]; then
            echo -e "${RED}❌ Failed to create test link${NC}"
            exit 1
        fi
        
        echo "Created test link: $short_code"
        echo "Starting stress test..."
        
        # Stress test with Apache Bench
        ab -n 1000 -c 10 -g stress-test-results.tsv "$API_URL/$short_code" > stress-test-output.txt
        
        echo "Stress test completed. Results:"
        grep -A 20 "Server Software" stress-test-output.txt | grep -E "(Requests per second|Time per request|Transfer rate)"
        
        echo -e "\nDetailed results saved to:"
        echo "  - stress-test-output.txt"
        echo "  - stress-test-results.tsv"
        ;;

    "concurrent"|"concurrency")
        echo -e "${BLUE}⚡ Running concurrency tests...${NC}"
        
        # Create test links
        SHORT_CODES=()
        for i in "${!TEST_URLS[@]}"; do
            short_code=$(create_link "${TEST_URLS[$i]}" "concurrent-$i")
            if [[ "$short_code" != "error" ]]; then
                SHORT_CODES+=("$short_code")
            fi
        done
        
        # Function to test redirects in background
        test_concurrent_redirects() {
            local worker_id="$1"
            local requests_per_worker="$2"
            local results_file="concurrent_results_${worker_id}.txt"
            
            for ((i=1; i<=requests_per_worker; i++)); do
                short_code="${SHORT_CODES[$((i % ${#SHORT_CODES[@]}))]}"
                redirect_result=$(test_redirect "$short_code")
                status_code=$(echo "$redirect_result" | cut -d: -f1)
                response_time=$(echo "$redirect_result" | cut -d: -f2)
                echo "$worker_id,$i,$status_code,$response_time" >> "$results_file"
            done
        }
        
        # Start concurrent workers
        WORKERS=5
        REQUESTS_PER_WORKER=20
        TOTAL_REQUESTS=$((WORKERS * REQUESTS_PER_WORKER))
        
        echo "Starting $WORKERS concurrent workers, $REQUESTS_PER_WORKER requests each..."
        start_time=$(date +%s)
        
        for ((w=1; w<=WORKERS; w++)); do
            test_concurrent_redirects "$w" "$REQUESTS_PER_WORKER" &
        done
        
        # Wait for all background jobs to complete
        wait
        
        end_time=$(date +%s)
        total_time=$((end_time - start_time))
        
        # Analyze results
        echo "Analyzing results..."
        cat concurrent_results_*.txt > all_concurrent_results.txt
        
        success_count=$(awk -F, '$3==301' all_concurrent_results.txt | wc -l)
        avg_response_time=$(awk -F, '$3==301 {sum+=$4; count++} END {print sum/count}' all_concurrent_results.txt)
        
        echo "Concurrency Test Results:"
        echo "  Total Requests: $TOTAL_REQUESTS"
        echo "  Successful Requests: $success_count"
        echo "  Success Rate: $(echo "scale=1; $success_count * 100 / $TOTAL_REQUESTS" | bc -l)%"
        echo "  Total Time: ${total_time}s"
        echo "  Requests/Second: $(echo "scale=1; $TOTAL_REQUESTS / $total_time" | bc -l)"
        echo "  Average Response Time: ${avg_response_time}s"
        
        # Cleanup
        rm -f concurrent_results_*.txt all_concurrent_results.txt
        ;;

    "analytics"|"analytics-test")
        echo -e "${BLUE}📊 Running analytics tests...${NC}"
        
        # Create a test link
        test_url="${TEST_URLS[0]}"
        short_code=$(create_link "$test_url" "analytics-test")
        
        if [[ "$short_code" == "error" ]]; then
            echo -e "${RED}❌ Failed to create test link${NC}"
            exit 1
        fi
        
        echo "Created test link: $short_code"
        
        # Generate some clicks with different user agents
        USER_AGENTS=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"
            "Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15"
            "Mozilla/5.0 (Android 11; Mobile; rv:89.0) Gecko/89.0 Firefox/89.0"
        )
        
        REFERERS=(
            "https://google.com/search?q=test"
            "https://twitter.com"
            "https://facebook.com"
            "direct"
            "https://linkedin.com"
        )
        
        echo "Generating test clicks..."
        for i in {1..25}; do
            ua="${USER_AGENTS[$((i % ${#USER_AGENTS[@]}))]}"
            ref="${REFERERS[$((i % ${#REFERERS[@]}))]}"
            
            if [[ "$ref" != "direct" ]]; then
                curl -s -H "User-Agent: $ua" -H "Referer: $ref" "$API_URL/$short_code" > /dev/null
            else
                curl -s -H "User-Agent: $ua" "$API_URL/$short_code" > /dev/null
            fi
            
            sleep 0.1 # Small delay to avoid overwhelming the system
            echo -n "."
        done
        
        echo ""
        echo "Waiting for analytics to process..."
        sleep 5
        
        # Test analytics endpoints
        echo "Testing analytics API..."
        analytics_response=$(curl -s "$API_URL/api/analytics/$short_code")
        
        if echo "$analytics_response" | jq -e '.success' > /dev/null 2>&1; then
            total_clicks=$(echo "$analytics_response" | jq -r '.data.totalClicks')
            unique_clicks=$(echo "$analytics_response" | jq -r '.data.uniqueClicks')
            
            echo "Analytics Results:"
            echo "  Total Clicks: $total_clicks"
            echo "  Unique Clicks: $unique_clicks"
            echo "  Referrers: $(echo "$analytics_response" | jq -r '.data.referrers | length')"
            echo "  Browsers: $(echo "$analytics_response" | jq -r '.data.browsers | length')"
            
            echo -e "${GREEN}✅ Analytics test completed successfully${NC}"
        else
            echo -e "${RED}❌ Analytics test failed${NC}"
            echo "Response: $analytics_response"
        fi
        ;;

    "help"|*)
        echo "Available test types:"
        echo "  basic, smoke      - Basic functionality tests"
        echo "  performance, perf - Performance testing"
        echo "  stress           - Stress testing with Apache Bench"
        echo "  concurrent       - Concurrency testing"
        echo "  analytics        - Analytics functionality tests"
        echo "  help             - Show this help"
        echo ""
        echo "Usage: ./scripts/load-test.sh [environment] [test-type]"
        echo "Example: ./scripts/load-test.sh dev performance"
        ;;
esac

echo -e "\n${GREEN}✅ Load testing completed${NC}"