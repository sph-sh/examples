module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  
  // Test file patterns for integration tests
  testMatch: [
    '<rootDir>/tests/integration/**/*.test.ts',
    '<rootDir>/tests/integration/**/*.spec.ts',
  ],
  
  // Setup files
  setupFilesAfterEnv: ['<rootDir>/tests/integration/setup.ts'],
  
  // Environment variables
  setupFiles: ['<rootDir>/tests/env.ts'],
  
  // Longer timeout for integration tests
  testTimeout: 30000,
  
  // Sequential execution for integration tests
  maxWorkers: 1,
  
  // Module resolution
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  
  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,
  
  // Verbose output for integration tests
  verbose: true,
  
  // Don't collect coverage for integration tests by default
  collectCoverage: false,
};