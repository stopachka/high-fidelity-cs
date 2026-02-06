// Initialize the database

import { init } from "@instantdb/core";
import schema from "../instant.schema";

const appId = import.meta.env.VITE_INSTANT_APP_ID;

if (!appId) {
  throw new Error("Missing VITE_INSTANT_APP_ID in environment");
}

// ---------
export const db = init({
  appId,
  schema,
  useDateObjects: true,
});
