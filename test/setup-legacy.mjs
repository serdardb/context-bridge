// Temporary migration runner. Remove once all fixtures use production storage.
import "./setup.mjs";
process.env.CONTEXT_BRIDGE_STORAGE = "project";
