// Vitest-only stub for react-native-url-polyfill/auto.
// The real module imports `react-native` (Platform) to decide whether to
// install a URL polyfill, which Vitest's Node environment cannot parse.
// Node already has a spec-compliant URL global, so this is a safe no-op.
export {};
