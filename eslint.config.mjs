import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Guardrail: firebase/database and firebase/auth must only be touched by
  // the sync/ abstraction (see src/lib/sync/backend.ts) so the LAN host
  // mode and the Firebase-backed Vercel deployment can never drift apart.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/firebase.ts",
      "src/lib/sync/firebaseBackend.ts",
      "src/lib/sync/firebaseAuth.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "firebase/database",
              message: "firebase/databaseを直接importせず、@/lib/sync/backendのbackendを使ってください。",
            },
            {
              name: "firebase/auth",
              message: "firebase/authを直接importせず、@/lib/sync/backendのauthBackendを使ってください。",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
