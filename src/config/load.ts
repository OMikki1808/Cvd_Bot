import { config as loadDotenv } from "dotenv";
import type { AppConfig } from "./schema.js";
import { parseConfig } from "./schema.js";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotenv();
  return parseConfig(env);
}
