import { APIGatewayAuthorizerResult, APIGatewayTokenAuthorizerEvent } from 'aws-lambda';
import * as jwt from 'jsonwebtoken';

// JWT payload interface
interface JWTPayload {
  sub: string; // User ID
  email: string;
  role: 'admin' | 'user' | 'premium';
  iat: number;
  exp: number;
}

// Policy statement interface
interface PolicyStatement {
  Effect: 'Allow' | 'Deny';
  Action: string;
  Resource: string;
}

export const handler = async (
  event: APIGatewayTokenAuthorizerEvent
): Promise<APIGatewayAuthorizerResult> => {
  console.log('Auth event:', JSON.stringify(event, null, 2));

  try {
    // Extract token from Authorization header
    const token = extractToken(event.authorizationToken);
    if (!token) {
      throw new Error('No token provided');
    }

    // Verify JWT token
    const decoded = await verifyToken(token);
    if (!decoded) {
      throw new Error('Invalid token');
    }

    console.log('Token verified for user:', decoded.sub);

    // Generate IAM policy based on user role and request
    const policy = generatePolicy(decoded, event.methodArn);
    
    return {
      principalId: decoded.sub,
      policyDocument: policy,
      context: {
        userId: decoded.sub,
        email: decoded.email,
        role: decoded.role,
        // Add any additional context you need in your Lambda functions
      },
    };

  } catch (error) {
    console.error('Authorization failed:', error);
    
    // Return explicit deny policy
    throw new Error('Unauthorized');
  }
};

/**
 * Extract JWT token from Authorization header
 */
function extractToken(authorizationToken: string): string | null {
  if (!authorizationToken) {
    return null;
  }

  // Handle both "Bearer token" and "token" formats
  const parts = authorizationToken.split(' ');
  
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return parts[1];
  } else if (parts.length === 1) {
    return parts[0];
  }
  
  return null;
}

/**
 * Verify JWT token
 */
async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('JWT_SECRET not configured');
    }

    // Verify token signature and expiration
    const decoded = jwt.verify(token, jwtSecret, {
      algorithms: ['HS256'],
      issuer: process.env.JWT_ISSUER || 'link-shortener',
      audience: process.env.JWT_AUDIENCE || 'link-shortener-api',
    }) as JWTPayload;

    // Additional validation
    if (!decoded.sub || !decoded.email || !decoded.role) {
      throw new Error('Invalid token payload');
    }

    // Check if user is active (in production, query user database)
    const isUserActive = await checkUserStatus(decoded.sub);
    if (!isUserActive) {
      throw new Error('User account is inactive');
    }

    return decoded;
  } catch (error) {
    console.error('Token verification failed:', error);
    return null;
  }
}

/**
 * Check user status (placeholder - implement with your user database)
 */
async function checkUserStatus(userId: string): Promise<boolean> {
  // In production, check user status in DynamoDB or other database
  // For now, assume all users are active
  return true;
}

/**
 * Generate IAM policy based on user role and request
 */
function generatePolicy(
  user: JWTPayload, 
  methodArn: string
): {
  Version: string;
  Statement: PolicyStatement[];
} {
  const apiGatewayArn = methodArn.split('/', 4).join('/');
  
  const statements: PolicyStatement[] = [];

  // Base permissions for all authenticated users
  statements.push({
    Effect: 'Allow',
    Action: 'execute-api:Invoke',
    Resource: `${apiGatewayArn}/*/GET/api/health`, // Health check
  });

  // Role-based permissions
  switch (user.role) {
    case 'admin':
      // Admin can access everything
      statements.push({
        Effect: 'Allow',
        Action: 'execute-api:Invoke',
        Resource: `${apiGatewayArn}/*/*`, // All methods and resources
      });
      break;

    case 'premium':
      // Premium users can create links, access analytics, and bulk operations
      statements.push(
        {
          Effect: 'Allow',
          Action: 'execute-api:Invoke',
          Resource: `${apiGatewayArn}/*/POST/api/shorten`, // Create links
        },
        {
          Effect: 'Allow',
          Action: 'execute-api:Invoke',
          Resource: `${apiGatewayArn}/*/POST/api/bulk`, // Bulk operations
        },
        {
          Effect: 'Allow',
          Action: 'execute-api:Invoke',
          Resource: `${apiGatewayArn}/*/GET/api/analytics/*`, // Analytics
        },
        {
          Effect: 'Allow',
          Action: 'execute-api:Invoke',
          Resource: `${apiGatewayArn}/*/GET/*`, // Redirects
        }
      );
      break;

    case 'user':
      // Basic users can only create links and access redirects
      statements.push(
        {
          Effect: 'Allow',
          Action: 'execute-api:Invoke',
          Resource: `${apiGatewayArn}/*/POST/api/shorten`, // Create links
        },
        {
          Effect: 'Allow',
          Action: 'execute-api:Invoke',
          Resource: `${apiGatewayArn}/*/GET/*`, // Redirects (but not analytics)
        }
      );
      
      // Deny analytics for basic users
      statements.push({
        Effect: 'Deny',
        Action: 'execute-api:Invoke',
        Resource: `${apiGatewayArn}/*/GET/api/analytics/*`,
      });
      break;

    default:
      // Unknown role - deny everything
      statements.push({
        Effect: 'Deny',
        Action: 'execute-api:Invoke',
        Resource: `${apiGatewayArn}/*/*`,
      });
  }

  return {
    Version: '2012-10-17',
    Statement: statements,
  };
}

/**
 * Utility function to create JWT token (for testing/admin purposes)
 */
export const createToken = (payload: Omit<JWTPayload, 'iat' | 'exp'>): string => {
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('JWT_SECRET not configured');
  }

  return jwt.sign(
    {
      ...payload,
      iat: Math.floor(Date.now() / 1000),
    },
    jwtSecret,
    {
      algorithm: 'HS256',
      expiresIn: '24h',
      issuer: process.env.JWT_ISSUER || 'link-shortener',
      audience: process.env.JWT_AUDIENCE || 'link-shortener-api',
    }
  );
};