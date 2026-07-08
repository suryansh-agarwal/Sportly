/// <reference types="nativewind/types" />

// TS 6 + "moduleResolution": "bundler" require an explicit ambient module
// declaration for side-effect CSS imports (e.g. `import '../global.css'`);
// nativewind/react-native-css-interop don't ship one yet.
declare module '*.css';
