// Existing fixtures intentionally exercise the legacy path layout. Production
// tests for the global store use CONTEXT_BRIDGE_HOME and do not rely on this.
process.env.CONTEXT_BRIDGE_STORAGE = "project";
