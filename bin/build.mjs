#!/usr/bin/env node
import { buildPlugin } from "../src/build.mjs";
const inferred = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const source = process.argv[2] || process.env.BUZZ_GATEWAY_PUBLIC_ORIGIN ||
  (process.env.BUZZ_GATEWAY_ENROLLMENT && JSON.parse(process.env.BUZZ_GATEWAY_ENROLLMENT).origin) ||
  (inferred && "https://" + inferred);
if (!source) throw new Error("Specify the gateway HTTPS origin or set BUZZ_GATEWAY_PUBLIC_ORIGIN");
const identity = process.env.BUZZ_GATEWAY_DESKTOP_IDENTITY && JSON.parse(process.env.BUZZ_GATEWAY_DESKTOP_IDENTITY);
const release = await buildPlugin({ origin: source, identity, directory: process.argv[3], folder: process.argv[4] });
console.log("Built Buzz plugin " + release.sha256);
