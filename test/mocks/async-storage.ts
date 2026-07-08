// Vitest-only stub for @react-native-async-storage/async-storage.
// The real package pulls in the react-native package (Flow syntax, RN-only
// bindings) which Vitest's Node environment cannot parse/run. Pure-logic
// tests never touch storage, so a no-op stand-in is sufficient here.
export default {
  getItem: async () => null,
  setItem: async () => {},
  removeItem: async () => {},
};
