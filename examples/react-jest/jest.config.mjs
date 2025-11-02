const config = {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'jsdom',
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  testMatch: ['**/__tests__/**/*.[tj]s?(x)', '**/?(*.)+(spec|test).[tj]s?(x)'],
  moduleNameMapper: {
    '^.+\\.(css|less|sass|scss)$': 'identity-obj-proxy',
    '^.+\\.(svg|png|jpe?g|gif|webp|avif)$': '<rootDir>/__mocks__/fileMock.ts',
    '^/.*\\.(svg|png|jpe?g|gif|webp|avif)$': '<rootDir>/__mocks__/fileMock.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: './tsconfig.spec.json',
        diagnostics: false
      }
    ]
  }
}

export default config
