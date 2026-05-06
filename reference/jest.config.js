const { stratoPreset } = require('@dynatrace/strato-components-testing/jest/preset');

/** @type {import('jest').Config} */
module.exports = {
  projects: [
    // Project 1: Pure TypeScript utility/logic tests — no DOM, no Strato
    {
      displayName: 'utils',
      preset: 'ts-jest',
      testEnvironment: 'node',
      roots: ['<rootDir>/ui'],
      testMatch: ['<rootDir>/ui/app/utils/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, tsconfig: '<rootDir>/ui/tsconfig.json' }],
      },
    },
    // Project 2: React component tests — jsdom, full Strato preset
    {
      displayName: 'ui',
      preset: 'ts-jest',
      testEnvironment: 'jsdom',
      roots: ['<rootDir>/ui'],
      testMatch: ['<rootDir>/ui/**/*.test.tsx', '<rootDir>/ui/app/hooks/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { isolatedModules: true, tsconfig: '<rootDir>/ui/tsconfig.json' }],
      },
      setupFilesAfterEnv: [
        '@dynatrace/strato-components-testing/jest/setup',
        '<rootDir>/ui/jest-setup.ts',
      ],
      setupFiles: [
        '@dynatrace-sdk/navigation/testing',
        '@dynatrace-sdk/user-preferences/testing',
        '@dynatrace-sdk/app-environment/testing',
      ],
      moduleNameMapper: {
        ...stratoPreset.moduleNameMapper,
      },
      resolver: stratoPreset.resolver,
    },
  ],
};
